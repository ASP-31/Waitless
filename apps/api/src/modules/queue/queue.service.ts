import type { AppointmentStatus, Prisma, PrismaClient } from "@prisma/client";
import {
  assertTransition,
  countAhead,
  estimateWaitMinutes,
  etaRange,
  rollingAverageMinutes,
  toDayKey,
} from "@waitless/shared";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { redis } from "../../config/redis";
import { cancelJob, enqueue, jobIds, QUEUE_NAMES } from "../../jobs/schedulers";
import {
  cancelReady30,
  notify,
  scheduleReady30,
} from "../notifications/notification.service";
import { socketEmitter } from "../../sockets/emitter";
import { AppError } from "../../utils/errors";

const QUEUE_STATUSES: AppointmentStatus[] = ["BOOKED", "WAITING", "NOTIFIED", "CALLED", "IN_CONSULTATION", "DELAYED", "SKIPPED"];
const ACTIVE_ORDER: AppointmentStatus[] = ["IN_CONSULTATION", "CALLED", "DELAYED", "NOTIFIED", "WAITING", "BOOKED", "SKIPPED"];
const NON_BLOCKING = ["COMPLETED", "SKIPPED", "CANCELLED", "NO_SHOW"];

type EtaUpdate = { appointmentId: string; patientId: string; doctorName: string; estimatedStartAt: Date | null };

/** Staff override reason, when supplied, travels with audit/log/socket details. */
function withReason(details: Record<string, unknown>, reason?: string): Record<string, unknown> {
  return reason ? { ...details, reason } : details;
}

function auditDetails(details: Record<string, unknown>, reason?: string): Prisma.InputJsonValue {
  return withReason(details, reason) as Prisma.InputJsonValue;
}

function todayKey() {
  return toDayKey(new Date(), env.HOSPITAL_TIMEZONE);
}

/** Rolling average from the doctor's last 10 finished consultations. */
async function averageConsultMinutes(tx: Prisma.TransactionClient | PrismaClient, doctorId: string, doctorAverage: number): Promise<number> {
  const recent = await tx.consultation.findMany({
    where: {
      endedAt: { not: null },
      durationSeconds: { not: null },
      queueEntry: { doctorId },
    },
    orderBy: { endedAt: "desc" },
    take: 10,
    select: { durationSeconds: true },
  });
  return rollingAverageMinutes(recent.map((row) => row.durationSeconds ?? 0), doctorAverage || env.DEFAULT_CONSULT_MINUTES);
}

async function recomputePositions(tx: Prisma.TransactionClient, doctorId: string, serviceDay: string): Promise<EtaUpdate[]> {
  const [entries, doctor] = await Promise.all([
    tx.queueEntry.findMany({
      where: { doctorId, serviceDay, status: { in: QUEUE_STATUSES } },
      include: { appointment: { include: { patient: true, doctor: true } } },
      orderBy: [{ position: "asc" }],
    }),
    tx.doctor.findUnique({ where: { id: doctorId } }),
  ]);
  if (!doctor) return [];
  const avg = await averageConsultMinutes(tx, doctorId, doctor.avgConsultMinutes);

  const rank = (status: AppointmentStatus) => {
    const index = ACTIVE_ORDER.indexOf(status);
    return index === -1 ? 99 : index;
  };
  entries.sort((a, b) => {
    const ra = rank(a.status), rb = rank(b.status);
    if (ra !== rb) return ra - rb;
    if (a.position !== b.position) return a.position - b.position;
    const sa = a.appointment.slotStart.getTime(), sb = b.appointment.slotStart.getTime();
    if (sa !== sb) return sa - sb;
    return a.appointment.tokenNumber - b.appointment.tokenNumber;
  });

  const now = Date.now();
  const updates: EtaUpdate[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const position = index + 1;
    const ahead = entries.slice(0, index);
    const waitMinutes = estimateWaitMinutes(
      ahead.map((item) => ({ status: item.status, position: item.position, avgConsultMinutes: avg })),
      avg,
    );
    const estimatedStartAt = new Date(now + waitMinutes * 60_000);
    if (entry.position !== position || entry.estimatedStartAt?.getTime() !== estimatedStartAt.getTime()) {
      await tx.queueEntry.update({ where: { id: entry.id }, data: { position, estimatedStartAt } });
    }
    updates.push({
      appointmentId: entry.appointmentId,
      patientId: entry.appointment.patientId,
      doctorName: doctor.fullName,
      estimatedStartAt,
    });
  }
  return updates;
}

