import { Router } from "express";
import { authenticate, authorize } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { analyticsRangeSchema, type AnalyticsRangeQuery } from "./analytics.schema";
import { getDoctorAnalytics, getOverview, renderAppointmentsCsv } from "./analytics.service";

/** Read-only hospital analytics. Every endpoint is staff/admin only. */
export const analyticsRouter: Router = Router();
analyticsRouter.use(authenticate, authorize("ADMIN", "STAFF"));

const range = (req: { query: unknown }) => req.query as AnalyticsRangeQuery;

/** GET /analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD */
analyticsRouter.get("/overview", validate(analyticsRangeSchema, "query"), async (req, res, next) => {
  try {
    res.json({ data: await getOverview(range(req)) });
  } catch (error) {
    next(error);
  }
});

/** GET /analytics/doctors?from=&to= — busiest doctors first. */
analyticsRouter.get("/doctors", validate(analyticsRangeSchema, "query"), async (req, res, next) => {
  try {
    res.json({ data: await getDoctorAnalytics(range(req)) });
  } catch (error) {
    next(error);
  }
});

/** GET /analytics/appointments.csv?from=&to= — staff-only export. */
analyticsRouter.get("/appointments.csv", validate(analyticsRangeSchema, "query"), async (req, res, next) => {
  try {
    const csv = await renderAppointmentsCsv(range(req));
    res.setHeader("Content-Disposition", 'attachment; filename="waitless-appointments.csv"');
    res.status(200).type("text/csv").send(csv);
  } catch (error) {
    next(error);
  }
});
