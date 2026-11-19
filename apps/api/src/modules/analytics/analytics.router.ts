import { Router } from "express";
import { authenticate, authorize } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { analyticsQuerySchema } from "./analytics.schema";
import { getDoctorStats, getOverview } from "./analytics.service";

export const analyticsRouter: Router = Router();
analyticsRouter.use(authenticate, authorize("ADMIN", "STAFF"));

analyticsRouter.get("/overview", validate(analyticsQuerySchema, "query"), async (req, res, next) => {
  try {
    const data = await getOverview(req.query as { from?: string; to?: string });
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

analyticsRouter.get("/doctors", validate(analyticsQuerySchema, "query"), async (req, res, next) => {
  try {
    const data = await getDoctorStats(req.query as { from?: string; to?: string });
    res.json({ data: { doctors: data } });
  } catch (error) {
    next(error);
  }
});