/** Called after a transaction commits: schedule reminders and push live notifications. */
async function publishEtaUpdates(doctorId: string, serviceDay: string, updates: EtaUpdate[]): Promise<void> {
  for (const update of updates) {
    await scheduleReady30(update.appointmentId, update.estimatedStartAt, {
      patientId: update.patientId,
      title: "Your turn is coming up",
      body: `Your appointment with ${update.doctorName} is about 30 minutes away.`,
    });
  }
  await notifyQueueChanges(doctorId, serviceDay);
}

async function notifyQueueChanges(doctorId: string, serviceDay: string): Promise<void> {
  const entries = await prisma.queueEntry.findMany({
    where: { doctorId, serviceDay, status: { in: ["WAITING", "NOTIFIED"] } },
    include: { appointment: { include: { patient: true, doctor: true } } },
    orderBy: { position: "asc" },
  });
  for (const entry of entries) {
    const ahead = countAhead(entries.filter((item) => item.position < entry.position));
    if (ahead > 0 && ahead <= 2) {
      await notify({
        patientId: entry.appointment.patientId,
        appointmentId: entry.appointmentId,
        type: "NEXT_IN_QUEUE",
        title: "You're almost next",
        body: `${ahead} patient${ahead === 1 ? "" : "s"} ahead of you for ${entry.appointment.doctor.fullName}.`,
        dedupeKey: `next:${entry.appointmentId}:${entry.position}`,
        channels: ["IN_APP", "WEB_PUSH"],
      });
    }
    if (entry.estimatedStartAt) {
      const range = etaRange(Math.max(0, Math.round((entry.estimatedStartAt.getTime() - Date.now()) / 60_000)));
      const lockKey = `waitless:queue-eta-notify:${entry.appointmentId}`;
      const acquired = await redis.set(lockKey, "1", "EX", 600, "NX");
      if (acquired) {
        await notify({
          patientId: entry.appointment.patientId,
          appointmentId: entry.appointmentId,
          type: "QUEUE_UPDATED",
          title: "Queue estimate updated",
          body: `Estimated wait for ${entry.appointment.doctor.fullName}: about ${range.min}–${range.max} minutes.`,
          dedupeKey: `queue-updated:${entry.appointmentId}:${Date.now()}`,
        });
      }
    }
  }
}

async function emitQueue(doctorId: string, serviceDay: string, payload: Record<string, unknown> = {}) {
  socketEmitter.queueUpdated(doctorId, { doctorId, serviceDay, ...payload });
}

async function getEntry(id: string) {
  const entry = await prisma.queueEntry.findUnique({
    where: { id },
    include: { appointment: { include: { patient: true, doctor: true } }, consultation: true },
  });
  if (!entry) throw AppError.notFound("Queue entry not found");
  return entry;
}

export async function ensureDayQueue(doctorId: string, date = todayKey()) {
  const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
  if (!doctor) throw AppError.notFound("Doctor not found");

  const appointments = await prisma.appointment.findMany({
    where: {
      doctorId,
      serviceDay: date,
      status: { in: QUEUE_STATUSES },
    },
    include: { queueEntry: true },
    orderBy: [{ slotStart: "asc" }, { tokenNumber: "asc" }],
  });

  let updates: EtaUpdate[] = [];
  await prisma.$transaction(async (tx) => {
    let position = 1;
    for (const appointment of appointments) {
      if (appointment.queueEntry) {
        position++;
        continue;
      }
      const status: AppointmentStatus = appointment.status === "BOOKED" ? "WAITING" : appointment.status;
      await tx.queueEntry.create({
        data: {
          appointmentId: appointment.id,
          doctorId,
          serviceDay: date,
          position: position++,
          status,
        },
      });
      if (appointment.status === "BOOKED") {
        await tx.appointment.update({ where: { id: appointment.id }, data: { status: "WAITING" } });
      }
    }
    updates = await recomputePositions(tx, doctorId, date);
  });
  await publishEtaUpdates(doctorId, date, updates);
}

