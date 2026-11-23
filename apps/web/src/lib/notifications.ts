export interface NotificationItem {
  id: string;
  type: string;
  channel: string;
  status: string;
  title: string;
  body: string;
  data: unknown;
  appointmentId: string | null;
  readAt: string | null;
  createdAt: string;
  sentAt: string | null;
  scheduledFor: string | null;
}

export interface NotificationList {
  notifications: NotificationItem[];
  unread: number;
}

export interface NotificationPreferences {
  inAppEnabled: boolean;
  pushEnabled: boolean;
  smsEnabled: boolean;
  emailEnabled: boolean;
  subscriptions: string[];
}

/** Convert a VAPID base64url public key to the ArrayBuffer form PushManager needs. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}
