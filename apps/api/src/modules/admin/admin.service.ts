import type { Prisma } from "@prisma/client";
import { addDaysToDayKey, zonedDateTimeToUtc } from "@waitless/shared";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";

export async function listAuditLogs(query: {
  action?: string;
  entity?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}) {
  const where: Prisma.AuditLogWhereInput = {};
  if (query.action) where.action = query.action as Prisma.AuditLogWhereInput["action"];
  if (query.entity) where.entity = query.entity;
  if (query.actorUserId) where.actorUserId = query.actorUserId;
  if (query.from || query.to) {
    where.createdAt = {};
    if (query.from) {
      where.createdAt.gte = zonedDateTimeToUtc(query.from, 0, env.HOSPITAL_TIMEZONE);
    }
    if (query.to) {
      const dayAfter = zonedDateTimeToUtc(addDaysToDayKey(query.to, 1), 0, env.HOSPITAL_TIMEZONE);
      where.createdAt.lt = dayAfter;
    }
  }

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { id: true, name: true, email: true, role: true } } },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    auditLogs: items,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
  };
}

/** Operations snapshot for the read-only jobs panel. */
export async function getJobStatus() {
  const [scheduledNotifications, pendingSwaps, calledEntries, delayedEntries] = await Promise.all([
    prisma.notification.count({ where: { status: "SCHEDULED" } }),
    prisma.swapRequest.count({ where: { status: "PENDING" } }),
    prisma.queueEntry.count({ where: { status: "CALLED" } }),
    prisma.queueEntry.count({ where: { status: "DELAYED" } }),
  ]);

  return {
    scheduler: {
      enabled: env.JOBS_ENABLED,
      intervalMs: env.SCHEDULER_INTERVAL_MS,
      staleRoomMinutes: env.STALE_ROOM_MINUTES,
    },
    queue: {
      scheduledNotifications,
      pendingSwaps,
      calledEntries,
      delayedEntries,
    },
  };
}
