import { AuditActionSchema } from "@waitless/shared";
import { z } from "zod";

const dayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

/** Filters and pagination accepted by `GET /admin/audit`. */
export const auditQuerySchema = z.object({
  entity: z.string().trim().min(1).optional(),
  action: AuditActionSchema.optional(),
  actorUserId: z.string().trim().min(1).optional(),
  from: dayKeySchema.optional(),
  to: dayKeySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;
