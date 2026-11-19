import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Shared header bell. The socket hook invalidates the `notifications` query on
 * `notification:new`, so this only polls as a fallback every minute.
 */
export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const notificationsQ = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => (await api.get<{ data: { notifications: NotificationRow[]; unread: number } }>("/notifications")).data,
    refetchInterval: 60_000,
  });

  const markRead = useMutation({
    mutationFn: async (id: string) => api.patch(`/notifications/${id}/read`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const markAll = useMutation({
    mutationFn: async () => api.patch("/notifications/read-all"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const notifications = notificationsQ.data?.notifications ?? [];
  const unread = notificationsQ.data?.unread ?? 0;

  return (
    <div className="relative" ref={panelRef}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={unread ? `${unread} unread notifications` : "Notifications"}
        onClick={() => setOpen((value) => !value)}
        className="relative"
      >
        <Bell className="size-5" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold">Notifications</p>
              {unread > 0 && <Badge variant="secondary">{unread} new</Badge>}
            </div>
            {unread > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
              >
                <CheckCheck className="size-3.5" />
                Mark all read
              </Button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {notificationsQ.isLoading && (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</p>
            )}
            {!notificationsQ.isLoading && notifications.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                You are all caught up.
              </p>
            )}
            {notifications.map((notification) => (
              <button
                key={notification.id}
                type="button"
                onClick={() => {
                  if (!notification.readAt) markRead.mutate(notification.id);
                }}
                className={cn(
                  "block w-full border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent/60",
                  !notification.readAt && "bg-primary/5",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium leading-tight">{notification.title}</p>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(notification.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{notification.body}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
