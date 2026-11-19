import { Prisma, type AppointmentStatus } from "@prisma/client";
import { ERROR_CODES, addDaysToDayKey, canCancel, toDayKey, zonedDateTimeToUtc } from "@waitless/shared";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { socketEmitter } from "../../sockets/emitter";
import { AppError } from "../../utils/errors";
import { normalizePhone, safeName } from "../../utils/phone";
import { notify } from "../notifications/notification.service";
import { ensureDayQueue, markArrived, recomputePositions } from "../queue/queue.service";

const ACTIVE_STATUSES = ["BOOKED", "WAITING", "NOTIFIED", "CALLED", "IN_CONSULTATION", "DELAYED"] as const;
const CHECK_IN_STATUSES = ["BOOKED", "WAITING", "NOTIFIED", "CALLED", "DELAYED", "SKIPPED"] as const;

function todayKey() {
  return toDayKey(new Date(), env.HOSPITAL_TIMEZONE);
}

type AuthCtx = { userId: string; role: "ADMIN" | "STAFF" | "PATIENT"; patientId?: string | null };

async function getPatientByUser(userId: string) {
  const patient = await prisma.patient.findFirst({ where: { userId } });
  if (!patient) throw AppError.notFound("Patient profile not found");
  return patient;
}

async function ensureSlotBookable(
  tx: Prisma.TransactionClient,
  doctorId: string,
  slotStart: Date,
  serviceDay: string,
  excludeAppointmentId?: string,
) {
  const doctor = await tx.doctor.findUnique({ where: { id: doctorId }, include: { department: true } });
  if (!doctor) throw AppError.notFound("Doctor not found");
  if (!doctor.isActive) throw AppError.conflict("CONFLICT", "Doctor is not active");
  if (!doctor.department.isActive) throw AppError.conflict("CONFLICT", "Department is not active");

  const horizon = addDaysToDayKey(todayKey(), env.SCHEDULE_HORIZON_DAYS);
  if (serviceDay < todayKey()) throw new AppError(ERROR_CODES.SLOT_PAST, "Cannot book a slot in the past");
  if (serviceDay > horizon) {
    throw new AppError(
      ERROR_CODES.BOOKING_HORIZON_EXCEEDED,
      `Appointments can only be booked ${env.SCHEDULE_HORIZON_DAYS} days ahead`,
    );
  }

  // Validate slot exists in availability for that day (simple check against schedules/exceptions via same logic as availability)
  const day = serviceDay;
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  const schedules = await tx.doctorSchedule.findMany({ where: { doctorId, dayOfWeek: weekday, isActive: true } });
  const exception = await tx.scheduleException.findUnique({ where: { doctorId_date: { doctorId, date: new Date(`${day}T00:00:00.000Z`) } } });

  let windows = schedules.map((s) => ({ startMinute: s.startMinute, endMinute: s.endMinute, slotMinutes: s.slotMinutes }));
  if (exception) {
    if (exception.isClosed) windows = [];
    else if (exception.startMinute != null && exception.endMinute != null) {
      windows = [{ startMinute: exception.startMinute, endMinute: exception.endMinute, slotMinutes: schedules[0]?.slotMinutes ?? 15 }];
    }
  }
  const slotMinute = (() => {
    // derive minute-of-day in hospital tz
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: env.HOSPITAL_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false });
    const parts = fmt.formatToParts(slotStart);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return h * 60 + m;
  })();

  const matchWindow = windows.find((w) => {
    if (slotMinute < w.startMinute || slotMinute >= w.endMinute) return false;
    return (slotMinute - w.startMinute) % w.slotMinutes === 0 && slotMinute + w.slotMinutes <= w.endMinute;
  });
  if (!matchWindow) throw AppError.badRequest("Selected slot is not available for this doctor");

  const slotEnd = zonedDateTimeToUtc(day, slotMinute + matchWindow.slotMinutes, env.HOSPITAL_TIMEZONE);

  const conflict = await tx.appointment.findFirst({
    where: {
      doctorId,
      slotStart,
      status: { in: [...ACTIVE_STATUSES] },
      ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
    },
    select: { id: true },
  });
  if (conflict) throw AppError.conflict("SLOT_TAKEN", "That time slot is no longer available");

  if (slotStart.getTime() <= Date.now()) {
    throw AppError.badRequest("Cannot book a slot in the past");
  }

  return { doctor, slotEnd, serviceDay: day, departmentId: doctor.departmentId };
}

