import { Router } from "express";
import { authenticate, authorize } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { auditQuerySchema } from "./admin.schema";
import { getJobStatus, listAuditLogs } from "./admin.service";

export const adminRouter: Router = Router();
adminRouter.use(authenticate, authorize("ADMIN", "STAFF"));

adminRouter.get("/audit", validate(auditQuerySchema, "query"), async (req, res, next) => {
  try {
    const data = await listAuditLogs(req.query as unknown as Parameters<typeof listAuditLogs>[0]);
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/jobs", async (_req, res, next) => {
  try {
    const data = await getJobStatus();
    res.json({ data });
  } catch (error) {
    next(error);
  }
});
