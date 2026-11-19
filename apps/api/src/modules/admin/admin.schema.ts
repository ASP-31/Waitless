import { z } from "zod";
import { AUDIT_ACTIONS } from "@waitless/shared";

export const auditQuerySchema = z.object({
  action: z.enum(AUDIT_ACTIONS).optional(),
  entity: z.string().trim().max(80).optional(),
  actorUserId: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
});
