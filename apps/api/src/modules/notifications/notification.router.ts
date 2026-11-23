import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { authenticate } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { AppError } from "../../utils/errors";
import {
  listNotifications,
  removePushSubscription,
  savePushSubscription,
} from "./notification.service";

export const notificationRouter: Router = Router();
notificationRouter.use(authenticate);

const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

async function patientIdFor(userId: string, role: string): Promise<string | null> {
  if (role !== "PATIENT") return null;
  const patient = await prisma.patient.findFirst({ where: { userId }, select: { id: true } });
  return patient?.id ?? null;
}

notificationRouter.get("/vapid-public-key", (_req, res) => {
  res.json({ data: { publicKey: env.VAPID_PUBLIC_KEY ?? null } });
});

notificationRouter.get("/", async (req, res, next) => {
  try {
    const auth = req.auth!;
    const result = await listNotifications(auth.patientId ?? null, auth.userId);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

notificationRouter.get("/preferences", async (req, res, next) => {
  try {
    const auth = req.auth!;
    const patientId = await patientIdFor(auth.userId, auth.role);
    const preferences = patientId
      ? await prisma.notificationPreference.upsert({
          where: { patientId },
          create: { patientId },
          update: {},
        })
      : null;
    res.json({
      data: {
        inAppEnabled: true,
        pushEnabled: preferences?.pushEnabled ?? false,
        smsEnabled: preferences?.smsEnabled ?? false,
        emailEnabled: preferences?.emailEnabled ?? false,
        subscriptions: ((preferences?.pushSubscriptions as unknown as Array<{ endpoint: string }>) ?? []).map((item) => item.endpoint),
      },
    });
  } catch (error) {
    next(error);
  }
});

notificationRouter.patch("/preferences", validate(z.object({
  pushEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
})), async (req, res, next) => {
  try {
    const auth = req.auth!;
    const patientId = await patientIdFor(auth.userId, auth.role);
    if (!patientId) throw AppError.forbidden("Only patients have notification preferences");
    const preferences = await prisma.notificationPreference.upsert({
      where: { patientId },
      create: { patientId, ...req.body },
      update: req.body,
    });
    res.json({ data: { preferences } });
  } catch (error) {
    next(error);
  }
});

notificationRouter.post("/push-subscribe", validate(subscriptionSchema), async (req, res, next) => {
  try {
    const auth = req.auth!;
    const patientId = await patientIdFor(auth.userId, auth.role);
    if (!patientId) throw AppError.forbidden("Only patients can subscribe to push");
    await savePushSubscription(patientId, req.body);
    res.status(201).json({ data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

notificationRouter.delete("/push-subscribe", validate(z.object({ endpoint: z.string().url() })), async (req, res, next) => {
  try {
    const auth = req.auth!;
    const patientId = await patientIdFor(auth.userId, auth.role);
    if (patientId) await removePushSubscription(patientId, req.body.endpoint);
    res.json({ data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

notificationRouter.patch("/:id/read", async (req, res, next) => {
  try {
    const auth = req.auth!;
    const id = param(req.params.id);
    const existing = await prisma.notification.findUnique({ where: { id } });
    if (!existing) throw AppError.notFound("Notification not found");
    const patientId = await patientIdFor(auth.userId, auth.role);
    const owns = existing.userId === auth.userId || (patientId && existing.patientId === patientId);
    if (!owns && auth.role !== "ADMIN" && auth.role !== "STAFF") throw AppError.forbidden();
    const notification = await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
    res.json({ data: { notification } });
  } catch (error) {
    next(error);
  }
});

notificationRouter.patch("/read-all", async (req, res, next) => {
  try {
    const auth = req.auth!;
    const patientId = await patientIdFor(auth.userId, auth.role);
    await prisma.notification.updateMany({
      where: {
        OR: [
          { userId: auth.userId },
          ...(patientId ? [{ patientId }] : []),
        ],
        readAt: null,
      },
      data: { readAt: new Date() },
    });
    res.json({ data: { ok: true } });
  } catch (error) {
    next(error);
  }
});
