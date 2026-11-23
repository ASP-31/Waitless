import { Prisma, type Notification, type NotificationChannel, type NotificationType } from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { cancelJob, enqueue, jobIds, QUEUE_NAMES } from "../../jobs/schedulers";
import { channels } from "./notification.channels";

export interface NotifyInput {
  userId?: string | null;
  patientId?: string | null;
  appointmentId?: string | null;
  type: NotificationType;
  title: string;
  body: string;
  data?: Prisma.InputJsonValue;
  channels?: NotificationChannel[];
  dedupeKey?: string;
  scheduledFor?: Date | null;
}

type StoredSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

async function subscriptionsFor(patientId: string | null | undefined): Promise<StoredSubscription[]> {
  if (!patientId) return [];
  const prefs = await prisma.notificationPreference.findUnique({ where: { patientId } });
  if (!prefs?.pushEnabled || !prefs.pushSubscriptions) return [];
  return prefs.pushSubscriptions as unknown as StoredSubscription[];
}

/**
 * Single notification entrypoint. Rows are deduped by `dedupeKey`, scheduled
 * notifications become BullMQ jobs, and channel failures never fail a request.
 */
export async function notify(input: NotifyInput): Promise<Notification[]> {
  const requested = input.channels ?? ["IN_APP"];
  const subscriptions = requested.includes("WEB_PUSH") ? await subscriptionsFor(input.patientId) : [];
  const active = requested.filter((channel) => channel !== "WEB_PUSH" || subscriptions.length > 0);
  const created: Notification[] = [];

  for (const channel of active) {
    const scheduled = Boolean(input.scheduledFor && input.scheduledFor.getTime() > Date.now());
    const dedupeKey = input.dedupeKey ? `${input.dedupeKey}:${channel.toLowerCase()}` : undefined;
    try {
      const row = await prisma.notification.create({
        data: {
          userId: input.userId ?? null,
          patientId: input.patientId ?? null,
          appointmentId: input.appointmentId ?? null,
          type: input.type,
          channel,
          title: input.title,
          body: input.body,
          data: input.data,
          status: scheduled ? "SCHEDULED" : "PENDING",
          scheduledFor: input.scheduledFor ?? null,
          dedupeKey,
        },
      });
      created.push(row);
      if (scheduled && input.scheduledFor) {
        await enqueue(QUEUE_NAMES.notifications, jobIds.dispatch(row.id), { notificationId: row.id }, { runAt: input.scheduledFor });
      } else {
        await dispatchNotification(row.id, { subscriptions });
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        logger.debug({ dedupeKey }, "notification deduped");
        continue;
      }
      logger.error({ err: error, type: input.type }, "failed to create notification");
    }
  }
  return created;
}

/** Used by the BullMQ notification worker and by immediate dispatch. */
export async function dispatchNotification(notificationId: string, context?: { subscriptions?: StoredSubscription[] }): Promise<void> {
  const row = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!row || row.status === "SENT" || row.status === "CANCELLED") return;
  const subscriptions = context?.subscriptions ?? (await subscriptionsFor(row.patientId));
  const result = await channels[row.channel].send(row, { subscriptions, data: row.data });
  await prisma.notification.update({
    where: { id: notificationId },
    data: {
      status: result.ok ? "SENT" : "FAILED",
      sentAt: result.ok ? new Date() : null,
      data: result.reason
        ? ({ ...(((row.data ?? {}) as object)), deliveryError: result.reason } as Prisma.InputJsonValue)
        : (row.data ?? Prisma.DbNull),
    },
  });
}

