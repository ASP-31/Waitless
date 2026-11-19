import { Prisma, type AppointmentStatus } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { socketEmitter } from "../../sockets/emitter";
import { AppError } from "../../utils/errors";
import { notify } from "../notifications/notification.service";
import { recomputePositions } from "../queue/queue.service";

const SWAPPABLE: AppointmentStatus[] = ["BOOKED", "WAITING", "NOTIFIED"];

async function getPatientByUser(userId: string) {
  const p = await prisma.patient.findFirst({ where: { userId } });
  if (!p) throw AppError.notFound("Patient profile not found");
  return p;
}

function maskName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.map((p) => p[0]?.toUpperCase() + ".").join(" ") || "Patient";
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
    // Patient-facing rows deliberately omit patient relations: a swap only
    // needs tokens, slots and the doctor, never the other patient's identity.
    include: {
      requesterAppointment: { include: { doctor: { include: { department: true } } } },
      targetAppointment: { include: { doctor: { include: { department: true } } } },
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

  // A swap is only actionable while both slots are still ahead of the cutoff.
  const cutoff = new Date(Date.now() + env.SWAP_CUTOFF_MINUTES * 60_000);
  if (mine.slotStart < cutoff) return [];

  const candidates = await prisma.appointment.findMany({
    where: {
      doctorId: mine.doctorId,
      serviceDay: mine.serviceDay,
      patientId: { not: patient.id },
      status: { in: SWAPPABLE },
      slotStart: { gte: cutoff },
      swapsAsRequester: { none: { status: "PENDING" } },
      swapsAsTarget: { none: { status: "PENDING" } },
    },
    include: { patient: true },
    orderBy: { slotStart: "asc" },
    take: 30,
  });

  return candidates.map((a) => ({
    appointmentId: a.id,
    tokenNumber: a.tokenNumber,
    slotStart: a.slotStart,
    patientInitials: maskName(a.patient.fullName),
  }));
}

export async function createSwapRequest(auth: { userId: string; role: string }, input: { requesterAppointmentId: string; targetAppointmentId: string; message?: string | null }) {
  if (auth.role !== "PATIENT") throw AppError.forbidden();
  const patient = await getPatientByUser(auth.userId);
  const [reqAppt, tgtAppt] = await Promise.all([
    prisma.appointment.findUnique({ where: { id: input.requesterAppointmentId }, include: { queueEntry: true } }),
    prisma.appointment.findUnique({ where: { id: input.targetAppointmentId }, include: { queueEntry: true } }),
  ]);
  if (!reqAppt || !tgtAppt) throw AppError.notFound("Appointment not found");
  if (reqAppt.patientId !== patient.id) throw AppError.forbidden("Not your appointment");
  if (tgtAppt.patientId === patient.id) throw AppError.conflict("CONFLICT", "You cannot swap with your own appointment");
  if (reqAppt.doctorId !== tgtAppt.doctorId || reqAppt.serviceDay !== tgtAppt.serviceDay) {
    throw AppError.conflict("CONFLICT", "Swaps are only allowed for the same doctor and day");
  }
  if (!SWAPPABLE.includes(reqAppt.status) || !SWAPPABLE.includes(tgtAppt.status)) {
    throw AppError.conflict("CONFLICT", "One or both appointments are not eligible for swap");
  }
  const earlier = reqAppt.slotStart < tgtAppt.slotStart ? reqAppt.slotStart : tgtAppt.slotStart;
  if (earlier.getTime() - Date.now() < env.SWAP_CUTOFF_MINUTES * 60_000) {
    throw AppError.conflict("CONFLICT", "Swap cutoff time has passed");
  }
  const pendingCount = await prisma.swapRequest.count({
    where: {
      status: "PENDING",
      OR: [
        { requesterAppointmentId: reqAppt.id },
        { targetAppointmentId: reqAppt.id },
        { requesterAppointmentId: tgtAppt.id },
        { targetAppointmentId: tgtAppt.id },
      ],
    },
  });
  if (pendingCount > 0) throw AppError.conflict("CONFLICT", "One of these appointments already has a pending swap");

  const expiresAt = new Date(Date.now() + env.SWAP_EXPIRY_MINUTES * 60_000);
  let swap;
  try {
    swap = await prisma.swapRequest.create({
      data: {
        requesterAppointmentId: reqAppt.id,
        targetAppointmentId: tgtAppt.id,
        requesterPatientId: reqAppt.patientId,
        targetPatientId: tgtAppt.patientId,
        message: input.message ?? null,
        expiresAt,
      },
      include: {
        requesterAppointment: { include: { doctor: true } },
        targetAppointment: { include: { doctor: true } },
        requesterPatient: true,
        targetPatient: true,
      },
    });
  } catch (error) {
    // Partial unique indexes guard concurrent duplicate requests.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw AppError.conflict("CONFLICT", "One of these appointments already has a pending swap");
    }
    throw error;
  }

  await notify({
    patientId: tgtAppt.patientId,
    appointmentId: tgtAppt.id,
    type: "SWAP_REQUESTED",
    title: "Swap request received",
    body: `${maskName(swap.requesterPatient.fullName)} wants to swap token #${reqAppt.tokenNumber} with your token #${tgtAppt.tokenNumber}. You have until ${expiresAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} to respond.`,
    data: { swapRequestId: swap.id, appointmentId: tgtAppt.id },
    dedupeKey: `swap-requested:${swap.id}`,
  }).catch(() => undefined);
  socketEmitter.appointmentUpdated(tgtAppt.patientId, { swapRequestId: swap.id, type: "SWAP_REQUESTED" });
  return swap;
}

