import { z } from "zod";

export const queueQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Free-text staff explanation for a manual queue override. */
const reasonField = z.string().trim().max(300).optional();

export const queueActionSchema = z
  .object({
    reason: reasonField,
  })
  .default({});

export const queueReorderSchema = z.object({
  position: z.coerce.number().int().positive(),
  reason: reasonField,
});
