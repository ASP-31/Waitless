import type { AppointmentStatus, Prisma } from "@prisma/client";
import { assertTransition, toDayKey } from "@waitless/shared";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { socketEmitter } from "../../sockets/emitter";
import { AppError } from "../../utils/errors";
import { notify } from "../notifications/notification.service";

const QUEUE_STATUSES: AppointmentStatus[] = ["BOOKED", "WAITING", "NOTIFIED", "CALLED", "IN_CONSULTATION", "DELAYED", "SKIPPED", "COMPLETED"];
const ACTIVE_ORDER: AppointmentStatus[] = ["IN_CONSULTATION", "CALLED", "DELAYED", "NOTIFIED", "WAITING", "BOOKED", "SKIPPED"];
const BLOCKING = new Set<AppointmentStatus>(["WAITING", "NOTIFIED", "DELAYED", "CALLED", "IN_CONSULTATION"]);

type Viewer = { role: string; patientId?: string | null };

function todayKey() {
  return toDayKey(new Date(), env.HOSPITAL_TIMEZONE);
}

function rank(status: AppointmentStatus) {
  const index = ACTIVE_ORDER.indexOf(status);
  return index === -1 ? 99 : index;
}

function maskName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.map((part) => `${part[0]?.toUpperCase() ?? ""}.`).join(" ") || "Patient";
}

function maskPhone(phone: string) {
  return phone.length > 4 ? `••••${phone.slice(-4)}` : "••••";
}

/**
 * Rolling average of the doctor's last 10 completed consultations, clamped to
 * the same 3–60 minute band used by the shared ETA helper. Falls back to the
 * doctor's configured average when there is no history.
 */
async function consultMinutes(tx: Prisma.TransactionClient, doctorId: string): Promise<number> {
  const [doctor, recent] = await Promise.all([
    tx.doctor.findUnique({ where: { id: doctorId }, select: { avgConsultMinutes: true } }),
    tx.consultation.findMany({
      where: { queueEntry: { doctorId }, durationSeconds: { not: null } },
      orderBy: { endedAt: "desc" },
      take: 10,
      select: { durationSeconds: true },
    }),
  ]);
  const values = recent
    .map((row) => (row.durationSeconds ?? 0) / 60)
    .filter((minutes) => minutes > 0);
  const fallback = doctor?.avgConsultMinutes ?? env.DEFAULT_CONSULT_MINUTES;
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
  return Math.max(3, Math.min(60, Math.round(average)));
}

/** Exported so swap execution can keep positions/ETAs consistent after an exchange. */
export async function recomputePositions(
  tx: Prisma.TransactionClient,
  doctorId: string,
  serviceDay: string,
): Promise<number> {
  const entries = await tx.queueEntry.findMany({
    where: { doctorId, serviceDay, status: { in: QUEUE_STATUSES } },
    include: { appointment: true },
  });
  const avg = await consultMinutes(tx, doctorId);

  entries.sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    const bySlot = a.appointment.slotStart.getTime() - b.appointment.slotStart.getTime();
    if (bySlot !== 0) return bySlot;
    return a.appointment.tokenNumber - b.appointment.tokenNumber;
  });

  let activeAhead = 0;
  for (const entry of entries) {
    const position = entries.indexOf(entry) + 1;
    // Terminal rows are numbered last and must not show a future ETA.
    const estimatedStartAt =
      entry.status === "COMPLETED"
        ? null
        : entry.status === "IN_CONSULTATION" || entry.status === "CALLED"
          ? new Date()
          : new Date(Date.now() + activeAhead * avg * 60_000);
    const changedEta = (entry.estimatedStartAt?.getTime() ?? null) !== (estimatedStartAt?.getTime() ?? null);
    if (entry.position !== position || changedEta) {
      await tx.queueEntry.update({ where: { id: entry.id }, data: { position, estimatedStartAt } });
    }
    if (BLOCKING.has(entry.status)) activeAhead += 1;
  }
  return entries.length;
}

