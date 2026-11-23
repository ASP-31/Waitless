import { z } from "zod";

/** Hospital-local day key (`YYYY-MM-DD`) used by every analytics window. */
export const dayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

/**
 * Query contract shared by the analytics endpoints. Both bounds are inclusive
 * and expressed as hospital-local day keys; the service resolves omitted
 * bounds to "today" using `env.HOSPITAL_TIMEZONE`.
 */
export const analyticsRangeSchema = z.object({
  from: dayKeySchema.optional(),
  to: dayKeySchema.optional(),
});

export type AnalyticsRangeQuery = z.infer<typeof analyticsRangeSchema>;