/** Reschedules the "30 minutes before your turn" reminder after an ETA change. */
export async function scheduleReady30(appointmentId: string, estimatedStartAt: Date | null | undefined, context: { patientId: string; userId?: string | null; title: string; body: string }): Promise<void> {
  const dedupeKey = `ready30:${appointmentId}`;
  const existing = await prisma.notification.findUnique({ where: { dedupeKey: `${dedupeKey}:in_app` } });
  if (existing?.status === "SENT") return;

  if (!estimatedStartAt) {
    await cancelReady30(appointmentId);
    return;
  }
  const fireAt = new Date(estimatedStartAt.getTime() - env.READY_ALERT_MINUTES * 60_000);
  if (fireAt.getTime() <= Date.now()) {
    await cancelReady30(appointmentId);
    return;
  }

  if (existing) {
    // BullMQ does not move delayed jobs when `add` reuses an id: remove the
    // old timer first, otherwise the reminder fires at the stale ETA as well.
    await cancelJob(QUEUE_NAMES.notifications, jobIds.dispatch(existing.id));
    await cancelJob(QUEUE_NAMES.notifications, jobIds.ready30(appointmentId));
    await prisma.notification.update({
      where: { id: existing.id },
      data: { scheduledFor: fireAt, status: "SCHEDULED", sentAt: null },
    });
  } else {
    await notify({
      patientId: context.patientId,
      userId: context.userId,
      appointmentId,
      type: "READY_30_MIN",
      title: context.title,
      body: context.body,
      dedupeKey,
      scheduledFor: fireAt,
      channels: ["IN_APP", "WEB_PUSH"],
    });
  }
  const row = await prisma.notification.findUnique({ where: { dedupeKey: `${dedupeKey}:in_app` } });
  if (row) {
    await enqueue(QUEUE_NAMES.notifications, jobIds.ready30(appointmentId), { notificationId: row.id }, { runAt: fireAt });
  }
}

export async function cancelReady30(appointmentId: string): Promise<void> {
  const rows = await prisma.notification.findMany({
    where: { dedupeKey: { startsWith: `ready30:${appointmentId}:` }, status: { in: ["PENDING", "SCHEDULED"] } },
  });
  for (const row of rows) {
    await cancelJob(QUEUE_NAMES.notifications, jobIds.dispatch(row.id));
    await cancelJob(QUEUE_NAMES.notifications, jobIds.ready30(appointmentId));
    await prisma.notification.update({ where: { id: row.id }, data: { status: "CANCELLED" } });
  }
}

/** Notifies every staff member; used for unscheduled occupancy and watchdog alerts. */
export async function notifyStaff(type: NotificationType, title: string, body: string, data?: Prisma.InputJsonValue, dedupeScope?: string): Promise<void> {
  const staff = await prisma.user.findMany({ where: { role: { in: ["ADMIN", "STAFF"] }, isActive: true }, select: { id: true } });
  await Promise.all(
    staff.map((user) =>
      notify({
        userId: user.id,
        type,
        title,
        body,
        data,
        dedupeKey: dedupeScope ? `${type}:${dedupeScope}:${user.id}` : undefined,
      }),
    ),
  );
}

export async function listNotifications(patientId: string | null, userId: string | null): Promise<{ notifications: Notification[]; unread: number }> {
  const notifications = await prisma.notification.findMany({
    where: {
      OR: [
        ...(patientId ? [{ patientId }] : []),
        ...(userId ? [{ userId }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return { notifications, unread: notifications.filter((row) => !row.readAt).length };
}

export async function savePushSubscription(patientId: string, subscription: StoredSubscription): Promise<void> {
  const prefs = await prisma.notificationPreference.upsert({
    where: { patientId },
    create: { patientId, pushEnabled: true },
    update: {},
  });
  const current = (prefs.pushSubscriptions as unknown as StoredSubscription[] | null) ?? [];
  const next = [...current.filter((item) => item.endpoint !== subscription.endpoint), subscription];
  await prisma.notificationPreference.update({
    where: { patientId },
    data: { pushSubscriptions: next as unknown as Prisma.InputJsonValue, pushEnabled: true },
  });
}

export async function removePushSubscription(patientId: string, endpoint: string): Promise<void> {
  const prefs = await prisma.notificationPreference.findUnique({ where: { patientId } });
  if (!prefs?.pushSubscriptions) return;
  const current = prefs.pushSubscriptions as unknown as StoredSubscription[];
  await prisma.notificationPreference.update({
    where: { patientId },
    data: { pushSubscriptions: current.filter((item) => item.endpoint !== endpoint) as unknown as Prisma.InputJsonValue },
  });
}
