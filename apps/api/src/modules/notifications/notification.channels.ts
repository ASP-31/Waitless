import type { Notification } from "@prisma/client";
import webpush from "web-push";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { socketEmitter } from "../../sockets/emitter";

export interface ChannelResult {
  ok: boolean;
  reason?: string;
}

export interface NotificationChannelAdapter {
  send(notification: Notification, payload: Record<string, unknown>): Promise<ChannelResult>;
}

/** In-app rows are written first, then pushed to the patient's socket room. */
export const inAppChannel: NotificationChannelAdapter = {
  async send(notification) {
    socketEmitter.notificationNew(notification.userId, notification.patientId, {
      notificationId: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
    });
    return { ok: true };
  },
};

type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

function configureWebPush(): boolean {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  return true;
}

export const webPushChannel: NotificationChannelAdapter = {
  async send(notification, payload) {
    if (!configureWebPush()) return { ok: false, reason: "WEB_PUSH_NOT_CONFIGURED" };
    const subscriptions = (payload.subscriptions ?? []) as PushSubscription[];
    if (!subscriptions.length) return { ok: false, reason: "NO_SUBSCRIPTION" };
    const message = JSON.stringify({
      title: notification.title,
      body: notification.body,
      data: { notificationId: notification.id, type: notification.type, ...((notification.data as object) ?? {}) },
    });
    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(subscription, message);
          return { ok: true };
        } catch (error) {
          // Expired subscriptions are deleted by the API on the next preference read.
          logger.warn({ err: error }, "web push delivery failed");
          return { ok: false };
        }
      }),
    );
    return results.some((result) => result.ok) ? { ok: true } : { ok: false, reason: "DELIVERY_FAILED" };
  },
};

/** Deliberately inert in v1 — the SMS/WhatsApp upgrade is Phase 11 scope. */
export const smsChannel: NotificationChannelAdapter = {
  async send() {
    return { ok: false, reason: "SMS_NOT_ENABLED" };
  },
};

export const emailChannel: NotificationChannelAdapter = {
  async send() {
    return { ok: false, reason: "EMAIL_NOT_ENABLED" };
  },
};

export const channels = {
  IN_APP: inAppChannel,
  WEB_PUSH: webPushChannel,
  SMS: smsChannel,
  EMAIL: emailChannel,
} satisfies Record<string, NotificationChannelAdapter>;
