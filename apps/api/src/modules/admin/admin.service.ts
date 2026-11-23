import type { Prisma } from "@prisma/client";
import { endOfDayUtc, startOfDayUtc } from "@waitless/shared";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { getQueue, QUEUE_NAMES, type QueueName } from "../../jobs/schedulers";
import { AppError } from "../../utils/errors";
import type { AuditQuery } from "./admin.schema";

const EMPTY_COUNTS = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };

/** Counts reported for a queue when Redis cannot be reached. */
export type QueueCounts = typeof EMPTY_COUNTS;

/** Compact view of a recently failed BullMQ job (no payloads or stack traces). */
export interface FailedJobSummary {
  id: string | null;
  name: string;
  failedReason: string | null;
  timestamp: number;
}

/** Read-only status for one BullMQ queue. */
export interface QueueStatus {
  name: QueueName;
  available: boolean;
  counts: QueueCounts;
  failedJobs: FailedJobSummary[];
}

/**
 * Audit trail with the acting user's name resolved in the same query. The
 * effective filters are echoed back so the admin UI can restore its state.
 */
export async function listAuditLogs(query: AuditQuery) {
  if (query.from && query.to && query.from > query.to) {
    throw AppError.badRequest("'from' must be on or before 'to'");
  }

  const where: Prisma.AuditLogWhereInput = {};
  if (query.entity) where.entity = query.entity;
  if (query.action) where.action = query.action;
  if (query.actorUserId) where.actorUserId = query.actorUserId;
  if (query.from || query.to) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.from) createdAt.gte = startOfDayUtc(query.from, env.HOSPITAL_TIMEZONE);
    if (query.to) createdAt.lte = endOfDayUtc(query.to, env.HOSPITAL_TIMEZONE);
    where.createdAt = createdAt;
  }

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      actorUserId: row.actorUserId,
      actorName: row.actor?.name ?? null,
      actor: row.actor ? { name: row.actor.name } : null,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      before: row.before,
      after: row.after,
      ip: row.ip,
      createdAt: row.createdAt,
    })),
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
    filters: {
      entity: query.entity ?? null,
      action: query.action ?? null,
      actorUserId: query.actorUserId ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
    },
  };
}

/**
 * Ops visibility over every BullMQ queue. A Redis failure for one queue only
 * marks that queue unavailable; the dashboard never receives a 5xx from this
 * endpoint.
 */
export async function getJobsOverview(): Promise<{ queues: QueueStatus[]; generatedAt: string }> {
  const queues = await Promise.all(
    Object.values(QUEUE_NAMES).map(async (name): Promise<QueueStatus> => {
      try {
        const queue = getQueue(name);
        const [counts, failed] = await Promise.all([
          queue.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
          queue.getFailed(0, 9),
        ]);
        return {
          name,
          available: true,
          counts: {
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            completed: counts.completed ?? 0,
            failed: counts.failed ?? 0,
            delayed: counts.delayed ?? 0,
          },
          failedJobs: failed.map(
            (job): FailedJobSummary => ({
              id: job.id ?? null,
              name: job.name,
              failedReason: job.failedReason ?? null,
              timestamp: job.timestamp,
            }),
          ),
        };
      } catch {
        return { name, available: false, counts: { ...EMPTY_COUNTS }, failedJobs: [] };
      }
    }),
  );

  return { queues, generatedAt: new Date().toISOString() };
}