async function allocateToken(tx: Prisma.TransactionClient, doctorId: string, serviceDay: string) {
  const agg = await tx.appointment.aggregate({
    where: { doctorId, serviceDay },
    _max: { tokenNumber: true },
  });
  return (agg._max.tokenNumber ?? 0) + 1;
}

export async function createAppointment(auth: AuthCtx, input: { doctorId: string; slotStart: string; notes?: string | null; source?: "QR" | "REMOTE" }) {
  if (auth.role !== "PATIENT" || !auth.patientId) throw AppError.forbidden("Only patients can book appointments");
  const slotStart = new Date(input.slotStart);
  if (Number.isNaN(slotStart.getTime())) throw AppError.badRequest("Invalid slotStart");
  const serviceDay = toDayKey(slotStart, env.HOSPITAL_TIMEZONE);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const appointment = await prisma.$transaction(async (tx) => {
        const { doctor, slotEnd, departmentId } = await ensureSlotBookable(tx, input.doctorId, slotStart, serviceDay);
        const tokenNumber = await allocateToken(tx, doctor.id, serviceDay);
        const appointment = await tx.appointment.create({
          data: {
            patientId: auth.patientId!,
            doctorId: doctor.id,
            departmentId,
            slotStart,
            slotEnd,
            serviceDay,
            tokenNumber,
            status: "BOOKED",
            source: input.source ?? "REMOTE",
            notes: input.notes ?? null,
            bookedByUserId: auth.userId,
          },
          include: {
            doctor: { include: { department: true, room: true } },
            patient: true,
            department: true,
          },
        });
        return appointment;
      });

      await notify({
        patientId: appointment.patientId,
        userId: auth.userId,
        appointmentId: appointment.id,
        type: "BOOKING_CONFIRMED",
        title: "Appointment booked",
        body: `Your appointment with ${appointment.doctor.fullName} is confirmed for ${serviceDay} (token #${appointment.tokenNumber}).`,
        data: { appointmentId: appointment.id, tokenNumber: appointment.tokenNumber, serviceDay },
        dedupeKey: `booking:${appointment.id}`,
      }).catch(() => undefined);
      socketEmitter.queueUpdated(appointment.doctorId, { doctorId: appointment.doctorId, serviceDay });
      socketEmitter.appointmentUpdated(appointment.patientId, { appointmentId: appointment.id, status: appointment.status });
      return appointment;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && attempt < 2) {
        continue;
      }
      throw err;
    }
  }
  throw AppError.conflict("CONFLICT", "Could not allocate a booking, please try again");
}