export async function getQueue(doctorId: string, date = todayKey()) {
  await ensureDayQueue(doctorId, date);
  const [entries, doctor] = await Promise.all([
    prisma.queueEntry.findMany({
      where: { doctorId, serviceDay: date },
      include: {
        appointment: {
          include: { patient: true, department: true, doctor: { include: { room: true } } },
        },
        consultation: true,
      },
      orderBy: [{ position: "asc" }],
    }),
    prisma.doctor.findUnique({ where: { id: doctorId }, include: { department: true, room: true } }),
  ]);
  if (!doctor) throw AppError.notFound("Doctor not found");

  const avg = await averageConsultMinutes(prisma, doctorId, doctor.avgConsultMinutes);
  const current = entries.find((entry) => ["CALLED", "IN_CONSULTATION"].includes(entry.status)) ?? null;
  const blocking = entries.filter((entry) => !NON_BLOCKING.includes(entry.status));
  const first = blocking[0];
  const stats = {
    waiting: entries.filter((entry) => ["WAITING", "NOTIFIED", "DELAYED", "BOOKED"].includes(entry.status)).length,
    called: entries.filter((entry) => entry.status === "CALLED").length,
    inConsultation: entries.filter((entry) => entry.status === "IN_CONSULTATION").length,
    completed: entries.filter((entry) => entry.status === "COMPLETED").length,
    skipped: entries.filter((entry) => entry.status === "SKIPPED").length,
    avgConsultMinutes: avg,
    patientsAhead: countAhead(blocking),
    estimatedWaitMinutes: first?.estimatedStartAt
      ? Math.max(0, Math.round((first.estimatedStartAt.getTime() - Date.now()) / 60_000))
      : 0,
  };
  const decorated = entries.map((entry) => {
    const minutes = entry.estimatedStartAt
      ? Math.max(0, Math.round((entry.estimatedStartAt.getTime() - Date.now()) / 60_000))
      : 0;
    return { ...entry, estimatedWaitMinutes: minutes, etaRange: etaRange(minutes) };
  });
  return { doctor, date, entries: decorated, currentPatient: current, stats };
}

export async function callPatient(entryId: string, actorUserId: string, reason?: string) {
  const entry = await getEntry(entryId);
  const from = entry.status;
  assertTransition(from, "CALLED");
  const now = new Date();
  const graceDeadlineAt = new Date(now.getTime() + env.GRACE_MINUTES * 60_000);
  const updates: EtaUpdate[] = [];
  const updated = await prisma.$transaction(async (tx) => {
    const queueEntry = await tx.queueEntry.update({
      where: { id: entryId },
      data: { status: "CALLED", calledAt: now, graceDeadlineAt },
      include: { appointment: { include: { patient: true, department: true, doctor: { include: { room: true } } } }, consultation: true },
    });
    await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "CALLED" } });
    await tx.auditLog.create({ data: { actorUserId, action: "QUEUE_CALLED", entity: "QueueEntry", entityId: entryId, before: auditDetails({ status: from }), after: auditDetails({ status: "CALLED" }, reason) } });
    updates.push(...await recomputePositions(tx, entry.doctorId, entry.serviceDay));
    return queueEntry;
  });
  await enqueue(QUEUE_NAMES.queue, jobIds.grace(entryId), { entryId }, { delay: env.GRACE_MINUTES * 60_000 });
  await publishEtaUpdates(entry.doctorId, entry.serviceDay, updates);
  socketEmitter.appointmentUpdated(updated.appointment.patientId, withReason({ appointmentId: updated.appointmentId, status: "CALLED" }, reason));
  socketEmitter.queueCalled(entry.doctorId, updated.appointment.patientId, withReason({
    entryId,
    appointmentId: updated.appointmentId,
    doctorId: entry.doctorId,
    tokenNumber: updated.appointment.tokenNumber,
  }, reason));
  return updated;
}

