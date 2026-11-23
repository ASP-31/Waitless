import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma, type HardwareEvent } from "@prisma/client";
import { toDayKey } from "@waitless/shared";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { enqueue, jobIds, QUEUE_NAMES } from "../../jobs/schedulers";
import { notifyStaff } from "../notifications/notification.service";
import { completeConsultation } from "../queue/queue.service";
import { socketEmitter } from "../../sockets/emitter";
import { AppError } from "../../utils/errors";

export type HardwareEventType = "OCCUPIED" | "VACANT" | "HEARTBEAT";

// Newer Room/Consultation columns can be missing from a stale generated client
// in a fresh checkout. Intersections keep this module compiling against both.
type RoomUpdateWithStatus = Prisma.RoomUpdateInput & { status?: string };
type RoomUpdateManyWithStatus = Prisma.RoomUpdateManyMutationInput & { status?: string };
type RoomWhereWithStatus = Prisma.RoomWhereInput & { status?: string | { not?: string } };
type ConsultationUpdateWithSuggestion = Prisma.ConsultationUpdateInput & { suggestedEndAt?: Date | null };

export interface HardwareEventInput {
  /** Room code (preferred), or a room id when called internally. */
  roomId: string;
  type: HardwareEventType;
  ts?: string | number;
  seq?: string | number;
  sig?: string;
  payload?: Record<string, unknown>;
  /** Protocol version; defaults to 1 and is part of the signed body. */
  v?: number;
}

/**
 * Exact signing recipe (also documented in hardware/docs/contract.md):
 * JSON.stringify of an object with ONLY these keys, in this order:
 * { v, roomId, type, ts, seq }. Values are used as received (numbers stay
 * numbers, strings stay strings); `v` defaults to 1. UTF-8 bytes are HMAC'd
 * with SHA-256 using DEVICE_HMAC_SECRET and encoded as lowercase hex.
 */
export function canonicalEventJson(input: HardwareEventInput): string {
  return JSON.stringify({
    v: input.v ?? 1,
    roomId: input.roomId,
    type: input.type,
    ts: input.ts,
    seq: input.seq,
  });
}

export function signHardwareEvent(input: HardwareEventInput): string {
  return createHmac("sha256", env.DEVICE_HMAC_SECRET).update(canonicalEventJson(input), "utf8").digest("hex");
}

/** Throws AppError(401) for missing, malformed or mismatched signatures. */
export function verifyHardwareSignature(input: HardwareEventInput): void {
  if (input.ts === undefined || input.seq === undefined) {
    throw AppError.unauthorized("Signed events require ts and seq");
  }
  if (typeof input.sig !== "string" || !/^[0-9a-f]{64}$/i.test(input.sig)) {
    throw AppError.unauthorized("Missing or malformed device signature");
  }
  const expected = Buffer.from(signHardwareEvent(input), "hex");
  const received = Buffer.from(input.sig, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw AppError.unauthorized("Invalid device signature");
  }
}

/** All realtime traffic goes through the single emitter module. */
function emitOccupancy(doctorId: string | null, payload: Record<string, unknown>): void {
  if (doctorId) socketEmitter.queueUpdated(doctorId, { event: "hardware:occupancy", ...payload });
  socketEmitter.hardwareOccupancy(doctorId, payload);
}

async function safeNotifyStaff(title: string, body: string, data: Record<string, unknown>, dedupeScope: string): Promise<void> {
  try {
    await notifyStaff("QUEUE_UPDATED", title, body, data as Prisma.InputJsonValue, dedupeScope);
  } catch (error) {
    logger.warn({ err: error, dedupeScope }, "failed to send hardware staff alert");
  }
}

function todayKey(): string {
  return toDayKey(new Date(), env.HOSPITAL_TIMEZONE);
}

/**
 * Persist a signed device event and apply its advisory effects.
 * Occupancy never creates a consultation: it only associates an existing one
 * or raises a staff alert. Dedupe relies on the unique `dedupeKey`.
 */
