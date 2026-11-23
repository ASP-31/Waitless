import { Router } from "express";
import { authenticate, authorize } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { queueActionSchema, queueQuerySchema, queueReorderSchema } from "./queue.schema";
import {
  callPatient,
  completeConsultation,
  getQueue,
  markArrived,
  markNoShow,
  reorder,
  selfCheckIn,
  skipPatient,
  startConsultation,
} from "./queue.service";

export const queueRouter: Router = Router();
queueRouter.use(authenticate);

const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

queueRouter.get("/:doctorId", validate(queueQuerySchema, "query"), async (req, res, next) => {
  try {
    const data = await getQueue(param(req.params.doctorId), (req.query as { date?: string }).date);
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

queueRouter.patch("/entries/:id/call", authorize("ADMIN", "STAFF"), validate(queueActionSchema), async (req, res, next) => {
  try {
    const entry = await callPatient(param(req.params.id), req.auth!.userId, req.body.reason);
    res.json({ data: { entry } });
  } catch (error) {
    next(error);
  }
});

queueRouter.patch("/entries/:id/start", authorize("ADMIN", "STAFF"), validate(queueActionSchema), async (req, res, next) => {
  try {
    const entry = await startConsultation(param(req.params.id), req.auth!.userId, req.body.reason);
    res.json({ data: { entry } });
  } catch (error) {
    next(error);
  }
});

queueRouter.patch("/entries/:id/complete", authorize("ADMIN", "STAFF"), validate(queueActionSchema), async (req, res, next) => {
  try {
    const entry = await completeConsultation(param(req.params.id), req.auth!.userId, "STAFF", req.body.reason);
    res.json({ data: { entry } });
  } catch (error) {
    next(error);
  }
});

queueRouter.patch("/entries/:id/skip", authorize("ADMIN", "STAFF"), validate(queueActionSchema), async (req, res, next) => {
  try {
    const entry = await skipPatient(param(req.params.id), req.auth!.userId, req.body.reason);
    res.json({ data: { entry } });
  } catch (error) {
    next(error);
  }
});

queueRouter.patch("/entries/:id/arrive", authorize("ADMIN", "STAFF"), validate(queueActionSchema), async (req, res, next) => {
  try {
    const entry = await markArrived(param(req.params.id), req.auth!.userId, req.body.reason);
    res.json({ data: { entry } });
  } catch (error) {
    next(error);
  }
});

queueRouter.patch("/entries/:id/reorder", authorize("ADMIN", "STAFF"), validate(queueReorderSchema), async (req, res, next) => {
  try {
    const entry = await reorder(param(req.params.id), req.body.position, req.auth!.userId, req.body.reason);
    res.json({ data: { entry } });
  } catch (error) {
    next(error);
  }
});

queueRouter.patch("/entries/:id/no-show", authorize("ADMIN", "STAFF"), validate(queueActionSchema), async (req, res, next) => {
  try {
    const entry = await markNoShow(param(req.params.id), req.auth!.userId, req.body.reason);
    res.json({ data: { entry } });
  } catch (error) {
    next(error);
  }
});

queueRouter.post("/entries/:id/check-in", authorize("PATIENT"), async (req, res, next) => {
  try {
    const entry = await selfCheckIn(param(req.params.id), req.auth!);
    res.json({ data: { entry } });
  } catch (error) {
    next(error);
  }
});
