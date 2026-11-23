import { Router } from "express";
import { authenticate, authorize } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { auditQuerySchema, type AuditQuery } from "./admin.schema";
import { getJobsOverview, listAuditLogs } from "./admin.service";

/** Read-only admin oversight endpoints. */
export const adminRouter: Router = Router();
adminRouter.use(authenticate, authorize("ADMIN", "STAFF"));

/** GET /admin/audit — paginated, filterable audit trail. */
adminRouter.get("/audit", validate(auditQuerySchema, "query"), async (req, res, next) => {
  try {
    res.json({ data: await listAuditLogs(req.query as unknown as AuditQuery) });
  } catch (error) {
    next(error);
  }
});

/** GET /admin/jobs — BullMQ queue counts and recent failures. */
adminRouter.get("/jobs", async (_req, res, next) => {
  try {
    res.json({ data: await getJobsOverview() });
  } catch (error) {
    next(error);
  }
});