export async function ingestHardwareEvent(
  input: HardwareEventInput,
): Promise<{ event: HardwareEvent | null; duplicate: boolean }> {
  verifyHardwareSignature(input);

  const room = await prisma.room.findFirst({
    where: { OR: [{ code: input.roomId }, { id: input.roomId }] },
  });
  if (!room) throw AppError.notFound("Room not found");

  const now = new Date();
  const parsedTs = input.ts === undefined ? now : new Date(input.ts);
  const occurredAt = Number.isNaN(parsedTs.getTime()) ? now : parsedTs;
  const seq = input.seq ?? Date.now();
  const dedupeKey = `${room.code}:${seq}:${input.type}`;

  const isOccupancy = input.type !== "HEARTBEAT";
  const lastOccupancy = isOccupancy
    ? await prisma.hardwareEvent.findFirst({
        where: { roomId: room.id, type: { in: ["OCCUPIED", "VACANT"] } },
        orderBy: { receivedAt: "desc" },
      })
    : null;
  const debounced =
    lastOccupancy !== null && now.getTime() - lastOccupancy.receivedAt.getTime() < env.SENSOR_DEBOUNCE_SECONDS * 1000;

  const doctor = isOccupancy && !debounced
    ? await prisma.doctor.findFirst({
        where: { roomId: room.id },
        select: { id: true, fullName: true },
      })
    : null;

  const entry = doctor
    ? await prisma.queueEntry.findFirst({
        where: { doctorId: doctor.id, serviceDay: todayKey(), status: "IN_CONSULTATION" },
        orderBy: { position: "asc" },
        select: { id: true, appointment: { select: { id: true, patientId: true } } },
      })
    : null;

  const consultation =
    entry && input.type === "VACANT"
      ? await prisma.consultation.findUnique({ where: { queueEntryId: entry.id } })
      : null;
  const openConsultation = Boolean(consultation && consultation.endedAt === null);

  let result: string;
  if (debounced) result = "DEBOUNCED";
  else if (input.type === "HEARTBEAT") result = "RECORDED";
  else if (input.type === "OCCUPIED") result = entry ? "ASSOCIATED" : "UNSCHEDULED_OCCUPANCY";
  else result = entry && openConsultation ? "SUGGESTED_END" : "RECORDED";

  try {
    const event = await prisma.hardwareEvent.create({
      data: {
        roomId: room.id,
        doctorId: doctor?.id ?? null,
        type: input.type,
        occurredAt,
        payload: input.payload ? (input.payload as Prisma.InputJsonValue) : Prisma.JsonNull,
        dedupeKey,
        processedAt: now,
        result,
      },
    });

    // A heartbeat (or any fresh event) proves the device is alive again.
    const roomUpdate: RoomUpdateWithStatus = {
      lastSeenAt: now,
      status: "ONLINE",
      ...(isOccupancy ? { lastEventAt: now } : {}),
    };
    await prisma.room.update({ where: { id: room.id }, data: roomUpdate });

    if (!debounced && isOccupancy) {
      if (input.type === "OCCUPIED") {
        if (entry) {
          emitOccupancy(doctor?.id ?? null, {
            type: "OCCUPIED",
            roomCode: room.code,
            eventId: event.id,
            entryId: entry.id,
            doctorId: doctor?.id ?? null,
          });
        } else {
          await safeNotifyStaff(
            "Unscheduled room occupancy",
            `${room.name} (${room.code}) became occupied but no consultation is in progress.`,
            { roomCode: room.code, eventId: event.id },
            `unscheduled-occupancy:${room.code}:${event.id}`,
          );
        }
      } else if (entry && openConsultation) {
        const suggestion: ConsultationUpdateWithSuggestion = { suggestedEndAt: now };
        await prisma.consultation.update({ where: { queueEntryId: entry.id }, data: suggestion });
        emitOccupancy(doctor?.id ?? null, {
          type: "VACANT",
          roomCode: room.code,
          eventId: event.id,
          entryId: entry.id,
          suggestedEndAt: now.toISOString(),
        });
        if (!env.HARDWARE_AUTO_COMPLETE) {
          await safeNotifyStaff(
            "Consultation finished?",
            `${room.name} (${room.code}) is vacant. Confirm the ending from the queue screen.`,
            { roomCode: room.code, eventId: event.id, entryId: entry.id },
            `vacancy:${room.code}:${event.id}`,
          );
        }
        try {
          await enqueue(
            QUEUE_NAMES.hardware,
            jobIds.vacancy(room.id),
            { roomId: room.id, eventId: event.id },
            { delay: env.AUTO_COMPLETE_DEBOUNCE_MINUTES * 60_000 },
          );
        } catch (error) {
          logger.warn({ err: error, roomId: room.id }, "failed to schedule vacancy check");
        }
      }
    }

    return { event, duplicate: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { event: null, duplicate: true };
    }
    throw error;
  }
}

