import { toDayKey } from "@waitless/shared";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { prisma } from "../config/prisma";
import { notify, sendDueNotifications } from "../modules/notifications/notification.service";
import { socketEmitter } from "../sockets/emitter";

let timer: NodeJS.Timeout | null = null;
let running = false;

function todayKey() {
  return toDayKey(new Date(), env.HOSPITAL_TIMEZONE);
}

function minutesFromNow(minutes: number) {
  return new Date(Date.now() + minutes * 60_000);
}

/**
 * Database-driven scheduler.
 *
 * A sweep is preferred over one delayed job per queue entry because it survives
 * restarts and Redis flushes: every deadline is persisted on the row itself.
 */
export async function runSchedulerTick(now = new Date()): Promise<void> {
  await sendDueNotifications(now);
  await processGraceAndDelay(now);
  await processReadyAlerts(now);
  await expireSwaps(now);
  await autoCompleteFromHardware(now);
}

async function processGraceAndDelay(now: Date): Promise<void> {
  const called = await prisma.queueEntry.findMany({
    where: { status: "CALLED", graceDeadlineAt: { lte: now } },
    include: { appointment: { include: { patient: true, doctor: true } } },
    take: 50,
  });

  for (const entry of called) {
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.queueEntry.updateMany({
        where: { id: entry.id, status: "CALLED" },
        data: { status: "DELAYED", graceDeadlineAt: minutesFromNow(env.DELAY_MINUTES) },
      });
      if (changed.count !== 1) return null;
      await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "DELAYED" } });
      await tx.auditLog.create({
        data: {
          action: "QUEUE_DELAYED",
          entity: "QueueEntry",
          entityId: entry.id,
          before: { status: "CALLED" },
          after: { status: "DELAYED", graceDeadlineAt: minutesFromNow(env.DELAY_MINUTES).toISOString() },
        },
      });
      return tx.queueEntry.findUniqueOrThrow({ where: { id: entry.id } });
    });
    if (!updated) continue;

    await notify({
      patientId: entry.appointment.patientId,
      appointmentId: entry.appointmentId,
      type: "DELAY_WARNING",
      title: "We are holding your turn",
      body: `We called token #${entry.appointment.tokenNumber}, but you have not reached the room yet. Your turn is held for ${env.DELAY_MINUTES} more minutes.`,
      data: { queueEntryId: entry.id, graceDeadlineAt: minutesFromNow(env.DELAY_MINUTES).toISOString() },
      dedupeKey: `delay:${entry.id}:${Math.floor(now.getTime() / 60_000)}`,
    }).catch((error) => logger.error({ err: error }, "delay notification failed"));
    socketEmitter.queueUpdated(entry.doctorId, { doctorId: entry.doctorId, serviceDay: entry.serviceDay });
    socketEmitter.appointmentUpdated(entry.appointment.patientId, {
      appointmentId: entry.appointmentId,
      status: "DELAYED",
    });
  }

  if (!env.AUTO_SKIP_ENABLED) return;

  const delayed = await prisma.queueEntry.findMany({
    where: { status: "DELAYED", graceDeadlineAt: { lte: now } },
    include: { appointment: { include: { patient: true } } },
    take: 50,
  });

  for (const entry of delayed) {
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.queueEntry.updateMany({
        where: { id: entry.id, status: "DELAYED" },
        data: { status: "SKIPPED", skippedReason: "Grace period expired" },
      });
      if (changed.count !== 1) return null;
      await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "SKIPPED" } });
      await tx.auditLog.create({
        data: {
          action: "QUEUE_SKIPPED",
          entity: "QueueEntry",
          entityId: entry.id,
          before: { status: "DELAYED" },
          after: { status: "SKIPPED", reason: "Grace period expired" },
        },
      });
      return tx.queueEntry.findUniqueOrThrow({ where: { id: entry.id } });
    });
    if (!updated) continue;

    await notify({
      patientId: entry.appointment.patientId,
      appointmentId: entry.appointmentId,
      type: "SKIPPED",
      title: "Your turn was skipped",
      body: `Token #${entry.appointment.tokenNumber} was skipped after the grace period. Please contact the front desk to be requeued.`,
      data: { queueEntryId: entry.id },
      dedupeKey: `skipped:${entry.id}`,
    }).catch((error) => logger.error({ err: error }, "skip notification failed"));
    socketEmitter.queueUpdated(entry.doctorId, { doctorId: entry.doctorId, serviceDay: entry.serviceDay });
    socketEmitter.appointmentUpdated(entry.appointment.patientId, {
      appointmentId: entry.appointmentId,
      status: "SKIPPED",
    });
  }
}

