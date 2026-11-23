import { createHash } from "node:crypto";
import { Prisma, type AppointmentStatus } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { enqueue, jobIds, QUEUE_NAMES } from "../../jobs/schedulers";
import { notify } from "../notifications/notification.service";
import { socketEmitter } from "../../sockets/emitter";
import { AppError } from "../../utils/errors";

const SWAPPABLE: AppointmentStatus[] = ["BOOKED", "WAITING", "NOTIFIED"];

async function getPatientByUser(userId: string) {
  const patient = await prisma.patient.findFirst({ where: { userId } });
  if (!patient) throw AppError.notFound("Patient profile not found");
  return patient;
}

function maskName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.map((part) => part[0]?.toUpperCase() + ".").join(" ") || "Patient";
}

/**
 * Unique constraints on `(doctorId, slotStart)` and
 * `(doctorId, serviceDay, tokenNumber)` are checked row-by-row in Postgres, so
 * a direct two-row exchange would transiently collide. Park each appointment
 * on a per-id temporary value first, then move it to its final slot.
 */
function temporaryValues(id: string) {
  const digest = createHash("sha256").update(id).digest();
  return {
    slotStart: new Date(Date.UTC(9999, 0, 1) + (digest.readUInt32BE(0) % 1_000_000_000)),
    tokenNumber: -(digest.readUInt32BE(4) % 1_000_000_000) - 1,
  };
}

