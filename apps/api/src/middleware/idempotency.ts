import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { logger } from "../config/logger";
import { redis } from "../config/redis";
import { AppError } from "../utils/errors";

/**
 * Replay-safe writes for client-retried POSTs.
 *
 * Clients send `Idempotency-Key` (or `X-Idempotency-Key`) on appointment and
 * swap creation. Redis holds a 24-hour record containing a fingerprint of the
 * caller, route and body. A repeated key with the same fingerprint replays the
 * original response; a different fingerprint is rejected so one caller cannot
 * read another caller's result. Redis outages fail open rather than breaking
 * writes — BullMQ already requires Redis for the durable parts of the system.
 */

const PREFIX = "waitless:idempotency:";
const TTL_SECONDS = 24 * 60 * 60;
const POLL_INTERVAL_MS = 50;
const WAIT_TIMEOUT_MS = 10_000;

const PROTECTED_PATHS = new Set(["/api/v1/appointments", "/api/v1/swaps"]);

interface IdempotencyRecord {
  fingerprint: string;
  status: "IN_PROGRESS" | "DONE";
  statusCode?: number;
  body?: unknown;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintFor(req: Request, key: string): string {
  const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  return sha256(
    JSON.stringify({
      key,
      method: req.method,
      path: req.path,
      query: req.query,
      body: req.body ?? null,
      caller: sha256(auth),
    }),
  );
}

function parseRecord(raw: string | null): IdempotencyRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "fingerprint" in parsed &&
      typeof (parsed as IdempotencyRecord).fingerprint === "string" &&
      "status" in parsed
    ) {
      return parsed as IdempotencyRecord;
    }
  } catch {
    logger.warn("ignoring corrupt idempotency record");
  }
  return null;
}

function keyHeader(req: Request): string | null {
  const value = req.headers["idempotency-key"] ?? req.headers["x-idempotency-key"];
  const key = Array.isArray(value) ? value[0] : value;
  if (typeof key !== "string") return null;
  return /^[A-Za-z0-9._:-]{1,128}$/.test(key) ? key : null;
}

async function waitForRecord(key: string, fingerprint: string): Promise<IdempotencyRecord | null> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const record = parseRecord(await redis.get(key));
    if (!record) return null;
    if (record.fingerprint !== fingerprint) {
      throw AppError.conflict("CONFLICT", "Idempotency key belongs to a different request");
    }
    if (record.status === "DONE") return record;
  }
  return null;
}

export const idempotency: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "POST" || !PROTECTED_PATHS.has(req.path)) {
    next();
    return;
  }

  const key = keyHeader(req);
  if (!key) {
    next(AppError.badRequest("Provide a valid Idempotency-Key header (1–128 safe characters)"));
    return;
  }

  const redisKey = `${PREFIX}${key}`;
  const fingerprint = fingerprintFor(req, key);
  const claim = JSON.stringify({ fingerprint, status: "IN_PROGRESS" } satisfies IdempotencyRecord);

  try {
    const acquired = await redis.set(redisKey, claim, "EX", TTL_SECONDS, "NX");

    if (acquired !== "OK") {
      const existing = parseRecord(await redis.get(redisKey));
      if (existing && existing.fingerprint !== fingerprint) {
        next(AppError.conflict("CONFLICT", "Idempotency key belongs to a different request"));
        return;
      }
      const replay =
        existing?.status === "DONE"
          ? existing
          : await waitForRecord(redisKey, fingerprint);
      if (replay?.status === "DONE" && replay.statusCode !== undefined && replay.body !== undefined) {
        res.status(replay.statusCode).json(replay.body);
        return;
      }
      next(AppError.conflict("CONFLICT", "The original request is still in progress; retry shortly"));
      return;
    }

    let finished = false;
    const finalize = (statusCode: number, body: unknown) => {
      if (finished) return;
      finished = true;
      if (statusCode >= 200 && statusCode < 400) {
        let serialized: string;
        try {
          serialized = JSON.stringify({ fingerprint, status: "DONE", statusCode, body } satisfies IdempotencyRecord);
        } catch (error) {
          logger.error({ err: error }, "could not serialise idempotent response");
          void redis.del(redisKey).catch((err: unknown) => logger.error({ err }, "redis del failed"));
          return;
        }
        void redis
          .set(redisKey, serialized, "EX", TTL_SECONDS)
          .catch((error: unknown) => logger.error({ err: error }, "redis idempotency store failed"));
      } else {
        // Never cache failures: the caller is allowed to fix the request.
        void redis.del(redisKey).catch((error: unknown) => logger.error({ err: error }, "redis idempotency cleanup failed"));
      }
    };

    const originalJson = res.json;
    res.json = function (this: Response, body: unknown) {
      finalize(res.statusCode, body);
      return originalJson.call(this, body);
    } as Response["json"];

    res.once("finish", () => {
      if (!finished && res.statusCode >= 400) finalize(res.statusCode, null);
    });
    res.once("close", () => {
      if (!finished && !res.writableEnded) {
        finished = true;
        void redis.del(redisKey).catch((error: unknown) => logger.error({ err: error }, "redis idempotency cleanup failed"));
      }
    });

    next();
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }
    logger.error({ err: error }, "idempotency check failed; continuing without replay protection");
    next();
  }
};
