import { createHash } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { Role, User } from "@prisma/client";
import type { Request, Response } from "express";
import { env, isProd } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { redis } from "../../config/redis";
import { AppError } from "../../utils/errors";
import {
  hashToken,
  parseDurationToMs,
  refreshExpiryDate,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../utils/auth";
import { ERROR_CODES } from "@waitless/shared";

const REFRESH_COOKIE = "waitless_refresh";
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_SECONDS = 15 * 60;

/** Hashed so raw email/phone identifiers are never written into Redis keys. */
function loginKey(prefix: string, identifier: string): string {
  return `waitless:${prefix}:${createHash("sha256").update(identifier.toLowerCase().trim()).digest("hex")}`;
}

async function assertNotLocked(identifier: string): Promise<void> {
  if (env.NODE_ENV === "test") return;
  try {
    const locked = await redis.get(loginKey("login-lock", identifier));
    if (locked) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, "This account is temporarily locked. Try again in 15 minutes.");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.warn({ err: error }, "login lockout check unavailable");
  }
}

async function recordFailedLogin(identifier: string): Promise<void> {
  if (env.NODE_ENV === "test") return;
  try {
    const failures = await redis.incr(loginKey("login-fail", identifier));
    if (failures === 1) await redis.expire(loginKey("login-fail", identifier), LOGIN_LOCK_SECONDS);
    if (failures >= LOGIN_FAILURE_LIMIT) {
      await redis.set(loginKey("login-lock", identifier), "1", "EX", LOGIN_LOCK_SECONDS);
      await redis.del(loginKey("login-fail", identifier));
    }
  } catch (error) {
    logger.warn({ err: error }, "login failure counter unavailable");
  }
}

async function clearFailedLogins(identifier: string): Promise<void> {
  if (env.NODE_ENV === "test") return;
  try {
    await redis.del(loginKey("login-fail", identifier), loginKey("login-lock", identifier));
  } catch (error) {
    logger.warn({ err: error }, "login failure cleanup unavailable");
  }
}

export function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/api/v1",
    maxAge: parseDurationToMs(env.JWT_REFRESH_TTL),
  });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/api/v1",
  });
}

export function readRefreshCookie(req: Request): string | null {
  const value = req.cookies?.[REFRESH_COOKIE];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isStaffRole(role: Role) {
  return role === "ADMIN" || role === "STAFF";
}

export async function issueSession(
  user: Pick<User, "id" | "role"> & { patientId?: string | null },
  req: Request,
  res: Response,
) {
  const accessToken = signAccessToken({
    userId: user.id,
    role: user.role,
    patientId: user.patientId ?? null,
  });
  const { token: refreshToken, jti } = signRefreshToken({
    userId: user.id,
    role: user.role,
    patientId: user.patientId ?? null,
  });

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: refreshExpiryDate(),
      userAgent: req.get("user-agent")?.slice(0, 255),
      ip: req.ip,
    },
  });

  // jti available if we later want to store it; tokenHash is the lookup key.
  void jti;
  setRefreshCookie(res, refreshToken);

  return { accessToken };
}

export async function loginWithPassword(identifier: string, password: string, req: Request, res: Response) {
  const id = identifier.trim().toLowerCase();
  await assertNotLocked(id);

  const user = await prisma.user.findFirst({
    where: {
      OR: [{ email: id }, { email: identifier.trim() }, { phone: identifier.trim() }],
      role: { in: ["ADMIN", "STAFF"] },
    },
    include: { patient: true, adminProfile: true },
  });

  if (!user || !user.passwordHash || !isStaffRole(user.role)) {
    await recordFailedLogin(id);
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "Invalid email/phone or password");
  }
  if (!user.isActive) {
    throw new AppError(ERROR_CODES.ACCOUNT_DISABLED, "This account is disabled");
  }

  const ok = await verify(user.passwordHash, password);
  if (!ok) {
    await recordFailedLogin(id);
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "Invalid email/phone or password");
  }

  await clearFailedLogins(id);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const session = await issueSession({ id: user.id, role: user.role }, req, res);

  return {
    ...session,
    user: serializeUser(user),
  };
}

export async function refreshSession(req: Request, res: Response) {
  const token = readRefreshCookie(req);
  if (!token) throw AppError.unauthorized("No active session");

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    clearRefreshCookie(res);
    throw new AppError(ERROR_CODES.TOKEN_INVALID, "Session expired or invalid");
  }

  const tokenHash = hashToken(token);
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: { include: { patient: true, adminProfile: true } } } });
  if (!record || record.userId !== payload.sub) {
    clearRefreshCookie(res);
    throw new AppError(ERROR_CODES.TOKEN_INVALID, "Session expired or invalid");
  }
  if (record.revokedAt || record.expiresAt.getTime() <= Date.now()) {
    clearRefreshCookie(res);
    throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "Session expired");
  }
  if (!record.user.isActive) {
    clearRefreshCookie(res);
    throw new AppError(ERROR_CODES.ACCOUNT_DISABLED, "This account is disabled");
  }

  await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });

  const patientId = record.user.patient?.id ?? null;
  const session = await issueSession({ id: record.user.id, role: record.user.role, patientId }, req, res);
  return { ...session, user: serializeUser(record.user) };
}

export async function logoutSession(req: Request, res: Response) {
  const token = readRefreshCookie(req);
  if (token) {
    const tokenHash = hashToken(token);
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  clearRefreshCookie(res);
}

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { patient: true, adminProfile: true },
  });
  if (!user) throw AppError.notFound("User not found");
  return serializeUser(user);
}

export function serializeUser(user: User & { patient?: { id: string; fullName: string; phone: string; email: string | null; phoneVerified: boolean } | null; adminProfile?: { designation: string; staffCode: string } | null }) {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    phone: user.phone,
    isActive: user.isActive,
    patient: user.patient
      ? {
          id: user.patient.id,
          fullName: user.patient.fullName,
          phone: user.patient.phone,
          email: user.patient.email,
          phoneVerified: user.patient.phoneVerified,
        }
      : null,
    adminProfile: user.adminProfile
      ? { designation: user.adminProfile.designation, staffCode: user.adminProfile.staffCode }
      : null,
  };
}

export async function hashPassword(password: string) {
  return hash(password);
}