/** BullMQ processor: called patient did not arrive within the grace window. */
export async function expireGrace(entryId: string): Promise<void> {
  const entry = await prisma.queueEntry.findUnique({ where: { id: entryId }, include: { appointment: { include: { patient: true, doctor: true } } } });
  if (!entry || entry.status !== "CALLED") return;
  const updates: EtaUpdate[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.queueEntry.update({ where: { id: entryId }, data: { status: "DELAYED", graceDeadlineAt: null } });
    await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "DELAYED" } });
    await tx.auditLog.create({ data: { action: "QUEUE_REQUEUED", entity: "QueueEntry", entityId: entryId, before: { status: "CALLED" } as Prisma.InputJsonValue, after: { status: "DELAYED" } as Prisma.InputJsonValue } });
    updates.push(...await recomputePositions(tx, entry.doctorId, entry.serviceDay));
  });
  await notify({
    patientId: entry.appointment.patientId,
    appointmentId: entry.appointmentId,
    type: "DELAY_WARNING",
    title: "Please check in",
    body: `Your slot with ${entry.appointment.doctor.fullName} is now delayed. Please report to reception.`,
    dedupeKey: `delay:${entryId}`,
    channels: ["IN_APP", "WEB_PUSH"],
  });
  if (env.AUTO_SKIP_ENABLED) {
    await enqueue(QUEUE_NAMES.queue, jobIds.autoSkip(entryId), { entryId }, { delay: env.DELAY_MINUTES * 60_000 });
  }
  await publishEtaUpdates(entry.doctorId, entry.serviceDay, updates);
  await emitQueue(entry.doctorId, entry.serviceDay);
}

/** BullMQ processor: delayed patient was skipped automatically. */
export async function autoSkip(entryId: string): Promise<void> {
  const entry = await prisma.queueEntry.findUnique({ where: { id: entryId }, include: { appointment: { include: { patient: true, doctor: true } } } });
  if (!entry || entry.status !== "DELAYED") return;
  const updates: EtaUpdate[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.queueEntry.update({ where: { id: entryId }, data: { status: "SKIPPED", skippedReason: "AUTO_SKIPPED" } });
    await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "SKIPPED" } });
    await tx.auditLog.create({ data: { action: "QUEUE_SKIPPED", entity: "QueueEntry", entityId: entryId, before: { status: "DELAYED" } as Prisma.InputJsonValue, after: { status: "SKIPPED", reason: "AUTO_SKIPPED" } as Prisma.InputJsonValue } });
    updates.push(...await recomputePositions(tx, entry.doctorId, entry.serviceDay));
  });
  await notify({
    patientId: entry.appointment.patientId,
    appointmentId: entry.appointmentId,
    type: "SKIPPED",
    title: "Slot missed",
    body: `Your slot with ${entry.appointment.doctor.fullName} was released after the delay window. Please see reception.`,
    dedupeKey: `skip:${entryId}`,
    channels: ["IN_APP", "WEB_PUSH"],
  });
  await publishEtaUpdates(entry.doctorId, entry.serviceDay, updates);
  await emitQueue(entry.doctorId, entry.serviceDay);
}

export async function startConsultation(entryId: string, actorUserId: string, reason?: string) {
  const entry = await getEntry(entryId);
  const from = entry.status;
  assertTransition(from, "IN_CONSULTATION");
  const now = new Date();
  const updates: EtaUpdate[] = [];
  const updated = await prisma.$transaction(async (tx) => {
    await tx.queueEntry.update({ where: { id: entryId }, data: { status: "IN_CONSULTATION", graceDeadlineAt: null } });
    await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "IN_CONSULTATION" } });
    await tx.consultation.upsert({
      where: { queueEntryId: entryId },
      update: { startedAt: now, endedAt: null, endSource: null, durationSeconds: null, suggestedEndAt: null, startedByUserId: actorUserId },
      create: { queueEntryId: entryId, startedAt: now, startedByUserId: actorUserId },
    });
    await tx.auditLog.create({ data: { actorUserId, action: "QUEUE_STARTED", entity: "QueueEntry", entityId: entryId, before: auditDetails({ status: from }), after: auditDetails({ status: "IN_CONSULTATION" }, reason) } });
    updates.push(...await recomputePositions(tx, entry.doctorId, entry.serviceDay));
    return tx.queueEntry.findUniqueOrThrow({ where: { id: entryId }, include: { appointment: { include: { patient: true, department: true, doctor: { include: { room: true } } } }, consultation: true } });
  });
  await cancelJob(QUEUE_NAMES.queue, jobIds.grace(entryId));
  await cancelJob(QUEUE_NAMES.queue, jobIds.autoSkip(entryId));
  await publishEtaUpdates(entry.doctorId, entry.serviceDay, updates);
  await emitQueue(entry.doctorId, entry.serviceDay, withReason({ entryId, status: "IN_CONSULTATION" }, reason));
  return updated;
}