export async function ensureDayQueue(doctorId: string, date = todayKey()) {
  const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
  if (!doctor) throw AppError.notFound("Doctor not found");

  const appointments = await prisma.appointment.findMany({
    where: {
      doctorId,
      serviceDay: date,
      status: { in: ["BOOKED", "WAITING", "NOTIFIED", "CALLED", "IN_CONSULTATION", "DELAYED", "SKIPPED"] },
    },
    include: { queueEntry: true },
    orderBy: [{ slotStart: "asc" }, { tokenNumber: "asc" }],
  });

  await prisma.$transaction(async (tx) => {
    const isToday = date === todayKey();
    for (const appointment of appointments) {
      if (appointment.queueEntry) continue;
      const status: AppointmentStatus =
        appointment.status === "BOOKED" && isToday ? "WAITING" : appointment.status;
      await tx.queueEntry.create({
        data: {
          appointmentId: appointment.id,
          doctorId,
          serviceDay: date,
          position: 1,
          status,
          estimatedStartAt: new Date(),
        },
      });
      if (appointment.status === "BOOKED" && isToday) {
        await tx.appointment.update({ where: { id: appointment.id }, data: { status: "WAITING" } });
      }
    }
    await recomputePositions(tx, doctorId, date);
  });
}

export async function getQueue(doctorId: string, date = todayKey(), viewer?: Viewer) {
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

  const current = entries.find((entry) => ["CALLED", "IN_CONSULTATION"].includes(entry.status)) ?? null;
  const stats = {
    waiting: entries.filter((entry) => ["WAITING", "NOTIFIED", "DELAYED", "BOOKED"].includes(entry.status)).length,
    called: entries.filter((entry) => entry.status === "CALLED").length,
    inConsultation: entries.filter((entry) => entry.status === "IN_CONSULTATION").length,
    completed: entries.filter((entry) => entry.status === "COMPLETED").length,
    skipped: entries.filter((entry) => entry.status === "SKIPPED").length,
    avgConsultMinutes: doctor.avgConsultMinutes,
    patientsAhead: entries.filter((entry) => BLOCKING.has(entry.status)).length,
  };

  // Patients can watch the queue, but never see other patients' names/numbers.
  const isPatient = viewer?.role === "PATIENT";
  const sanitize = <T extends { appointment: { patientId: string; patient: { fullName: string; phone: string } } }>(entry: T) => {
    if (!isPatient) return entry;
    const mine = viewer?.patientId === entry.appointment.patientId;
    return {
      ...entry,
      isMine: mine,
      appointment: {
        ...entry.appointment,
        patient: {
          fullName: mine ? entry.appointment.patient.fullName : maskName(entry.appointment.patient.fullName),
          phone: mine ? entry.appointment.patient.phone : maskPhone(entry.appointment.patient.phone),
        },
      },
    };
  };

  return {
    doctor,
    date,
    entries: entries.map(sanitize),
    currentPatient: current ? sanitize(current) : null,
    stats,
  };
}

async function getEntry(id: string) {
  const entry = await prisma.queueEntry.findUnique({
    where: { id },
    include: { appointment: { include: { patient: true, doctor: true } }, consultation: true },
  });
  if (!entry) throw AppError.notFound("Queue entry not found");
  return entry;
}

export async function callPatient(entryId: string, actorUserId: string) {
  const entry = await getEntry(entryId);
  const from = entry.status;
  assertTransition(from, "CALLED");
  const now = new Date();
  const graceDeadlineAt = new Date(now.getTime() + env.GRACE_MINUTES * 60_000);
  const updated = await prisma.$transaction(async (tx) => {
    const queueEntry = await tx.queueEntry.update({
      where: { id: entryId },
      data: { status: "CALLED", calledAt: now, graceDeadlineAt },
      include: { appointment: { include: { patient: true, department: true, doctor: { include: { room: true } } } }, consultation: true },
    });
    await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "CALLED" } });
    await tx.auditLog.create({ data: { actorUserId, action: "QUEUE_CALLED", entity: "QueueEntry", entityId: entryId, before: { status: from }, after: { status: "CALLED" } } });
    await recomputePositions(tx, entry.doctorId, entry.serviceDay);
    return queueEntry;
  });
  await notify({
    patientId: updated.appointment.patientId,
    appointmentId: updated.appointmentId,
    type: "NEXT_IN_QUEUE",
    title: "It is your turn",
    body: `Token #${updated.appointment.tokenNumber} is being called. Please proceed to the room.`,
    data: { queueEntryId: updated.id, graceDeadlineAt: graceDeadlineAt.toISOString() },
    dedupeKey: `call:${updated.id}:${Math.floor(now.getTime() / 60_000)}`,
  }).catch((error) => logger.error({ err: error }, "call notification failed"));
  socketEmitter.queueUpdated(updated.doctorId, { doctorId: updated.doctorId, serviceDay: updated.serviceDay });
  socketEmitter.appointmentUpdated(updated.appointment.patientId, { appointmentId: updated.appointmentId, status: "CALLED" });
  return updated;
}

