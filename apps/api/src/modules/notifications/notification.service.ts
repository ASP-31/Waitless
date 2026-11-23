import { Prisma, type Notification, type NotificationChannel, type NotificationType } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { socketEmitter } from "../../sockets/emitter";

export type NotificationStatus = "PENDING" | "SCHEDULED" | "SENT" | "FAILED" | "CANCELLED";

export interface NotifyInput {
  userId?: string | null;
  patientId?: string | null;
  appointmentId?: string | null;
  type: NotificationType;
  channel?: NotificationChannel;
  title: string;
  body: string;
  data?: Prisma.InputJsonValue | null;
  dedupeKey?: string | null;
  scheduledFor?: Date | null;
  status?: NotificationStatus;
}

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Single entry point for every notification. Keeping creation here means
 * dedupe keys, socket emission and status transitions never drift.
 */
export async function notify(input: NotifyInput): Promise<Notification | null> {
  const { notification, created } = await createNotification(prisma, input);
  // Scheduled rows are emitted by sendDueNotifications when their time comes.
  // A dedupe hit returns the existing row; emitting again would double-push.
  if (created && notification.status === "SENT") emitNotification(notification);
  return notification;
}

/** Creates a notification inside an existing transaction (no socket emit). */
export async function notifyInTx(db: Db, input: NotifyInput): Promise<Notification | null> {
  return (await createNotification(db, input)).notification;
}

async function createNotification(
  db: Db,
  input: NotifyInput,
): Promise<{ notification: Notification; created: boolean }> {
  const scheduledFor = input.scheduledFor ?? null;
  const status: NotificationStatus =
    input.status ?? (scheduledFor && scheduledFor.getTime() > Date.now() ? "SCHEDULED" : "SENT");
  const isSent = status === "SENT";

  try {
    const notification = await db.notification.create({
      data: {
        userId: input.userId ?? null,
        patientId: input.patientId ?? null,
        appointmentId: input.appointmentId ?? null,
        type: input.type,
        channel: input.channel ?? "IN_APP",
        title: input.title,
        body: input.body,
        data: input.data ?? Prisma.JsonNull,
        dedupeKey: input.dedupeKey ?? null,
        scheduledFor,
        status,
        sentAt: isSent ? new Date() : null,
      },
    });
    return { notification, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && input.dedupeKey) {
      const existing = await db.notification.findUnique({ where: { dedupeKey: input.dedupeKey } });
      if (existing) return { notification: existing, created: false };
    }
    throw error;
  }
}

export function emitNotification(notification: Pick<Notification, "id" | "userId" | "patientId" | "type" | "title" | "body" | "createdAt">) {
  if (!notification.userId && !notification.patientId) return;
  socketEmitter.notificationNew(notification.userId, notification.patientId, {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    createdAt: notification.createdAt,
  });
}

export async function sendDueNotifications(now = new Date(), limit = 50): Promise<number> {
  const due = await prisma.notification.findMany({
    where: {
      status: "SCHEDULED",
      scheduledFor: { lte: now },
    },
    orderBy: { scheduledFor: "asc" },
    take: limit,
  });

  let sent = 0;
  for (const notification of due) {
    const updated = await prisma.notification.updateMany({
      where: { id: notification.id, status: "SCHEDULED" },
      data: { status: "SENT", sentAt: now },
    });
    if (updated.count === 1) {
      emitNotification({ ...notification, createdAt: notification.createdAt });
      sent += 1;
    }
  }
  return sent;
}
