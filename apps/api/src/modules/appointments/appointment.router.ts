import { Router } from "express";
import { authenticate, authorize } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import {
  appointmentCancelSchema,
  appointmentCreateSchema,
  appointmentListQuerySchema,
  appointmentRescheduleSchema,
  walkInSchema,
} from "./appointment.schema";
import {
  cancelAppointment,
  checkInAppointment,
  createAppointment,
  createWalkIn,
  exportAppointmentsCsv,
  getAppointmentById,
  listAppointments,
  rescheduleAppointment,
} from "./appointment.service";

export const appointmentRouter: Router = Router();

appointmentRouter.use(authenticate);

appointmentRouter.post("/", authorize("PATIENT"), validate(appointmentCreateSchema), async (req, res, next) => {
  try {
    const appointment = await createAppointment(req.auth!, req.body);
    res.status(201).json({ data: { appointment } });
  } catch (error) {
    next(error);
  }
});

appointmentRouter.post("/walk-in", authorize("ADMIN", "STAFF"), validate(walkInSchema), async (req, res, next) => {
  try {
    const appointment = await createWalkIn(req.auth!, req.body);
    res.status(201).json({ data: { appointment } });
  } catch (error) {
    next(error);
  }
});

appointmentRouter.get("/", validate(appointmentListQuerySchema, "query"), async (req, res, next) => {
  try {
    const result = await listAppointments(req.auth!, req.query as unknown as Parameters<typeof listAppointments>[1]);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

appointmentRouter.get("/export", authorize("ADMIN", "STAFF"), async (req, res, next) => {
  try {
    const query = req.query as { date?: string; doctorId?: string; status?: string; q?: string };
    const csv = await exportAppointmentsCsv(req.auth!, query);
    res
      .status(200)
      .setHeader("Content-Type", "text/csv; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename="appointments-${query.date ?? "all"}.csv"`)
      .send(csv);
  } catch (error) {
    next(error);
  }
});

const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

appointmentRouter.get("/:id", async (req, res, next) => {
  try {
    const appointment = await getAppointmentById(req.auth!, param(req.params.id));
    res.json({ data: { appointment } });
  } catch (error) {
    next(error);
  }
});

appointmentRouter.patch("/:id/cancel", validate(appointmentCancelSchema), async (req, res, next) => {
  try {
    const appointment = await cancelAppointment(req.auth!, param(req.params.id), req.body.reason);
    res.json({ data: { appointment } });
  } catch (error) {
    next(error);
  }
});

appointmentRouter.patch("/:id/reschedule", authorize("ADMIN", "STAFF"), validate(appointmentRescheduleSchema), async (req, res, next) => {
  try {
    const appointment = await rescheduleAppointment(req.auth!, param(req.params.id), req.body.slotStart, req.body.reason);
    res.json({ data: { appointment } });
  } catch (error) {
    next(error);
  }
});

appointmentRouter.post("/:id/check-in", async (req, res, next) => {
  try {
    const entry = await checkInAppointment(req.auth!, param(req.params.id));
    res.json({ data: { entry } });
  } catch (error) {
    next(error);
  }
});