export async function startConsultation(entryId: string, actorUserId: string) {
  const entry = await getEntry(entryId);
  const from = entry.status;
  assertTransition(from, "IN_CONSULTATION");
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    await tx.queueEntry.update({ where: { id: entryId }, data: { status: "IN_CONSULTATION" } });
    await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "IN_CONSULTATION" } });
    await tx.consultation.upsert({
      where: { queueEntryId: entryId },
      update: { startedAt: now, endedAt: null, endSource: null, durationSeconds: null, startedByUserId: actorUserId },
      create: { queueEntryId: entryId, startedAt: now, startedByUserId: actorUserId },
    });
    await tx.auditLog.create({ data: { actorUserId, action: "QUEUE_STARTED", entity: "QueueEntry", entityId: entryId, before: { status: from }, after: { status: "IN_CONSULTATION" } } });
    await recomputePositions(tx, entry.doctorId, entry.serviceDay);
    return tx.queueEntry.findUniqueOrThrow({ where: { id: entryId }, include: { appointment: { include: { patient: true, department: true, doctor: { include: { room: true } } } }, consultation: true } });
  });
  socketEmitter.queueUpdated(updated.doctorId, { doctorId: updated.doctorId, serviceDay: updated.serviceDay });
  socketEmitter.appointmentUpdated(updated.appointment.patientId, { appointmentId: updated.appointmentId, status: "IN_CONSULTATION" });
  return updated;
}

export async function completeConsultation(entryId: string, actorUserId: string) {
  const entry = await getEntry(entryId);
  const from = entry.status;
  assertTransition(from, "COMPLETED");
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const consult = await tx.consultation.findUnique({ where: { queueEntryId: entryId } });
    const startedAt = consult?.startedAt ?? entry.calledAt ?? now;
    const durationSeconds = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000));
    await tx.consultation.upsert({
      where: { queueEntryId: entryId },
      update: { endedAt: now, endSource: "STAFF", durationSeconds },
      create: { queueEntryId: entryId, startedAt, endedAt: now, endSource: "STAFF", durationSeconds, startedByUserId: actorUserId },
    });
    await tx.queueEntry.update({ where: { id: entryId }, data: { status: "COMPLETED", completedAt: now } });
    await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "COMPLETED" } });
    await tx.auditLog.create({ data: { actorUserId, action: "QUEUE_COMPLETED", entity: "QueueEntry", entityId: entryId, before: { status: from }, after: { status: "COMPLETED", durationSeconds } } });
    await recomputePositions(tx, entry.doctorId, entry.serviceDay);
    return tx.queueEntry.findUniqueOrThrow({ where: { id: entryId }, include: { appointment: { include: { patient: true, department: true, doctor: { include: { room: true } } } }, consultation: true } });
  });
  await notify({
    patientId: updated.appointment.patientId,
    appointmentId: updated.appointmentId,
    type: "QUEUE_UPDATED",
    title: "Consultation completed",
    body: "Your consultation is complete. Thank you for visiting City Care Hospital.",
    data: { queueEntryId: updated.id },
    dedupeKey: `completed:${updated.id}`,
  }).catch((error) => logger.error({ err: error }, "completion notification failed"));
  socketEmitter.queueUpdated(updated.doctorId, { doctorId: updated.doctorId, serviceDay: updated.serviceDay });
  socketEmitter.appointmentUpdated(updated.appointment.patientId, { appointmentId: updated.appointmentId, status: "COMPLETED" });
  return updated;
}