/**
 * BullMQ processor for a delayed vacancy. Re-checks live state because a
 * patient may have re-entered (OCCUPIED) or staff may have ended the visit.
 */
export async function processVacancy(roomId: string): Promise<void> {
  const room = await prisma.room.findFirst({
    where: { OR: [{ id: roomId }, { code: roomId }] },
    include: { doctor: { select: { id: true } } },
  });
  if (!room) return;

  // Ignore heartbeats here: they would otherwise always be the "latest event".
  const latest = await prisma.hardwareEvent.findFirst({
    where: { roomId: room.id, type: { in: ["OCCUPIED", "VACANT"] } },
    orderBy: { receivedAt: "desc" },
  });
  if (!latest || latest.type !== "VACANT") return;

  const doctorId = room.doctor?.id ?? latest.doctorId;
  if (!doctorId) return;

  const entry = await prisma.queueEntry.findFirst({
    where: { doctorId, serviceDay: todayKey(), status: "IN_CONSULTATION" },
    orderBy: { position: "asc" },
    select: { id: true },
  });
  if (!entry) return;

  const consultation = await prisma.consultation.findUnique({ where: { queueEntryId: entry.id } });
  if (!consultation || consultation.endedAt !== null) return;

  if (!env.HARDWARE_AUTO_COMPLETE) {
    logger.debug({ roomId: room.id, entryId: entry.id }, "vacancy left for staff confirmation");
    return;
  }

  await completeConsultation(entry.id, null, "SENSOR");
  await prisma.hardwareEvent.update({ where: { id: latest.id }, data: { result: "AUTO_COMPLETED" } });
  logger.info({ roomCode: room.code, entryId: entry.id, endSource: "SENSOR" }, "sensor auto-completed consultation");
}

/** Maintenance job: stale devices degrade their room until a heartbeat returns. */
export async function deviceWatchdog(): Promise<number> {
  const cutoff = new Date(Date.now() - env.DEVICE_WATCHDOG_MINUTES * 60_000);
  const where: RoomWhereWithStatus = {
    isActive: true,
    status: { not: "DEGRADED" },
    OR: [{ lastSeenAt: { lt: cutoff } }, { lastSeenAt: null, createdAt: { lt: cutoff } }],
  };
  const data: RoomUpdateManyWithStatus = { status: "DEGRADED" };
  const result = await prisma.room.updateMany({ where, data });
  if (result.count > 0) {
    logger.warn({ count: result.count, cutoff: cutoff.toISOString() }, "rooms marked degraded by device watchdog");
  }
  return result.count;
}

export async function listRecentHardwareEvents(roomCode?: string) {
  const where = roomCode ? { room: { code: roomCode } } : {};
  return prisma.hardwareEvent.findMany({
    where,
    include: { room: true, doctor: true },
    orderBy: { receivedAt: "desc" },
    take: 20,
  });
}

export async function listRooms() {
  return prisma.room.findMany({
    include: { doctor: { select: { id: true, fullName: true, isActive: true } } },
    orderBy: { code: "asc" },
  });
}

export interface SimulateHardwareEventInput {
  roomId: string;
  type: HardwareEventType;
  ts?: string | number;
  seq?: string | number;
  payload?: Record<string, unknown>;
}

/** Demo helper: builds a correctly signed event for the admin "Simulate" button. */
export async function simulateHardwareEvent(input: SimulateHardwareEventInput) {
  const base = {
    v: 1,
    roomId: input.roomId,
    type: input.type,
    ts: input.ts ?? Date.now(),
    seq: input.seq ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  return ingestHardwareEvent({
    ...base,
    sig: signHardwareEvent(base),
    payload: { ...(input.payload ?? {}), source: "SIMULATOR" },
  });
}