export async function completeConsultation(
  entryId: string,
  actorUserId: string | null,
  endSource: "STAFF" | "SENSOR" | "SYSTEM" = "STAFF",
  reason?: string,
) {
  const entry = await getEntry(entryId);
  const from = entry.status;
  assertTransition(from, "COMPLETED");
  const now = new Date();
  const updates: EtaUpdate[] = [];
  const updated = await prisma.$transaction(async (tx) => {
    const consultation = await tx.consultation.findUnique({ where: { queueEntryId: entryId } });
    const startedAt = consultation?.startedAt ?? entry.calledAt ?? now;
    const durationSeconds = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000));
    await tx.consultation.upsert({
      where: { queueEntryId: entryId },
      update: { endedAt: now, endSource, durationSeconds },
      create: { queueEntryId: entryId, startedAt, endedAt: now, endSource, durationSeconds, startedByUserId: actorUserId },
    });
    await tx.queueEntry.update({ where: { id: entryId }, data: { status: "COMPLETED", completedAt: now } });
    await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "COMPLETED" } });
    await tx.auditLog.create({ data: { actorUserId, action: "QUEUE_COMPLETED", entity: "QueueEntry", entityId: entryId, before: auditDetails({ status: from }), after: auditDetails({ status: "COMPLETED", durationSeconds, endSource }, reason) } });
    updates.push(...await recomputePositions(tx, entry.doctorId, entry.serviceDay));
    return tx.queueEntry.findUniqueOrThrow({ where: { id: entryId }, include: { appointment: { include: { patient: true, department: true, doctor: { include: { room: true } } } }, consultation: true } });
  });
  await cancelReady30(entry.appointmentId);
  await publishEtaUpdates(entry.doctorId, entry.serviceDay, updates);
  await emitQueue(entry.doctorId, entry.serviceDay, withReason({ entryId, status: "COMPLETED" }, reason));
  return updated;
}

export async function skipPatient(entryId: string, actorUserId: string, reason?: string) {
  const entry = await getEntry(entryId);
  const from = entry.status;
  assertTransition(from, "SKIPPED");
  const updates: EtaUpdate[] = [];
  const updated = await prisma.$transaction(async (tx) => {
    await tx.queueEntry.update({ where: { id: entryId }, data: { status: "SKIPPED", skippedReason: reason ?? null } });
    await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "SKIPPED" } });
    await tx.auditLog.create({ data: { actorUserId, action: "QUEUE_SKIPPED", entity: "QueueEntry", entityId: entryId, before: auditDetails({ status: from }), after: auditDetails({ status: "SKIPPED", reason: reason ?? null }, reason) } });
    updates.push(...await recomputePositions(tx, entry.doctorId, entry.serviceDay));
    return tx.queueEntry.findUniqueOrThrow({ where: { id: entryId }, include: { appointment: { include: { patient: true, department: true, doctor: { include: { room: true } } } }, consultation: true } });
  });
  if (env.SKIP_POLICY === "drop") {
    await prisma.queueEntry.delete({ where: { id: entryId } }).catch(() => undefined);
  }
  await notify({
    patientId: entry.appointment.patientId,
    appointmentId: entry.appointmentId,
    type: "SKIPPED",
    title: "Slot missed",
    body: reason
      ? `Your slot with ${entry.appointment.doctor.fullName} was released by staff. Reason: ${reason}`
      : `Your slot with ${entry.appointment.doctor.fullName} was released by staff. Please see reception.`,
    data: reason ? { reason } : undefined,
    dedupeKey: `skip:${entryId}`,
    channels: ["IN_APP", "WEB_PUSH"],
  });
  await publishEtaUpdates(entry.doctorId, entry.serviceDay, updates);
  await emitQueue(entry.doctorId, entry.serviceDay, withReason({ entryId, status: "SKIPPED" }, reason));
  return updated;
}