export async function skipPatient(entryId: string, actorUserId: string, reason?: string) {
  const entry = await getEntry(entryId);
  const from = entry.status;
  assertTransition(from, "SKIPPED");
  const updated = await prisma.$transaction(async (tx) => {
    await tx.queueEntry.update({ where: { id: entryId }, data: { status: "SKIPPED", skippedReason: reason ?? null } });
    await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "SKIPPED" } });
    await tx.auditLog.create({ data: { actorUserId, action: "QUEUE_SKIPPED", entity: "QueueEntry", entityId: entryId, before: { status: from }, after: { status: "SKIPPED", reason: reason ?? null } } });
    await recomputePositions(tx, entry.doctorId, entry.serviceDay);
    return tx.queueEntry.findUniqueOrThrow({ where: { id: entryId }, include: { appointment: { include: { patient: true, department: true, doctor: { include: { room: true } } } }, consultation: true } });
  });
  await notify({
    patientId: updated.appointment.patientId,
    appointmentId: updated.appointmentId,
    type: "SKIPPED",
    title: "Your turn was skipped",
    body: reason ? `Your turn was skipped: ${reason}. Please contact the front desk to be requeued.` : "Your turn was skipped. Please contact the front desk to be requeued.",
    data: { queueEntryId: updated.id },
    dedupeKey: `skipped:${updated.id}`,
  }).catch((error) => logger.error({ err: error }, "skip notification failed"));
  socketEmitter.queueUpdated(updated.doctorId, { doctorId: updated.doctorId, serviceDay: updated.serviceDay });
  socketEmitter.appointmentUpdated(updated.appointment.patientId, { appointmentId: updated.appointmentId, status: "SKIPPED" });
  return updated;
}

export async function markArrived(entryId: string, actorUserId: string) {
  const entry = await getEntry(entryId);
  const now = new Date();

  if (entry.status === "SKIPPED") {
    const updated = await prisma.$transaction(async (tx) => {
      await tx.queueEntry.update({ where: { id: entryId }, data: { status: "WAITING", skippedReason: null, graceDeadlineAt: null } });
      await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "WAITING" } });
      await tx.auditLog.create({ data: { actorUserId, action: "QUEUE_REQUEUED", entity: "QueueEntry", entityId: entryId, before: { status: "SKIPPED" }, after: { status: "WAITING" } } });
      await recomputePositions(tx, entry.doctorId, entry.serviceDay);
      return tx.queueEntry.findUniqueOrThrow({ where: { id: entryId }, include: { appointment: { include: { patient: true, department: true, doctor: { include: { room: true } } } }, consultation: true } });
    });
    socketEmitter.queueUpdated(updated.doctorId, { doctorId: updated.doctorId, serviceDay: updated.serviceDay });
    socketEmitter.appointmentUpdated(updated.appointment.patientId, { appointmentId: updated.appointmentId, status: "WAITING" });
    return updated;
  }

  if (entry.status === "DELAYED" || entry.status === "CALLED") {
    const graceDeadlineAt = new Date(now.getTime() + env.GRACE_MINUTES * 60_000);
    const updated = await prisma.$transaction(async (tx) => {
      await tx.queueEntry.update({ where: { id: entryId }, data: { status: "CALLED", calledAt: now, graceDeadlineAt } });
      await tx.appointment.update({ where: { id: entry.appointmentId }, data: { status: "CALLED" } });
      await tx.auditLog.create({ data: { actorUserId, action: "QUEUE_CALLED", entity: "QueueEntry", entityId: entryId, before: { status: entry.status }, after: { status: "CALLED", reason: "Patient checked in" } } });
      await recomputePositions(tx, entry.doctorId, entry.serviceDay);
      return tx.queueEntry.findUniqueOrThrow({ where: { id: entryId }, include: { appointment: { include: { patient: true, department: true, doctor: { include: { room: true } } } }, consultation: true } });
    });
    socketEmitter.queueUpdated(updated.doctorId, { doctorId: updated.doctorId, serviceDay: updated.serviceDay });
    socketEmitter.appointmentUpdated(updated.appointment.patientId, { appointmentId: updated.appointmentId, status: "CALLED" });
    return updated;
  }

  return getEntry(entryId);
}