export async function createWalkIn(auth: AuthCtx, input: { doctorId: string; slotStart: string; patient: { fullName: string; phone: string }; notes?: string | null }) {
  if (auth.role !== "ADMIN" && auth.role !== "STAFF") throw AppError.forbidden("Only staff can register walk-ins");
  const slotStart = new Date(input.slotStart);
  if (Number.isNaN(slotStart.getTime())) throw AppError.badRequest("Invalid slotStart");
  const serviceDay = toDayKey(slotStart, env.HOSPITAL_TIMEZONE);
  const phone = normalizePhone(input.patient.phone);
  const fullName = safeName(input.patient.fullName);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const appointment = await prisma.$transaction(async (tx) => {
        let patient = await tx.patient.findUnique({ where: { phone } });
        if (!patient) {
          const user = await tx.user.create({ data: { role: "PATIENT", name: fullName, phone } });
          patient = await tx.patient.create({
            data: { userId: user.id, fullName, phone, notificationPrefs: { create: {} } },
          });
        } else if (patient.fullName !== fullName) {
          patient = await tx.patient.update({ where: { id: patient.id }, data: { fullName } });
        }

        const { doctor, slotEnd, departmentId } = await ensureSlotBookable(tx, input.doctorId, slotStart, serviceDay);
        const tokenNumber = await allocateToken(tx, doctor.id, serviceDay);
        const created = await tx.appointment.create({
          data: {
            patientId: patient.id,
            doctorId: doctor.id,
            departmentId,
            slotStart,
            slotEnd,
            serviceDay,
            tokenNumber,
            status: "BOOKED",
            source: "WALK_IN",
            notes: input.notes ?? null,
            bookedByUserId: auth.userId,
          },
          include: {
            doctor: { include: { department: true, room: true } },
            patient: true,
            department: true,
          },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: auth.userId,
            action: "APPOINTMENT_CREATED",
            entity: "Appointment",
            entityId: created.id,
            after: { source: "WALK_IN", tokenNumber, serviceDay } as unknown as Prisma.InputJsonValue,
          },
        });
        return created;
      });

      await notify({
        patientId: appointment.patientId,
        userId: appointment.patient.userId,
        appointmentId: appointment.id,
        type: "BOOKING_CONFIRMED",
        title: "Appointment booked at the desk",
        body: `Your appointment with ${appointment.doctor.fullName} is confirmed for ${serviceDay} (token #${appointment.tokenNumber}).`,
        data: { appointmentId: appointment.id, tokenNumber: appointment.tokenNumber, serviceDay, source: "WALK_IN" },
        dedupeKey: `booking:${appointment.id}`,
      }).catch(() => undefined);
      socketEmitter.queueUpdated(appointment.doctorId, { doctorId: appointment.doctorId, serviceDay });
      socketEmitter.appointmentUpdated(appointment.patientId, { appointmentId: appointment.id, status: appointment.status });
      return appointment;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && attempt < 2) continue;
      throw err;
    }
  }
  throw AppError.conflict("CONFLICT", "Could not allocate a booking, please try again");
}

export async function listAppointments(auth: AuthCtx, query: { date?: string; doctorId?: string; patientId?: string; status?: string; q?: string; page: number; pageSize: number }) {
  const where: Prisma.AppointmentWhereInput = {};
  if (auth.role === "PATIENT") {
    const patient = await getPatientByUser(auth.userId);
    where.patientId = patient.id;
  } else if (query.patientId) {
    where.patientId = query.patientId;
  }
  if (query.date) where.serviceDay = query.date;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.status) where.status = query.status as AppointmentStatus;
  if (query.q) {
    const or: Prisma.AppointmentWhereInput[] = [
      { patient: { fullName: { contains: query.q, mode: "insensitive" } } },
      { patient: { phone: { contains: query.q } } },
      { doctor: { fullName: { contains: query.q, mode: "insensitive" } } },
    ];
    const asNum = Number(query.q);
    if (Number.isInteger(asNum)) or.push({ tokenNumber: asNum });
    where.OR = or;
  }

  const [items, total] = await Promise.all([
    prisma.appointment.findMany({
      where,
      include: { doctor: { include: { department: true, room: true } }, department: true, patient: true, queueEntry: true },
      orderBy: [{ slotStart: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.appointment.count({ where }),
  ]);
  return { appointments: items, pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) } };
}

export async function getAppointmentById(auth: AuthCtx, id: string) {
  const appt = await prisma.appointment.findUnique({
    where: { id },
    include: { doctor: { include: { department: true, room: true } }, department: true, patient: true, queueEntry: true },
  });
  if (!appt) throw AppError.notFound("Appointment not found");
  if (auth.role === "PATIENT") {
    const patient = await getPatientByUser(auth.userId);
    if (appt.patientId !== patient.id) throw AppError.forbidden("You can only access your own appointments");
  }
  return appt;
}

export async function cancelAppointment(auth: AuthCtx, id: string, reason?: string) {
  const appt = await getAppointmentById(auth, id);
  if (!canCancel(appt.status)) {
    throw AppError.conflict("INVALID_TRANSITION", "This appointment can no longer be cancelled");
  }
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.appointment.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason ?? null },
      include: { doctor: { include: { department: true, room: true } }, department: true, patient: true, queueEntry: true },
    });
    if (next.queueEntry) {
      await tx.queueEntry.delete({ where: { id: next.queueEntry.id } });
    }
    // Freeing a slot shifts everyone behind it, so positions/ETAs are stale.
    await recomputePositions(tx, appt.doctorId, appt.serviceDay);
    await tx.auditLog.create({
      data: {
        actorUserId: auth.userId,
        action: "APPOINTMENT_CANCELLED",
        entity: "Appointment",
        entityId: id,
        before: { status: appt.status } as Prisma.InputJsonValue,
        after: { status: "CANCELLED", reason: reason ?? null } as Prisma.InputJsonValue,
      },
    });
    return next;
  });

  await notify({
    patientId: updated.patientId,
    appointmentId: updated.id,
    type: "APPOINTMENT_CANCELLED",
    title: "Appointment cancelled",
    body: `Your appointment with ${updated.doctor.fullName} on ${updated.serviceDay} has been cancelled.`,
    data: { appointmentId: updated.id, reason: reason ?? null },
    dedupeKey: `cancelled:${updated.id}`,
  }).catch(() => undefined);
  socketEmitter.queueUpdated(updated.doctorId, { doctorId: updated.doctorId, serviceDay: updated.serviceDay });
  socketEmitter.appointmentUpdated(updated.patientId, { appointmentId: updated.id, status: "CANCELLED" });
  return updated;
}