export async function markArrived(entryId: string, actorUserId: string, reason?: string) {
  const entry = await getEntry(entryId);
  const updates: EtaUpdate[] = [];
  if (entry.status === "SKIPPED" || entry.status === "WAITING") {
    const updated = await prisma.$transaction(async (tx) => {
      await tx.queueEntry.update({ where: { id: entryId }, data: { status: "WAITING", skippedReason: null } });
      await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "WAITING" } });
      await tx.auditLog.create({ data: { actorUserId, action: "QUEUE_REQUEUED", entity: "QueueEntry", entityId: entryId, before: auditDetails({ status: entry.status }), after: auditDetails({ status: "WAITING" }, reason) } });
      updates.push(...await recomputePositions(tx, entry.doctorId, entry.serviceDay));
      return tx.queueEntry.findUniqueOrThrow({ where: { id: entryId }, include: { appointment: { include: { patient: true, department: true, doctor: { include: { room: true } } } }, consultation: true } });
    });
    await publishEtaUpdates(entry.doctorId, entry.serviceDay, updates);
    await emitQueue(entry.doctorId, entry.serviceDay, withReason({ entryId, status: "WAITING" }, reason));
    return updated;
  }
  assertTransition(entry.status, "CALLED");
  const now = new Date();
  const graceDeadlineAt = new Date(now.getTime() + env.GRACE_MINUTES * 60_000);
  const updated = await prisma.$transaction(async (tx) => {
    await tx.queueEntry.update({ where: { id: entryId }, data: { status: "CALLED", calledAt: now, graceDeadlineAt } });
    await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "CALLED", checkedInAt: now } });
    await tx.auditLog.create({ data: { actorUserId, action: "APPOINTMENT_CHECKED_IN", entity: "QueueEntry", entityId: entryId, after: auditDetails({ status: "CALLED" }, reason) } });
    updates.push(...await recomputePositions(tx, entry.doctorId, entry.serviceDay));
    return tx.queueEntry.findUniqueOrThrow({ where: { id: entryId }, include: { appointment: { include: { patient: true, department: true, doctor: { include: { room: true } } } }, consultation: true } });
  });
  await enqueue(QUEUE_NAMES.queue, jobIds.grace(entryId), { entryId }, { delay: env.GRACE_MINUTES * 60_000 });
  await publishEtaUpdates(entry.doctorId, entry.serviceDay, updates);
  await emitQueue(entry.doctorId, entry.serviceDay, withReason({ entryId, status: "CALLED" }, reason));
  return updated;
}

/** Patient's "I'm here" button: interrupts grace once per appointment. */
export async function selfCheckIn(entryId: string, auth: { userId: string; role: string; patientId?: string | null }) {
  const entry = await getEntry(entryId);
  if (auth.role !== "PATIENT" || entry.appointment.patientId !== auth.patientId) throw AppError.forbidden();
  if (entry.selfCheckInAt) throw AppError.conflict("CONFLICT", "You have already checked in");
  if (["COMPLETED", "CANCELLED", "NO_SHOW"].includes(entry.status)) throw AppError.conflict("INVALID_TRANSITION", "This visit is closed");

  const now = new Date();
  const graceDeadlineAt = new Date(now.getTime() + env.GRACE_MINUTES * 60_000);
  const updates: EtaUpdate[] = [];
  const nextStatus: AppointmentStatus = entry.status === "BOOKED" ? "WAITING" : entry.status === "DELAYED" ? "CALLED" : entry.status;
  await prisma.$transaction(async (tx) => {
    await tx.queueEntry.update({ where: { id: entryId }, data: { selfCheckInAt: now, status: nextStatus, graceDeadlineAt } });
    await tx.appointment.update({ where: { id: entry.appointmentId }, data: { checkedInAt: now, status: nextStatus } });
    await tx.auditLog.create({ data: { actorUserId: auth.userId, action: "APPOINTMENT_CHECKED_IN", entity: "QueueEntry", entityId: entryId, after: { status: nextStatus } as Prisma.InputJsonValue } });
    updates.push(...await recomputePositions(tx, entry.doctorId, entry.serviceDay));
  });
  if (entry.status === "DELAYED") await enqueue(QUEUE_NAMES.queue, jobIds.grace(entryId), { entryId }, { delay: env.GRACE_MINUTES * 60_000 });
  await publishEtaUpdates(entry.doctorId, entry.serviceDay, updates);
  await emitQueue(entry.doctorId, entry.serviceDay);
  return prisma.queueEntry.findUniqueOrThrow({ where: { id: entryId }, include: { appointment: true, consultation: true } });
}

