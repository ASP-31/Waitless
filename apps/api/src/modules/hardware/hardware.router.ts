import { Router } from "express";
import { authenticate, authorize } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import {
  hardwareEventSchema,
  hardwareQuerySchema,
  simulateSchema,
  type HardwareEventDto,
} from "./hardware.schema";
import {
  ingestHardwareEvent,
  listRecentHardwareEvents,
  listRooms,
  simulateHardwareEvent,
} from "./hardware.service";

export const hardwareRouter: Router = Router();

// Public device endpoint: authenticity comes from the HMAC signature.
hardwareRouter.post("/events", validate(hardwareEventSchema), async (req, res, next) => {
  try {
    const result = await ingestHardwareEvent(req.body as HardwareEventDto);
    res.status(result.duplicate ? 200 : 201).json({ data: result });
  } catch (error) {
    next(error);
  }
});

hardwareRouter.get("/events", authenticate, authorize("ADMIN", "STAFF"), validate(hardwareQuerySchema, "query"), async (req, res, next) => {
  try {
    const room = typeof req.query.room === "string" ? req.query.room : undefined;
    const events = await listRecentHardwareEvents(room);
    res.json({ data: { events } });
  } catch (error) {
    next(error);
  }
});

hardwareRouter.get("/rooms", authenticate, authorize("ADMIN", "STAFF"), async (_req, res, next) => {
  try {
    const rooms = await listRooms();
    res.json({ data: { rooms } });
  } catch (error) {
    next(error);
  }
});

hardwareRouter.get("/rooms/:code/events", authenticate, authorize("ADMIN", "STAFF"), async (req, res, next) => {
  try {
    const code = req.params.code;
    const events = await listRecentHardwareEvents(Array.isArray(code) ? code[0] : code);
    res.json({ data: { events } });
  } catch (error) {
    next(error);
  }
});

hardwareRouter.post("/simulate", authenticate, authorize("ADMIN", "STAFF"), validate(simulateSchema), async (req, res, next) => {
  try {
    const result = await simulateHardwareEvent(req.body);
    res.status(result.duplicate ? 200 : 201).json({ data: result });
  } catch (error) {
    next(error);
  }
});