export async function rescheduleAppointment(auth: AuthCtx, id: string, slotStartIso: string, reason?: string) {
  if (auth.role !== "ADMIN" && auth.role !== "STAFF") throw AppError.forbidden("Only staff can reschedule appointments");
  const appt = await getAppointmentById(auth, id);
  if (!canCancel(appt.status)) throw AppError.conflict("INVALID_TRANSITION", "This appointment cannot be rescheduled");
  const slotStart = new Date(slotStartIso);
  if (Number.isNaN(slotStart.getTime())) throw AppError.badRequest("Invalid slotStart");
  const serviceDay = toDayKey(slotStart, env.HOSPITAL_TIMEZONE);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const updated = await prisma.$transaction(async (tx) => {
        // The appointment's own row must be excluded, otherwise moving to a
        // later slot on the same day would collide with itself.
        const { slotEnd, departmentId } = await ensureSlotBookable(
          tx,
          appt.doctorId,
          slotStart,
          serviceDay,
          id,
        );
        const tokenNumber = await allocateToken(tx, appt.doctorId, serviceDay);
        // Moving a NOTIFIED/DELAYED appointment to a new slot/day must clear the
        // old turn state, otherwise the entry stays "called" in the new queue.
        const nextStatus: AppointmentStatus = serviceDay === todayKey() ? "WAITING" : "BOOKED";
        const next = await tx.appointment.update({
          where: { id },
          data: {
            slotStart,
            slotEnd,
            serviceDay,
            tokenNumber,
            departmentId,
            status: nextStatus,
            notes: reason ? `${appt.notes ? appt.notes + "\n" : ""}Rescheduled: ${reason}` : appt.notes,
          },
          include: { doctor: { include: { department: true, room: true } }, department: true, patient: true, queueEntry: true },
        });
        if (next.queueEntry) {
          await tx.queueEntry.update({
            where: { id: next.queueEntry.id },
            data: {
              serviceDay,
              status: nextStatus,
              notifiedAt: null,
              calledAt: null,
              graceDeadlineAt: null,
              skippedReason: null,
            },
          });
        }
        await recomputePositions(tx, appt.doctorId, appt.serviceDay);
        if (serviceDay !== appt.serviceDay) {
          await recomputePositions(tx, appt.doctorId, serviceDay);
        }
        await tx.auditLog.create({
          data: {
            actorUserId: auth.userId,
            action: "APPOINTMENT_RESCHEDULED",
            entity: "Appointment",
            entityId: id,
            before: { slotStart: appt.slotStart.toISOString(), serviceDay: appt.serviceDay } as Prisma.InputJsonValue,
            after: { slotStart: slotStart.toISOString(), serviceDay } as Prisma.InputJsonValue,
          },
        });
        return next;
      });

      await notify({
        patientId: updated.patientId,
        appointmentId: updated.id,
        type: "BOOKING_CONFIRMED",
        title: "Appointment rescheduled",
        body: `Your appointment with ${updated.doctor.fullName} moved to ${serviceDay} (token #${updated.tokenNumber}).`,
        data: { appointmentId: updated.id, tokenNumber: updated.tokenNumber, serviceDay },
        dedupeKey: `rescheduled:${updated.id}:${slotStart.toISOString()}`,
      }).catch(() => undefined);
      socketEmitter.queueUpdated(updated.doctorId, { doctorId: updated.doctorId, serviceDay });
      if (serviceDay !== appt.serviceDay) {
        socketEmitter.queueUpdated(appt.doctorId, { doctorId: appt.doctorId, serviceDay: appt.serviceDay });
      }
      socketEmitter.appointmentUpdated(updated.patientId, { appointmentId: updated.id, status: updated.status });
      return updated;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && attempt < 2) continue;
      throw err;
    }
  }
  throw AppError.conflict("CONFLICT", "Could not reschedule appointment");
}