export async function reorder(entryId: string, position: number, actorUserId: string, reason?: string) {
  const entry = await getEntry(entryId);
  if (!Number.isInteger(position) || position < 1) throw AppError.badRequest("Position must be a positive integer");
  const updates: EtaUpdate[] = [];
  const updated = await prisma.$transaction(async (tx) => {
    await tx.queueEntry.update({ where: { id: entryId }, data: { position } });
    await tx.auditLog.create({ data: { actorUserId, action: "QUEUE_REORDERED", entity: "QueueEntry", entityId: entryId, after: auditDetails({ position }, reason) } });
    updates.push(...await recomputePositions(tx, entry.doctorId, entry.serviceDay));
    return tx.queueEntry.findUniqueOrThrow({ where: { id: entryId } });
  });
  await publishEtaUpdates(entry.doctorId, entry.serviceDay, updates);
  await emitQueue(entry.doctorId, entry.serviceDay, withReason({ entryId, position }, reason));
  return updated;
}

export async function markNoShow(entryId: string, actorUserId: string, reason?: string) {
  const entry = await getEntry(entryId);
  assertTransition(entry.status, "NO_SHOW");
  const updates: EtaUpdate[] = [];
  const updated = await prisma.$transaction(async (tx) => {
    await tx.queueEntry.update({ where: { id: entryId }, data: { status: "SKIPPED", skippedReason: "NO_SHOW" } });
    await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "NO_SHOW" } });
    await tx.auditLog.create({ data: { actorUserId, action: "QUEUE_SKIPPED", entity: "QueueEntry", entityId: entryId, after: auditDetails({ status: "NO_SHOW", reason: reason ?? null }, reason) } });
    updates.push(...await recomputePositions(tx, entry.doctorId, entry.serviceDay));
    return tx.queueEntry.findUniqueOrThrow({ where: { id: entryId } });
  });
  await cancelReady30(entry.appointmentId);
  await notify({
    patientId: entry.appointment.patientId,
    appointmentId: entry.appointmentId,
    type: "SKIPPED",
    title: "Slot missed",
    body: reason
      ? `Your slot with ${entry.appointment.doctor.fullName} was marked as a no-show. Reason: ${reason}`
      : `Your slot with ${entry.appointment.doctor.fullName} was marked as a no-show. Please see reception.`,
    data: reason ? { reason } : undefined,
    dedupeKey: `no-show:${entryId}`,
    channels: ["IN_APP", "WEB_PUSH"],
  });
  await publishEtaUpdates(entry.doctorId, entry.serviceDay, updates);
  await emitQueue(entry.doctorId, entry.serviceDay, withReason({ entryId, status: "NO_SHOW" }, reason));
  logger.info({ entryId, reason }, "marked no-show");
  return updated;
}

/** Maintenance job: close consultations left open when staff forgot to finish. */
export async function closeStaleConsultations(): Promise<number> {
  const cutoff = new Date(Date.now() - env.STALE_CONSULTATION_HOURS * 60 * 60_000);
  const stale = await prisma.consultation.findMany({
    where: { endedAt: null, startedAt: { lte: cutoff } },
    select: { queueEntryId: true },
  });
  for (const row of stale) {
    await completeConsultation(row.queueEntryId, null, "SYSTEM");
  }
  return stale.length;
}

/** Maintenance job: prepare tomorrow's queues from today's booked appointments. */
export async function prepareTomorrowQueues(): Promise<number> {
  const { addDaysToDayKey } = await import("@waitless/shared");
  const tomorrow = addDaysToDayKey(todayKey(), 1);
  const doctors = await prisma.doctor.findMany({
    where: { isActive: true, appointments: { some: { serviceDay: tomorrow, status: "BOOKED" } } },
    select: { id: true },
  });
  for (const doctor of doctors) await ensureDayQueue(doctor.id, tomorrow);
  return doctors.length;
}
