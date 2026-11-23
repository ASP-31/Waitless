import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, CheckCircle2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import type { NotificationList } from "@/lib/notifications";

const QUERY_KEY = ["notifications"] as const;

export function NotificationBell({ to = "/patient/notifications" }: { to?: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const notificationsQ = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await api.get<{ data: NotificationList }>("/notifications")).data,
    refetchInterval: 30_000,
  });
  const list = notificationsQ.data;
  const unread = list?.unread ?? 0;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const readOne = useMutation({
    mutationFn: (id: string) => api.patch(`/notifications/${id}/read`),
    onSuccess: async (_result, id) => {
      qc.setQueryData<{ data: NotificationList }>(QUERY_KEY, (current) => {
        if (!current) return current;
        return {
          data: {
            notifications: current.data.notifications.map((item) =>
              item.id === id ? { ...item, readAt: new Date().toISOString() } : item,
            ),
            unread: Math.max(0, current.data.unread - 1),
          },
        };
      });
      await qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not mark as read"),
  });

  const readAll = useMutation({
    mutationFn: () => api.patch("/notifications/read-all"),
    onSuccess: async () => {
      qc.setQueryData<{ data: NotificationList }>(QUERY_KEY, (current) =>
        current
          ? {
              data: {
                notifications: current.data.notifications.map((item) => ({
                  ...item,
                  readAt: item.readAt ?? new Date().toISOString(),
                })),
                unread: 0,
              },
            }
          : current,
      );
      await qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("All notifications marked as read");
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not update notifications"),
  });

  return (
    <div className="relative" ref={containerRef}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Notifications, ${unread} unread`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className="relative"
      >
        <Bell className="size-5" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 grid min-w-5 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-5 text-destructive-foreground"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-card shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-4 py-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {unread > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={readAll.isPending}
                onClick={() => readAll.mutate()}
              >
                <CheckCheck className="size-3.5" /> Mark all read
              </Button>
            )}
          </div>

          <ul className="max-h-80 divide-y overflow-y-auto">
            {notificationsQ.isLoading ? (
              <li className="px-4 py-6 text-center text-sm text-muted-foreground">Loading notifications…</li>
            ) : !list || list.notifications.length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-muted-foreground">You&apos;re all caught up.</li>
            ) : (
              list.notifications.map((item) => (
                <li key={item.id} className="flex gap-2 px-4 py-3">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden={!!item.readAt} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-snug">{item.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.body}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {new Date(item.createdAt).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                  {!item.readAt && (
                    <Button
                      type="button"
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
              ))
            )}
          </ul>

          <div className="border-t p-2">
            <Button variant="ghost" size="sm" asChild className="w-full justify-center">
              <Link to={to} onClick={() => setOpen(false)}>
                View all notifications
              </Link>
            </Button>
          </div>
          {notificationsQ.isError && (
            <p className="px-4 pb-3 text-xs text-destructive">Could not load notifications. Try again shortly.</p>
          )}
        </div>
      )}
    </div>
  );
}