/** Row-level locks in a stable order prevent two swaps from claiming one slot. */
async function lockSwapRows(tx: Prisma.TransactionClient, ids: string[]) {
  const ordered = [...new Set(ids)].sort();
  for (const id of ordered) {
    await tx.$queryRaw`SELECT id FROM "Appointment" WHERE id = ${id} FOR UPDATE`;
  }
  const entries = await tx.queueEntry.findMany({
    where: { appointmentId: { in: ordered } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const entry of entries) {
    await tx.$queryRaw`SELECT id FROM "QueueEntry" WHERE id = ${entry.id} FOR UPDATE`;
  }
}

export async function listSwaps(auth: { userId: string; role: string }, role: "incoming" | "outgoing" | "all") {
  if (auth.role === "ADMIN" || auth.role === "STAFF") {
    return prisma.swapRequest.findMany({
      include: {
        requesterAppointment: { include: { doctor: true, patient: true } },
        targetAppointment: { include: { doctor: true, patient: true } },
        requesterPatient: true,
        targetPatient: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
  const patient = await getPatientByUser(auth.userId);
  const where: Prisma.SwapRequestWhereInput = {};
  if (role === "incoming") where.targetPatientId = patient.id;
  else if (role === "outgoing") where.requesterPatientId = patient.id;
  else where.OR = [{ targetPatientId: patient.id }, { requesterPatientId: patient.id }];
  return prisma.swapRequest.findMany({
    where,
    include: {
      requesterAppointment: { include: { doctor: { include: { department: true } }, patient: true } },
      targetAppointment: { include: { doctor: { include: { department: true } }, patient: true } },
      requesterPatient: true,
      targetPatient: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function eligibleForSwap(auth: { userId: string; role: string }, appointmentId: string) {
  if (auth.role !== "PATIENT") throw AppError.forbidden();
  const patient = await getPatientByUser(auth.userId);
  const mine = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: { doctor: true } });
  if (!mine) throw AppError.notFound("Appointment not found");
  if (mine.patientId !== patient.id) throw AppError.forbidden("Not your appointment");
  if (!SWAPPABLE.includes(mine.status)) throw AppError.conflict("CONFLICT", "Appointment is not eligible for swap");

  const candidates = await prisma.appointment.findMany({
    where: {
      doctorId: mine.doctorId,
      serviceDay: mine.serviceDay,
      patientId: { not: patient.id },
      status: { in: SWAPPABLE },
      swapsAsRequester: { none: { status: "PENDING" } },
      swapsAsTarget: { none: { status: "PENDING" } },
    },
    include: { patient: true },
    orderBy: { slotStart: "asc" },
    take: 30,
  });

  return candidates.map((appointment) => ({
    appointmentId: appointment.id,
    tokenNumber: appointment.tokenNumber,
    slotStart: appointment.slotStart,
    patientInitials: maskName(appointment.patient.fullName),
  }));
}

export async function createSwapRequest(
  auth: { userId: string; role: string },
  input: { requesterAppointmentId: string; targetAppointmentId: string; message?: string | null },
) {
  if (auth.role !== "PATIENT") throw AppError.forbidden();
  const patient = await getPatientByUser(auth.userId);
  const [requester, target] = await Promise.all([
    prisma.appointment.findUnique({ where: { id: input.requesterAppointmentId }, include: { queueEntry: true, doctor: true, patient: true } }),
    prisma.appointment.findUnique({ where: { id: input.targetAppointmentId }, include: { queueEntry: true, doctor: true } }),
  ]);
  if (!requester || !target) throw AppError.notFound("Appointment not found");
  if (requester.id === target.id) throw AppError.badRequest("An appointment cannot be swapped with itself");
  if (requester.patientId !== patient.id) throw AppError.forbidden("Not your appointment");
  if (requester.doctorId !== target.doctorId || requester.serviceDay !== target.serviceDay) {
    throw AppError.conflict("CONFLICT", "Swaps are only allowed for the same doctor and day");
  }
  if (!SWAPPABLE.includes(requester.status) || !SWAPPABLE.includes(target.status)) {
    throw AppError.conflict("CONFLICT", "One or both appointments are not eligible for swap");
  }
  const earlier = requester.slotStart < target.slotStart ? requester.slotStart : target.slotStart;
  if (earlier.getTime() - Date.now() < env.SWAP_CUTOFF_MINUTES * 60_000) {
    throw AppError.conflict("CONFLICT", "Swap cutoff time has passed");
  }

  let swapId: string;
  try {
    swapId = await prisma.$transaction(async (tx) => {
      await lockSwapRows(tx, [requester.id, target.id]);
      const pending = await tx.swapRequest.count({
        where: {
          status: "PENDING",
          OR: [
            { requesterAppointmentId: requester.id },
            { targetAppointmentId: requester.id },
            { requesterAppointmentId: target.id },
            { targetAppointmentId: target.id },
          ],
        },
      });
      if (pending > 0) throw AppError.conflict("CONFLICT", "One of these appointments already has a pending swap");
      const swap = await tx.swapRequest.create({
        data: {
          requesterAppointmentId: requester.id,
          targetAppointmentId: target.id,
          requesterPatientId: requester.patientId,
          targetPatientId: target.patientId,
          message: input.message ?? null,
          expiresAt: new Date(Date.now() + env.SWAP_EXPIRY_MINUTES * 60_000),
        },
      });
      return swap.id;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw AppError.conflict("CONFLICT", "One of these appointments already has a pending swap");
    }
    throw error;
  }

  const swap = await prisma.swapRequest.findUniqueOrThrow({
    where: { id: swapId },
    include: { requesterAppointment: { include: { doctor: true } }, targetAppointment: true, requesterPatient: true, targetPatient: true },
  });
  await enqueue(QUEUE_NAMES.swaps, jobIds.swapExpiry(swapId), { swapId }, { delay: env.SWAP_EXPIRY_MINUTES * 60_000 });
  socketEmitter.appointmentUpdated(target.patientId, { swapRequestId: swapId, type: "swap:requested" });
  socketEmitter.swapRequested(target.patientId, { swapRequestId: swapId, type: "swap:requested" });
  await notify({
    patientId: target.patientId,
    type: "SWAP_REQUESTED",
    title: "Swap request received",
    body: `${requester.patient.fullName} proposed a slot swap with ${requester.doctor.fullName}.`,
    dedupeKey: `swap-requested:${swapId}`,
    data: { swapId },
    channels: ["IN_APP", "WEB_PUSH"],
  });
  return swap;
}

export async function respondSwap(auth: { userId: string; role: string }, id: string, action: "ACCEPT" | "REJECT") {
  if (auth.role !== "PATIENT") throw AppError.forbidden();
  const patient = await getPatientByUser(auth.userId);
  const swap = await prisma.swapRequest.findUnique({ where: { id } });
  if (!swap) throw AppError.notFound("Swap request not found");
  if (swap.targetPatientId !== patient.id) throw AppError.forbidden("Not your swap request");

  if (action === "REJECT") {
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SwapRequest" WHERE id = ${id} FOR UPDATE`;
      const fresh = await tx.swapRequest.findUniqueOrThrow({ where: { id } });
      if (fresh.status !== "PENDING") throw AppError.conflict("CONFLICT", "Swap request is no longer pending");
      return tx.swapRequest.update({ where: { id }, data: { status: "REJECTED", respondedAt: new Date(), respondedByUserId: auth.userId } });
    });
    await notify({
      patientId: swap.requesterPatientId,
      type: "SWAP_REJECTED",
      title: "Swap request declined",
      body: "The other patient declined your swap proposal.",
      dedupeKey: `swap-rejected:${id}`,
      data: { swapId: id },
    });
    socketEmitter.appointmentUpdated(swap.requesterPatientId, { swapRequestId: id, type: "swap:responded", status: "REJECTED" });
    socketEmitter.swapResponded([swap.requesterPatientId], { swapRequestId: id, status: "REJECTED" });
    return updated;
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SwapRequest" WHERE id = ${id} FOR UPDATE`;
    const fresh = await tx.swapRequest.findUnique({
      where: { id },
      include: { requesterAppointment: { include: { queueEntry: true } }, targetAppointment: { include: { queueEntry: true } } },
    });
    if (!fresh || fresh.status !== "PENDING") throw AppError.conflict("CONFLICT", "Swap request is no longer pending");
    if (fresh.expiresAt.getTime() < Date.now()) throw AppError.conflict("CONFLICT", "Swap request has expired");
    const a = fresh.requesterAppointment;
    const b = fresh.targetAppointment;
    await lockSwapRows(tx, [a.id, b.id]);
    if (!SWAPPABLE.includes(a.status) || !SWAPPABLE.includes(b.status)) {
      throw AppError.conflict("CONFLICT", "Appointments are no longer eligible");
    }

    const tempA = temporaryValues(a.id);
    const tempB = temporaryValues(b.id);
    await tx.appointment.update({
      where: { id: a.id },
      data: { slotStart: tempA.slotStart, slotEnd: tempA.slotStart, tokenNumber: tempA.tokenNumber },
    });
    await tx.appointment.update({
      where: { id: b.id },
      data: { slotStart: tempB.slotStart, slotEnd: tempB.slotStart, tokenNumber: tempB.tokenNumber },
    });
    await tx.appointment.update({ where: { id: a.id }, data: { slotStart: b.slotStart, slotEnd: b.slotEnd, tokenNumber: b.tokenNumber } });
    await tx.appointment.update({ where: { id: b.id }, data: { slotStart: a.slotStart, slotEnd: a.slotEnd, tokenNumber: a.tokenNumber } });

    const aQueue = a.queueEntry;
    const bQueue = b.queueEntry;
    if (aQueue && bQueue) {
      await tx.queueEntry.update({ where: { id: aQueue.id }, data: { position: bQueue.position } });
      await tx.queueEntry.update({ where: { id: bQueue.id }, data: { position: aQueue.position } });
    }

    const updated = await tx.swapRequest.update({
      where: { id },
      data: { status: "ACCEPTED", respondedAt: new Date(), respondedByUserId: auth.userId },
      include: { requesterAppointment: { include: { doctor: true } }, targetAppointment: { include: { doctor: true } }, requesterPatient: true, targetPatient: true },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: auth.userId,
        action: "SWAP_ACCEPTED",
        entity: "SwapRequest",
        entityId: id,
        after: { requesterAppointmentId: a.id, targetAppointmentId: b.id } as Prisma.InputJsonValue,
      },
    });
    return updated;
  });

  await notify({
    patientId: result.requesterPatientId,
    type: "SWAP_ACCEPTED",
    title: "Swap accepted",
    body: "Your slot swap was accepted.",
    dedupeKey: `swap-accepted:${id}:requester`,
    data: { swapId: id },
    channels: ["IN_APP", "WEB_PUSH"],
  });
  await notify({
    patientId: result.targetPatientId,
    type: "SWAP_ACCEPTED",
    title: "Swap accepted",
    body: "Your slot swap was accepted.",
    dedupeKey: `swap-accepted:${id}:target`,
    data: { swapId: id },
    channels: ["IN_APP", "WEB_PUSH"],
  });
  socketEmitter.queueUpdated(result.requesterAppointment.doctorId, { doctorId: result.requesterAppointment.doctorId, serviceDay: result.requesterAppointment.serviceDay });
  socketEmitter.appointmentUpdated(result.requesterPatientId, { swapRequestId: id, type: "swap:responded", status: "ACCEPTED" });
  socketEmitter.appointmentUpdated(result.targetPatientId, { swapRequestId: id, type: "swap:responded", status: "ACCEPTED" });
  socketEmitter.swapResponded([result.requesterPatientId, result.targetPatientId], { swapRequestId: id, status: "ACCEPTED" });
  return result;
}

export async function cancelSwap(auth: { userId: string; role: string }, id: string) {
  const swap = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SwapRequest" WHERE id = ${id} FOR UPDATE`;
    const fresh = await tx.swapRequest.findUniqueOrThrow({ where: { id } });
    if (auth.role === "PATIENT") {
      const patient = await getPatientByUser(auth.userId);
      if (fresh.requesterPatientId !== patient.id) throw AppError.forbidden("Not your swap request");
    }
    if (fresh.status !== "PENDING") throw AppError.conflict("CONFLICT", "Swap request is no longer pending");
    return tx.swapRequest.update({ where: { id }, data: { status: "CANCELLED", respondedAt: new Date(), respondedByUserId: auth.userId } });
  });
  socketEmitter.appointmentUpdated(swap.targetPatientId, { swapRequestId: id, type: "swap:responded", status: "CANCELLED" });
  socketEmitter.swapResponded([swap.requesterPatientId, swap.targetPatientId], { swapRequestId: id, status: "CANCELLED" });
  return swap;
}

/** BullMQ processor and nightly sweep for expired requests. */
export async function expireSwap(swapId: string): Promise<void> {
  const swap = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SwapRequest" WHERE id = ${swapId} FOR UPDATE`;
    const fresh = await tx.swapRequest.findUnique({ where: { id: swapId } });
    if (!fresh || fresh.status !== "PENDING" || fresh.expiresAt.getTime() > Date.now()) return null;
    const updated = await tx.swapRequest.update({ where: { id: swapId }, data: { status: "EXPIRED", respondedAt: new Date() } });
    await tx.auditLog.create({ data: { action: "SWAP_EXPIRED", entity: "SwapRequest", entityId: swapId, after: { expiresAt: fresh.expiresAt.toISOString() } as Prisma.InputJsonValue } });
    return updated;
  });
  if (!swap) return;
  for (const patientId of [swap.requesterPatientId, swap.targetPatientId]) {
    await notify({
      patientId,
      type: "SWAP_EXPIRED",
      title: "Swap request expired",
      body: "The swap request expired before it was answered.",
      dedupeKey: `swap-expired:${swapId}:${patientId}`,
      data: { swapId },
    });
    socketEmitter.appointmentUpdated(patientId, { swapRequestId: swapId, type: "swap:responded", status: "EXPIRED" });
    socketEmitter.swapResponded([swap.requesterPatientId, swap.targetPatientId], { swapRequestId: swapId, status: "EXPIRED" });
  }
}

export async function expirePendingSwaps(): Promise<number> {
  const expired = await prisma.swapRequest.findMany({ where: { status: "PENDING", expiresAt: { lte: new Date() } }, select: { id: true } });
  for (const swap of expired) await expireSwap(swap.id);
  return expired.length;
}