async function processReadyAlerts(now: Date): Promise<void> {
  const candidates = await prisma.queueEntry.findMany({
    where: {
      serviceDay: todayKey(),
      status: { in: ["BOOKED", "WAITING", "NOTIFIED"] },
      notifiedAt: null,
      estimatedStartAt: {
        gte: new Date(now.getTime() - 15 * 60_000),
        lte: new Date(now.getTime() + env.READY_ALERT_MINUTES * 60_000),
      },
    },
    include: { appointment: { include: { patient: true } } },
    take: 50,
  });

  for (const entry of candidates) {
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.queueEntry.updateMany({
        where: { id: entry.id, notifiedAt: null },
        data: { status: "NOTIFIED", notifiedAt: now },
      });
      if (changed.count !== 1) return null;
      if (entry.appointment.status === "BOOKED" || entry.appointment.status === "WAITING") {
        await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "NOTIFIED" } });
      }
      return tx.queueEntry.findUniqueOrThrow({ where: { id: entry.id } });
    });
    if (!updated) continue;

    const minutesAway = entry.estimatedStartAt
      ? Math.max(0, Math.round((entry.estimatedStartAt.getTime() - now.getTime()) / 60_000))
      : env.READY_ALERT_MINUTES;
    await notify({
      patientId: entry.appointment.patientId,
      appointmentId: entry.appointmentId,
      type: "READY_30_MIN",
      title: "You are almost up",
      body: `Token #${entry.appointment.tokenNumber} is about ${minutesAway} minutes away. Please reach the hospital desk.`,
      data: { queueEntryId: entry.id, estimatedStartAt: entry.estimatedStartAt?.toISOString() ?? null },
      dedupeKey: `ready30:${entry.appointmentId}`,
    }).catch((error) => logger.error({ err: error }, "ready notification failed"));
    socketEmitter.queueUpdated(entry.doctorId, { doctorId: entry.doctorId, serviceDay: entry.serviceDay });
    socketEmitter.appointmentUpdated(entry.appointment.patientId, {
      appointmentId: entry.appointmentId,
      status: "NOTIFIED",
    });
  }
}

async function expireSwaps(now: Date): Promise<void> {
  const expired = await prisma.swapRequest.findMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    include: { requesterPatient: true, targetPatient: true },
    take: 50,
  });

  for (const swap of expired) {
    const changed = await prisma.swapRequest.updateMany({
      where: { id: swap.id, status: "PENDING" },
      data: { status: "EXPIRED", respondedAt: now },
    });
    if (changed.count !== 1) continue;

    await prisma.auditLog.create({
      data: {
        action: "SWAP_EXPIRED",
        entity: "SwapRequest",
        entityId: swap.id,
        before: { status: "PENDING" },
        after: { status: "EXPIRED" },
      },
    });

    for (const patient of [swap.requesterPatient, swap.targetPatient]) {
      await notify({
        patientId: patient.id,
        type: "SWAP_EXPIRED",
        title: "Swap request expired",
        body: "The swap request expired before both patients responded. Your original appointment is unchanged.",
        data: { swapRequestId: swap.id },
        dedupeKey: `swap-expired:${swap.id}:${patient.id}`,
      }).catch((error) => logger.error({ err: error }, "swap expiry notification failed"));
    }
  }
}

/**
 * Hardware vacancy is a hint. When auto-complete is enabled the vacancy must
 * persist for AUTO_COMPLETE_DEBOUNCE_MINUTES before the consultation closes.
 */
