import { z } from "zod";
import { toDayKey } from "@waitless/shared";
import { env } from "../../config/env";
import { AppError } from "../../utils/errors";

export const analyticsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export function resolveRange(query: AnalyticsQuery) {
  const today = toDayKey(new Date(), env.HOSPITAL_TIMEZONE);
  const to = query.to ?? today;
  const from = query.from ?? to;
  if (from > to) {
    throw AppError.badRequest("`from` must be on or before `to`");
  }
  return { from, to };
}