/**
 * Patient self check-in ("I'm here"). Staff may check in any appointment.
 * Delegates to the queue state machine so requeue-after-skip and call-again
 * behave exactly like the desk actions.
 */
export async function checkInAppointment(auth: AuthCtx, id: string) {
  const appt = await getAppointmentById(auth, id);
  if (appt.serviceDay !== todayKey()) {
    throw new AppError(ERROR_CODES.NOT_IN_QUEUE, "You can only check in on the day of your appointment");
  }
  if (!(CHECK_IN_STATUSES as readonly string[]).includes(appt.status)) {
    throw AppError.conflict("INVALID_TRANSITION", "This appointment cannot be checked in");
  }

  await ensureDayQueue(appt.doctorId, appt.serviceDay);
  const entry = await prisma.queueEntry.findUnique({ where: { appointmentId: appt.id } });
  if (!entry) throw AppError.notFound("Queue entry not found for this appointment");

  const updated = await markArrived(entry.id, auth.userId);
  const checkedInAt = appt.checkedInAt ?? new Date();
  await prisma.appointment.update({ where: { id: appt.id }, data: { checkedInAt } });
  if (!appt.checkedInAt) {
    await prisma.auditLog.create({
      data: {
        actorUserId: auth.userId,
        action: "APPOINTMENT_CHECKED_IN",
        entity: "Appointment",
        entityId: appt.id,
        after: { checkedInAt: checkedInAt.toISOString(), source: "PATIENT" } as Prisma.InputJsonValue,
      },
    });
  }
  return updated;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function exportAppointmentsCsv(
  auth: AuthCtx,
  query: { date?: string; doctorId?: string; status?: string; q?: string },
): Promise<string> {
  if (auth.role !== "ADMIN" && auth.role !== "STAFF") {
    throw AppError.forbidden("Only staff can export appointments");
  }
  const where: Prisma.AppointmentWhereInput = {};
  if (query.date) where.serviceDay = query.date;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.status) where.status = query.status as AppointmentStatus;
  if (query.q) {
    where.OR = [
      { patient: { fullName: { contains: query.q, mode: "insensitive" } } },
      { patient: { phone: { contains: query.q } } },
      { doctor: { fullName: { contains: query.q, mode: "insensitive" } } },
    ];
  }

  const rows = await prisma.appointment.findMany({
    where,
    include: { patient: true, doctor: { include: { department: true } } },
    orderBy: [{ serviceDay: "asc" }, { slotStart: "asc" }],
  });

  const header = [
    "appointmentId",
    "serviceDay",
    "slotStart",
    "tokenNumber",
    "status",
    "patientName",
    "patientPhone",
    "doctorName",
    "department",
    "source",
    "createdAt",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.serviceDay,
        row.slotStart.toISOString(),
        row.tokenNumber,
        row.status,
        row.patient.fullName,
        row.patient.phone,
        row.doctor.fullName,
        row.doctor.department?.name ?? "",
        row.source,
        row.createdAt.toISOString(),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
