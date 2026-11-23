import { z } from "zod";

const eventTypeSchema = z.enum(["OCCUPIED", "VACANT", "HEARTBEAT"]);
const eventScalarSchema = z.union([z.string().min(1), z.number()]);
const eventPayloadSchema = z.record(z.string(), z.unknown());

/**
 * Signed device event. `sig`, `ts` and `seq` are intentionally optional at the
 * transport layer: the service returns 401 (not a validation error) when a
 * signature is missing or malformed.
 */
export const hardwareEventSchema = z.object({
  v: z.number().int().default(1),
  roomId: z.string().min(1),
  type: eventTypeSchema,
  ts: eventScalarSchema.optional(),
  seq: eventScalarSchema.optional(),
  sig: z.string().optional(),
  payload: eventPayloadSchema.optional(),
});

export type HardwareEventDto = z.infer<typeof hardwareEventSchema>;

export const simulateSchema = z.object({
  roomId: z.string().min(1),
  type: eventTypeSchema.default("OCCUPIED"),
  ts: eventScalarSchema.optional(),
  seq: eventScalarSchema.optional(),
  payload: eventPayloadSchema.optional(),
});

/** Alias kept for callers that prefer the longer name. */
export const simulateHardwareEventSchema = simulateSchema;

export const hardwareQuerySchema = z.object({
  room: z.string().min(1).optional(),
});

export const roomCodeParamsSchema = z.object({
  code: z.string().min(1),
});