async function autoCompleteFromHardware(now: Date): Promise<void> {
  if (!env.HARDWARE_AUTO_COMPLETE) return;

  const cutoff = new Date(now.getTime() - env.AUTO_COMPLETE_DEBOUNCE_MINUTES * 60_000);
  const vacancies = await prisma.hardwareEvent.findMany({
    where: { type: "VACANT", result: "SUGGESTED_END", receivedAt: { lte: cutoff } },
    include: { doctor: true },
    orderBy: { receivedAt: "desc" },
    take: 20,
  });

  for (const event of vacancies) {
    if (!event.doctorId) continue;

    // A later OCCUPIED event cancels the pending vacancy hint.
    const occupiedAfter = await prisma.hardwareEvent.findFirst({
      where: { roomId: event.roomId, type: "OCCUPIED", receivedAt: { gt: event.receivedAt } },
      select: { id: true },
    });
    if (occupiedAfter) {
      await prisma.hardwareEvent.update({ where: { id: event.id }, data: { result: "CANCELLED_BY_OCCUPANCY" } });
      continue;
    }

    const entry = await prisma.queueEntry.findFirst({
      where: { doctorId: event.doctorId, status: "IN_CONSULTATION" },
      include: { appointment: { include: { patient: true } }, consultation: true },
    });
    if (!entry) {
      await prisma.hardwareEvent.update({ where: { id: event.id }, data: { result: "NO_ACTIVE_CONSULTATION" } });
      continue;
    }

    const completed = await prisma.$transaction(async (tx) => {
      const changed = await tx.queueEntry.updateMany({
        where: { id: entry.id, status: "IN_CONSULTATION" },
        data: { status: "COMPLETED", completedAt: now },
      });
      if (changed.count !== 1) return null;
      const startedAt = entry.consultation?.startedAt ?? entry.calledAt ?? now;
      await tx.consultation.upsert({
        where: { queueEntryId: entry.id },
        update: {
          endedAt: now,
          endSource: "SENSOR",
          durationSeconds: Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000)),
        },
        create: {
          queueEntryId: entry.id,
          startedAt,
          endedAt: now,
          endSource: "SENSOR",
          durationSeconds: Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000)),
        },
      });
      await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "COMPLETED" } });
      await tx.auditLog.create({
        data: {
          action: "QUEUE_COMPLETED",
          entity: "QueueEntry",
          entityId: entry.id,
          after: { status: "COMPLETED", endedSource: "SENSOR" },
        },
      });
      await tx.hardwareEvent.update({ where: { id: event.id }, data: { result: "AUTO_COMPLETED" } });
      return entry;
    });
    if (!completed) continue;

    await notify({
      patientId: entry.appointment.patientId,
      appointmentId: entry.appointmentId,
      type: "QUEUE_UPDATED",
      title: "Consultation closed",
      body: "Your consultation was closed automatically after the room sensor detected it was vacant. Thank you.",
      data: { queueEntryId: entry.id },
      dedupeKey: `auto-complete:${entry.id}`,
    }).catch((error) => logger.error({ err: error }, "auto-complete notification failed"));
    socketEmitter.queueUpdated(entry.doctorId, { doctorId: entry.doctorId, serviceDay: entry.serviceDay });
  }
}

/** Kept for tests/scripts that need to drive a sweep without a live server. */
export async function runSchedulerOnce(): Promise<void> {
  await runSchedulerTick(new Date());
}

export function startScheduler(): void {
  if (!env.JOBS_ENABLED || timer) return;
  const tick = () => {
    if (running) return;
    running = true;
    void runSchedulerTick()
      .catch((error) => logger.error({ err: error }, "scheduler tick failed"))
      .finally(() => {
        running = false;
      });
  };
  timer = setInterval(tick, env.SCHEDULER_INTERVAL_MS);
  timer.unref();
  logger.info({ intervalMs: env.SCHEDULER_INTERVAL_MS }, "scheduler started");
  tick();
}

export function stopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info("scheduler stopped");
}
