import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { socketEmitter } from "../../sockets/emitter";
import { AppError } from "../../utils/errors";

type HardwareEventInput = {
  v?: number;
  roomId: string;
  type: "OCCUPIED" | "VACANT" | "HEARTBEAT";
  ts?: string | number;
  seq?: string | number;
  sig?: string;
  payload?: Record<string, unknown>;
};

/**
 * Optional HMAC-SHA256 signature over the canonical fields. Devices that do
 * not sign (including the simulator) are still accepted; when a signature is
 * present it must be valid so a rogue publisher on the broker cannot spoof
 * occupancy.
 */
function assertSignature(input: HardwareEventInput) {
  if (!input.sig) return;
  const canonical = `${input.v ?? 1}.${input.roomId}.${input.type}.${input.ts ?? ""}.${input.seq ?? ""}`;
  const expected = createHmac("sha256", env.DEVICE_HMAC_SECRET).update(canonical).digest("hex");
  const provided = Buffer.from(input.sig, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
    throw AppError.badRequest("Invalid hardware event signature");
  }
}

async function findRoom(roomId: string) {
  return (
    (await prisma.room.findUnique({ where: { code: roomId } })) ??
    (await prisma.room.findUnique({ where: { id: roomId } }))
  );
}

export async function ingestHardwareEvent(input: HardwareEventInput) {
  assertSignature(input);

  const room = await findRoom(input.roomId);
  if (!room) throw AppError.notFound("Room not found");

  const now = new Date();
  const occurredAt = input.ts !== undefined ? new Date(input.ts) : now;
  const occurred = Number.isNaN(occurredAt.getTime()) ? now : occurredAt;
  const seq = input.seq ?? now.getTime();
  const dedupeKey = `${room.code}:${seq}:${input.type}`;

  // Sensor flapping: ignore a repeat of the same state inside the debounce
  // window. Distinct seq values would otherwise create a burst of rows.
  if (input.type !== "HEARTBEAT" && env.SENSOR_DEBOUNCE_SECONDS > 0) {
    const recent = await prisma.hardwareEvent.findFirst({
      where: {
        roomId: room.id,
        type: input.type,
        receivedAt: { gte: new Date(now.getTime() - env.SENSOR_DEBOUNCE_SECONDS * 1000) },
      },
      select: { id: true },
    });
    if (recent) return { event: null, duplicate: true, debounced: true };
  }

  // Association: a room belongs to at most one doctor (Doctor.roomId unique).
  const doctor = await prisma.doctor.findFirst({
    where: { roomId: room.id },
    select: { id: true, fullName: true },
  });

  let result = "RECORDED";
  if (input.type === "VACANT" && doctor) {
    const active = await prisma.queueEntry.findFirst({
      where: { doctorId: doctor.id, status: "IN_CONSULTATION" },
      select: { id: true },
    });
    if (active) result = "SUGGESTED_END";
  }

  try {
    const event = await prisma.hardwareEvent.create({
      data: {
        roomId: room.id,
        doctorId: doctor?.id ?? null,
        type: input.type,
        occurredAt: occurred,
        payload: input.payload ? (input.payload as Prisma.InputJsonValue) : Prisma.JsonNull,
        dedupeKey,
        processedAt: now,
        result,
      },
    });
    await prisma.room.update({ where: { id: room.id }, data: { lastSeenAt: now } });
    socketEmitter.hardwareOccupancy(doctor?.id ?? null, {
      roomId: room.id,
      roomCode: room.code,
      type: input.type,
      result,
      doctorId: doctor?.id ?? null,
      receivedAt: now.toISOString(),
    });
    logger.debug({ room: room.code, type: input.type, result }, "hardware event ingested");
    return { event, duplicate: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { event: null, duplicate: true };
    }
    throw err;
  }
}

export async function listRecentHardwareEvents(roomCode?: string) {
  const where = roomCode ? { room: { code: roomCode } } : {};
  return prisma.hardwareEvent.findMany({
    where,
    include: { room: true, doctor: true },
    orderBy: { receivedAt: "desc" },
    take: 50,
  });
}

/**
 * Room-centric view for the admin hardware panel: assignment, last known
 * occupancy state and whether the device is still heartbeating.
 */
export async function listHardwareRooms() {
  const rooms = await prisma.room.findMany({
    where: { isActive: true },
    include: {
      doctor: { include: { department: true } },
      hardwareEvents: { orderBy: { receivedAt: "desc" }, take: 1 },
    },
    orderBy: { code: "asc" },
  });

  const staleCutoff = Date.now() - env.STALE_ROOM_MINUTES * 60_000;
  return rooms.map((room) => {
    const last = room.hardwareEvents[0] ?? null;
    const online = room.lastSeenAt ? room.lastSeenAt.getTime() >= staleCutoff : false;
    return {
      id: room.id,
      code: room.code,
      name: room.name,
      isActive: room.isActive,
      lastSeenAt: room.lastSeenAt,
      online,
      occupancy: last?.type === "OCCUPIED" ? "OCCUPIED" : last?.type === "VACANT" ? "VACANT" : "UNKNOWN",
      lastEvent: last
        ? {
            id: last.id,
            type: last.type,
            result: last.result,
            occurredAt: last.occurredAt,
            receivedAt: last.receivedAt,
          }
        : null,
      doctor: room.doctor
        ? {
            id: room.doctor.id,
            fullName: room.doctor.fullName,
            department: room.doctor.department?.name ?? null,
          }
        : null,
    };
  });
}
