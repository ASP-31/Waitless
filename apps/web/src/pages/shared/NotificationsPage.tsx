import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, CheckCheck, CheckCircle2, Inbox, Smartphone } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CardEmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/context/auth-context";
import { ApiError, api } from "@/lib/api";
import {
  urlBase64ToUint8Array,
  type NotificationList,
  type NotificationPreferences,
} from "@/lib/notifications";

const QUERY_KEY = ["notifications"] as const;
const PREFS_KEY = ["notifications", "preferences"] as const;

function ChannelToggle({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/20 p-3">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>
      </label>
      <span className="relative inline-flex shrink-0">
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span
          aria-hidden="true"
          className="block h-6 w-11 rounded-full bg-muted transition-colors peer-checked:bg-primary peer-disabled:opacity-50 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0.5 top-0.5 size-5 rounded-full bg-background shadow-sm transition-transform peer-checked:translate-x-5"
        />
      </span>
    </div>
  );
}

function PreferencesPanel() {
  const qc = useQueryClient();
  const prefsQ = useQuery({
    queryKey: PREFS_KEY,
    queryFn: async () => (await api.get<{ data: NotificationPreferences }>("/notifications/preferences")).data,
  });
  const vapidQ = useQuery({
    queryKey: ["notifications", "vapid-key"],
    queryFn: async () => (await api.get<{ data: { publicKey: string | null } }>("/notifications/vapid-public-key")).data,
  });
  const [busy, setBusy] = useState(false);
  const prefs = prefsQ.data;

  const updatePrefs = useMutation({
    mutationFn: (body: { pushEnabled?: boolean; smsEnabled?: boolean; emailEnabled?: boolean }) =>
      api.patch("/notifications/preferences", body),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: PREFS_KEY });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not update notification preferences"),
  });

  async function enablePush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
      toast.error("This browser doesn't support push notifications");
      return;
    }
    const publicKey = vapidQ.data?.publicKey;
    if (!publicKey) {
      toast.error("Push notifications are not configured on the server");
      return;
    }
    if (Notification.permission === "denied") {
      toast.error("Notifications are blocked for this site. Allow them in your browser settings first.");
      return;
    }
    setBusy(true);
    try {
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      if (permission !== "granted") {
        toast.error("Notification permission was not granted");
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const values = subscription.toJSON();
      if (!values.endpoint || !values.keys?.p256dh || !values.keys.auth) {
        throw new Error("The browser returned an incomplete push subscription");
      }
      await api.post("/notifications/push-subscribe", {
        endpoint: values.endpoint,
        keys: { p256dh: values.keys.p256dh, auth: values.keys.auth },
      });
      await updatePrefs.mutateAsync({ pushEnabled: true });
      toast.success("Browser push enabled");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Could not enable push notifications");
    } finally {
      setBusy(false);
    }
  }

  async function disablePush() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        try {
          await api.delete("/notifications/push-subscribe", { body: { endpoint: subscription.endpoint } });
        } catch {
          // Still unsubscribe locally if the server no longer knows the endpoint.
        }
        await subscription.unsubscribe();
      }
      await updatePrefs.mutateAsync({ pushEnabled: false });
      toast.success("Browser push disabled");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not disable push notifications");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="size-4 text-primary" /> Notification preferences
        </CardTitle>
        <CardDescription>Choose how the clinic can reach you about your visits.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {prefsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading preferences…</p>
        ) : !prefs ? (
          <p className="text-sm text-muted-foreground">Preferences are unavailable right now.</p>
        ) : (
          <>
            <ChannelToggle
              id="pref-push"
              label="Browser push"
              description={
                vapidQ.data?.publicKey
                  ? "Get turn alerts even when this page is closed."
                  : "Push is not configured on this deployment yet."
              }
              checked={prefs.pushEnabled}
              disabled={busy || !vapidQ.data?.publicKey}
              onChange={(checked) => void (checked ? enablePush() : disablePush())}
            />
            <ChannelToggle
              id="pref-sms"
              label="SMS / WhatsApp"
              description="Delivery updates on your registered mobile number."
              checked={prefs.smsEnabled}
              disabled={updatePrefs.isPending}
              onChange={(checked) => updatePrefs.mutate({ smsEnabled: checked })}
            />
            <ChannelToggle
              id="pref-email"
              label="Email"
              description="Copies of booking confirmations and receipts."
              checked={prefs.emailEnabled}
              disabled={updatePrefs.isPending}
              onChange={(checked) => updatePrefs.mutate({ emailEnabled: checked })}
            />
            <p className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5" /> In-app notifications are always on ({prefs.subscriptions.length} push device
              {prefs.subscriptions.length === 1 ? "" : "s"} registered).
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function NotificationsPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isPatient = user?.role === "PATIENT";
  const [filter, setFilter] = useState<"all" | "unread">("all");

  const notificationsQ = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await api.get<{ data: NotificationList }>("/notifications")).data,
    refetchInterval: 30_000,
  });

  const readOne = useMutation({
    mutationFn: (id: string) => api.patch(`/notifications/${id}/read`),
    onSuccess: async () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not mark as read"),
  });

  const readAll = useMutation({
    mutationFn: () => api.patch("/notifications/read-all"),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("All notifications marked as read");
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not update notifications"),
  });

  const notifications = (notificationsQ.data?.notifications ?? []).filter((item) =>
    filter === "unread" ? !item.readAt : true,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description="Turn alerts, queue updates and swap activity in one place."
        actions={
          notificationsQ.data && notificationsQ.data.unread > 0 ? (
            <Button variant="outline" disabled={readAll.isPending} onClick={() => readAll.mutate()}>
              <CheckCheck className="size-4" /> Mark all read
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <BellRing className="size-4 text-primary" /> Inbox
                </CardTitle>
                <CardDescription>
                  {notificationsQ.data ? `${notificationsQ.data.unread} unread` : "Latest messages first"}
                </CardDescription>
              </div>
              <div className="flex gap-1" role="group" aria-label="Filter notifications">
                <Button
                  size="sm"
                  variant={filter === "all" ? "default" : "outline"}
                  aria-pressed={filter === "all"}
                  onClick={() => setFilter("all")}
                >
                  All
                </Button>
                <Button
                  size="sm"
                  variant={filter === "unread" ? "default" : "outline"}
                  aria-pressed={filter === "unread"}
                  onClick={() => setFilter("unread")}
                >
                  Unread
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {notificationsQ.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading notifications…</p>
            ) : notifications.length === 0 ? (
              <CardEmptyState
                icon={Inbox}
                title={filter === "unread" ? "Nothing unread" : "No notifications yet"}
                description="Turn updates and queue changes will show up here."
              />
            ) : (
              <ul className="divide-y">
                {notifications.map((item) => (
                  <li key={item.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{item.title}</p>
                        {!item.readAt && <Badge variant="info">New</Badge>}
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {new Date(item.createdAt).toLocaleString([], {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                        {" · "}
                        {item.channel.replace(/_/g, " ")}
                      </p>
                    </div>
                    {!item.readAt && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Mark ${item.title} as read`}
                        disabled={readOne.isPending}
                        onClick={() => readOne.mutate(item.id)}
                      >
                        <CheckCircle2 className="size-4" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {notificationsQ.isError && (
              <p className="text-sm text-destructive">Could not load notifications. Please refresh.</p>
            )}
          </CardContent>
        </Card>

        {isPatient && <PreferencesPanel />}
      </div>
    </div>
  );
}
