import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";
import { env } from "../config/env";

/** Unit/integration tests must not be throttled by shared in-memory counters. */
const skipTests = () => env.NODE_ENV === "test";

function keyWithIdentifier(req: Request): string {
  const ip = ipKeyGenerator(req.ip ?? "");
  const body = req.body as { identifier?: unknown; phone?: unknown } | undefined;
  const identifier =
    typeof body?.identifier === "string"
      ? body.identifier.toLowerCase().trim()
      : typeof body?.phone === "string"
        ? body.phone
        : "";
  return identifier ? `${ip}:${identifier}` : ip;
}

export const loginRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: keyWithIdentifier,
  skip: skipTests,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many sign-in attempts. Please wait a minute and try again.",
    },
  },
});

export const patientSessionRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: skipTests,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many attempts. Please wait a moment and try again.",
    },
  },
});

/** Coarse ceiling for all API traffic; health checks are exempt. */
export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: (req) => skipTests() || req.originalUrl.startsWith("/api/v1/health"),
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  message: {
    error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." },
  },
});

/** Stricter ceiling for state-changing requests. */
export const writeRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: (req) => skipTests() || !["POST", "PATCH", "PUT", "DELETE"].includes(req.method),
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  message: {
    error: { code: "RATE_LIMITED", message: "Too many write requests. Please slow down." },
  },
});

/** Device gateways may publish frequently; keep a generous but bounded ceiling. */
export const hardwareEventRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: skipTests,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  message: {
    error: { code: "RATE_LIMITED", message: "Device event rate limit exceeded." },
  },
});