export async function respondSwap(auth: { userId: string; role: string }, id: string, action: "ACCEPT" | "REJECT") {
  if (auth.role !== "PATIENT") throw AppError.forbidden();
  const patient = await getPatientByUser(auth.userId);
  const swap = await prisma.swapRequest.findUnique({
    where: { id },
    include: {
      requesterAppointment: { include: { queueEntry: true } },
      targetAppointment: { include: { queueEntry: true } },
      requesterPatient: true,
      targetPatient: true,
    },
  });
  if (!swap) throw AppError.notFound("Swap request not found");
  if (swap.targetPatientId !== patient.id) throw AppError.forbidden("Not your swap request");
  if (swap.status !== "PENDING") throw AppError.conflict("CONFLICT", "Swap request is no longer pending");
  if (swap.expiresAt.getTime() < Date.now()) {
    await prisma.swapRequest.update({ where: { id }, data: { status: "EXPIRED", respondedAt: new Date() } });
    throw AppError.conflict("CONFLICT", "Swap request has expired");
  }

  if (action === "REJECT") {
    const updated = await prisma.swapRequest.update({
      where: { id },
      data: { status: "REJECTED", respondedAt: new Date(), respondedByUserId: auth.userId },
    });
    await notify({
      patientId: swap.requesterPatientId,
      appointmentId: swap.requesterAppointmentId,
      type: "SWAP_REJECTED",
      title: "Swap request declined",
      body: `${maskName(swap.targetPatient.fullName)} declined your swap request. Your appointment is unchanged.`,
      data: { swapRequestId: id },
      dedupeKey: `swap-rejected:${id}`,
    }).catch(() => undefined);
    socketEmitter.appointmentUpdated(swap.requesterPatientId, { swapRequestId: id, type: "SWAP_REJECTED" });
    return updated;
  }

  // ACCEPT - exchange slots and tokens atomically.
  //
  // Both rows are active, so the unique (doctorId, slotStart) and
  // (doctorId, serviceDay, tokenNumber) indexes reject a direct swap (A would
  // collide with B and vice versa). Move both rows to temporary unique values
  // first, then write the final values.
  const result = await prisma.$transaction(async (tx) => {
    const fresh = await tx.swapRequest.findUnique({
      where: { id },
      include: {
        requesterAppointment: { include: { queueEntry: true } },
        targetAppointment: { include: { queueEntry: true } },
        requesterPatient: true,
        targetPatient: true,
      },
    });
    if (!fresh || fresh.status !== "PENDING") throw AppError.conflict("CONFLICT", "Swap request is no longer pending");
    if (fresh.expiresAt.getTime() < Date.now()) throw AppError.conflict("CONFLICT", "Swap request has expired");

    const a = fresh.requesterAppointment;
    const b = fresh.targetAppointment;
    if (!SWAPPABLE.includes(a.status) || !SWAPPABLE.includes(b.status)) {
      throw AppError.conflict("CONFLICT", "Appointments are no longer eligible");
    }

    const tempA = new Date("2100-01-01T00:00:00.000Z");
    const tempB = new Date("2100-01-02T00:00:00.000Z");
    await tx.appointment.update({
      where: { id: a.id },
      data: { slotStart: tempA, slotEnd: tempA, tokenNumber: -1 },
    });
    await tx.appointment.update({
      where: { id: b.id },
      data: { slotStart: tempB, slotEnd: tempB, tokenNumber: -2 },
    });
    await tx.appointment.update({
      where: { id: a.id },
      data: { slotStart: b.slotStart, slotEnd: b.slotEnd, tokenNumber: b.tokenNumber },
    });
    await tx.appointment.update({
      where: { id: b.id },
      data: { slotStart: a.slotStart, slotEnd: a.slotEnd, tokenNumber: a.tokenNumber },
    });

    // Queue order follows slot time, so recompute both entries' positions.
    if (a.queueEntry || b.queueEntry) {
      await recomputePositions(tx, a.doctorId, a.serviceDay);
    }

    const updated = await tx.swapRequest.update({
      where: { id },
      data: { status: "ACCEPTED", respondedAt: new Date(), respondedByUserId: auth.userId },
      include: {
        requesterAppointment: { include: { doctor: true } },
        targetAppointment: { include: { doctor: true } },
        requesterPatient: true,
        targetPatient: true,
      },
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

  // After the exchange each appointment holds the other side's original token.
  const requesterToken = result.requesterAppointment.tokenNumber;
  const targetToken = result.targetAppointment.tokenNumber;
  await notify({
    patientId: result.requesterPatientId,
    appointmentId: result.requesterAppointmentId,
    type: "SWAP_ACCEPTED",
    title: "Swap confirmed",
    body: `Your swap was accepted. Your new token is #${requesterToken}.`,
    data: { swapRequestId: id },
    dedupeKey: `swap-accepted:${id}:${result.requesterPatientId}`,
  }).catch(() => undefined);
  await notify({
    patientId: result.targetPatientId,
    appointmentId: result.targetAppointmentId,
    type: "SWAP_ACCEPTED",
    title: "Swap confirmed",
    body: `You accepted a swap. Your new token is #${targetToken}.`,
    data: { swapRequestId: id },
    dedupeKey: `swap-accepted:${id}:${result.targetPatientId}`,
  }).catch(() => undefined);

  socketEmitter.queueUpdated(result.requesterAppointment.doctorId, {
    doctorId: result.requesterAppointment.doctorId,
    serviceDay: result.requesterAppointment.serviceDay,
  });
  socketEmitter.appointmentUpdated(swap.requesterPatientId, { swapRequestId: id, type: "SWAP_ACCEPTED" });
  socketEmitter.appointmentUpdated(swap.targetPatientId, { swapRequestId: id, type: "SWAP_ACCEPTED" });
  return result;
}

export async function cancelSwap(auth: { userId: string; role: string }, id: string) {
  const swap = await prisma.swapRequest.findUnique({
    where: { id },
    include: { targetPatient: true },
  });
  if (!swap) throw AppError.notFound("Swap request not found");
  if (auth.role === "PATIENT") {
    const patient = await getPatientByUser(auth.userId);
    if (swap.requesterPatientId !== patient.id) throw AppError.forbidden("Not your swap request");
  }
  if (swap.status !== "PENDING") throw AppError.conflict("CONFLICT", "Swap request is no longer pending");
  const updated = await prisma.swapRequest.update({
    where: { id },
    data: { status: "CANCELLED", respondedAt: new Date(), respondedByUserId: auth.userId },
  });

  const recipients =
    auth.role === "PATIENT" ? [swap.targetPatientId] : [swap.requesterPatientId, swap.targetPatientId];
  for (const patientId of recipients) {
    await notify({
      patientId,
      type: "SWAP_REJECTED",
      title: "Swap request withdrawn",
      body: "A swap request involving your appointment was withdrawn. Your appointment is unchanged.",
      data: { swapRequestId: id },
      dedupeKey: `swap-cancelled:${id}:${patientId}`,
    }).catch(() => undefined);
    socketEmitter.appointmentUpdated(patientId, { swapRequestId: id, type: "SWAP_CANCELLED" });
  }
  return updated;
}
