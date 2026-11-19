import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/prisma";
import { authenticate, authorize } from "../../middleware/auth";
import { validate } from "../../middleware/validate";

export const notificationRouter: Router = Router();
notificationRouter.use(authenticate);

const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

const preferenceSchema = z.object({
  pushEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
});

notificationRouter.get("/", async (req, res, next) => {
  try {
    const auth = req.auth!;
    const where = auth.role === "PATIENT"
      ? {
          OR: [
            ...(auth.patientId ? [{ patientId: auth.patientId }] : []),
            { userId: auth.userId },
          ],
        }
      : { userId: auth.userId };
    const notifications = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const unread = notifications.filter((n) => !n.readAt).length;
    res.json({ data: { notifications, unread } });
  } catch (error) {
    next(error);
  }
});

notificationRouter.patch("/read-all", async (req, res, next) => {
  try {
    const auth = req.auth!;
    const where = auth.role === "PATIENT"
      ? {
          OR: [
            ...(auth.patientId ? [{ patientId: auth.patientId }] : []),
            { userId: auth.userId },
          ],
          readAt: null,
        }
      : { userId: auth.userId, readAt: null };
    await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
    res.json({ data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

notificationRouter.get("/preferences", authorize("PATIENT"), async (req, res, next) => {
  try {
    const patientId = req.auth!.patientId;
    if (!patientId) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Patient profile not found" } });
    const prefs = await prisma.notificationPreference.upsert({
      where: { patientId },
      update: {},
      create: { patientId },
    });
    res.json({ data: { preferences: prefs } });
  } catch (error) {
    next(error);
  }
});

notificationRouter.patch("/preferences", authorize("PATIENT"), validate(preferenceSchema), async (req, res, next) => {
  try {
    const patientId = req.auth!.patientId;
    if (!patientId) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Patient profile not found" } });
    const prefs = await prisma.notificationPreference.upsert({
      where: { patientId },
      update: req.body,
      create: { patientId, ...req.body },
    });
    res.json({ data: { preferences: prefs } });
  } catch (error) {
    next(error);
  }
});

notificationRouter.patch("/:id/read", async (req, res, next) => {
  try {
    const auth = req.auth!;
    const id = param(req.params.id);
    const existing = await prisma.notification.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Notification not found" } });
    const owns =
      auth.role === "PATIENT"
        ? existing.patientId === auth.patientId || existing.userId === auth.userId
        : existing.userId === auth.userId;
    if (!owns) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Forbidden" } });
    }
    const notification = await prisma.notification.update({ where: { id }, data: { readAt: existing.readAt ?? new Date() } });
    res.json({ data: { notification } });
  } catch (error) {
    next(error);
  }
});
