import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, BellRing, Cpu, Hospital, QrCode, Radio, TimerReset } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useSocket } from "@/hooks/use-socket";
import { ApiError, api } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";

type QrData = { scanUrl: string; qrDataUrl: string; token: string };

interface Room {
  id: string;
  code: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
  doctor?: { id: string; fullName: string } | null;
}

interface HardwareEvent {
  id: string;
  type: string;
  receivedAt: string;
  room?: { code: string; name: string } | null;
}

interface Preferences {
  inAppEnabled: boolean;
  pushEnabled: boolean;
  smsEnabled: boolean;
  emailEnabled: boolean;
  subscriptions: string[];
}

const EVENT_TYPES = ["OCCUPIED", "VACANT", "HEARTBEAT"] as const;

export function SettingsPage() {
  const qc = useQueryClient();
  const [roomId, setRoomId] = useState("");
  const [eventType, setEventType] = useState<(typeof EVENT_TYPES)[number]>("OCCUPIED");

  useSocket({
    onEvent: (event) => {
      if (event === "hardware:occupancy") {
        void qc.invalidateQueries({ queryKey: ["hardware"] });
        void qc.invalidateQueries({ queryKey: ["queue"] });
      }
    },
  });

  const qrQ = useQuery({
    queryKey: ["qr", "hospital"],
    queryFn: async () => (await api.get<{ data: QrData }>("/qr/hospital")).data,
  });
  const roomsQ = useQuery({
    queryKey: ["hardware", "rooms"],
    queryFn: async () => (await api.get<{ data: { rooms: Room[] } }>("/hardware/rooms")).data,
    refetchInterval: 15_000,
  });
  const eventsQ = useQuery({
    queryKey: ["hardware", "events"],
    queryFn: async () => (await api.get<{ data: { events: HardwareEvent[] } }>("/hardware/events")).data,
    refetchInterval: 15_000,
  });
  const prefsQ = useQuery({
    queryKey: ["notifications", "preferences"],
    queryFn: async () => (await api.get<{ data: Preferences }>("/notifications/preferences")).data,
  });
  const vapidQ = useQuery({
    queryKey: ["notifications", "vapid-key"],
    queryFn: async () => (await api.get<{ data: { publicKey: string | null } }>("/notifications/vapid-public-key")).data,
  });

  const simulate = useMutation({
    mutationFn: () => api.post("/hardware/simulate", { roomId, type: eventType }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["hardware"] });
      toast.success(`Simulated ${eventType.toLowerCase()} event`);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not simulate event"),
  });

  const rooms = roomsQ.data?.rooms ?? [];
  const events = eventsQ.data?.events ?? [];
  const selectedRoom = roomId || rooms[0]?.id || "";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Hospital profile, queue rules, integrations and device health."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><QrCode className="size-4 text-primary" />Booking QR code</CardTitle>
            <CardDescription>Printable QR for on-site check-in/booking. Signed and time-limited.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center">
            {qrQ.isLoading ? (
              <p className="text-sm text-muted-foreground">Generating QR…</p>
            ) : qrQ.data ? (
              <>
                <img src={qrQ.data.qrDataUrl} alt="Hospital booking QR code" className="h-48 w-48 rounded-lg border bg-white p-2" />
                <div className="space-y-2 text-sm">
                  <p className="font-medium">Scan to book</p>
                  <p className="text-muted-foreground break-all">{qrQ.data.scanUrl}</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => window.print()}>Print</Button>
                    <Button size="sm" variant="outline" asChild><a href={qrQ.data.scanUrl} target="_blank" rel="noreferrer">Open link</a></Button>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Could not load QR code.</p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Cpu className="size-4 text-primary" />Rooms &amp; hardware</CardTitle>
            <CardDescription>Live room occupancy from the device bridge, with event simulation for testing.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {roomsQ.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading rooms…</p>
              ) : rooms.length === 0 ? (
                <p className="text-sm text-muted-foreground">No rooms are configured.</p>
              ) : (
                rooms.map((room) => (
                  <div key={room.id} className="space-y-2 rounded-lg border bg-muted/20 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium">{room.code} · {room.name}</p>
                      <Badge
                        variant={
                          room.status === "ONLINE" || room.status === "VACANT"
                            ? "success"
                            : room.status === "OCCUPIED"
                              ? "info"
                              : room.status === "DEGRADED"
                                ? "warning"
                                : "neutral"
                        }
                      >
                        <Activity className="size-3" />{room.status ?? "UNKNOWN"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{room.doctor?.fullName ?? "No doctor assigned"}</p>
                    <p className="text-xs text-muted-foreground">Heartbeat: {formatRelativeTime(room.lastSeenAt)}</p>
                  </div>
                ))
              )}
            </div>

            <Separator />

            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-40 flex-1">
                <label htmlFor="sim-room" className="mb-1 block text-xs font-medium text-muted-foreground">Room</label>
                <Select value={selectedRoom} onValueChange={setRoomId}>
                  <SelectTrigger id="sim-room" aria-label="Room to simulate">
                    <SelectValue placeholder={rooms.length ? "Select room" : "No rooms available"} />
                  </SelectTrigger>
                  <SelectContent>
                    {rooms.map((room) => <SelectItem key={room.id} value={room.id}>{room.code} · {room.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-36">
                <label htmlFor="sim-type" className="mb-1 block text-xs font-medium text-muted-foreground">Event</label>
                <Select value={eventType} onValueChange={(value) => setEventType(value as (typeof EVENT_TYPES)[number])}>
                  <SelectTrigger id="sim-type" aria-label="Event type to simulate">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EVENT_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Button disabled={!selectedRoom || simulate.isPending} onClick={() => simulate.mutate()}>
                <Radio className="size-4" />{simulate.isPending ? "Sending…" : "Simulate event"}
              </Button>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium">Recent events</h3>
              {events.length === 0 ? (
                <p className="text-xs text-muted-foreground">No hardware events received yet.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {events.slice(0, 6).map((event) => (
                    <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="flex items-center gap-2">
                        <Badge variant="neutral">{event.room?.code ?? "Room"}</Badge>
                        <span className="font-medium">{event.type}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">{formatRelativeTime(event.receivedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Hospital className="size-4 text-primary" />Hospital profile</CardTitle>
            <CardDescription>Shown to patients on booking and token slips.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {[["Name", "City Care Hospital"], ["Timezone", "Asia/Kolkata"], ["Booking horizon", "7 days"], ["QR code", qrQ.data ? "Active" : "—"]].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">{value}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><TimerReset className="size-4 text-primary" />Queue rules</CardTitle>
            <CardDescription>Defaults from environment configuration.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {[["Grace period", "10 minutes after call"], ["Delay before skip", "10 more minutes"], ["Skip policy", "Requeue to end"], ["Ready alert", "30 minutes before turn"], ["Swap cut-off", "60 minutes before slot"]].map(([label, value], index, rows) => (
              <div key={label}>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-medium">{value}</span>
                </div>
                {index < rows.length - 1 && <Separator className="mt-3" />}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><BellRing className="size-4 text-primary" />Notification channels</CardTitle>
            <CardDescription>Delivery channels available to patients on this deployment.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "In-app", enabled: prefsQ.data?.inAppEnabled ?? true },
              { label: "Browser push", enabled: !!prefsQ.data?.pushEnabled && !!vapidQ.data?.publicKey },
              { label: "SMS / WhatsApp", enabled: !!prefsQ.data?.smsEnabled },
              { label: "Email", enabled: !!prefsQ.data?.emailEnabled },
            ].map((channel) => (
              <div key={channel.label} className="flex items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 text-sm">
                <span className="text-muted-foreground">{channel.label}</span>
                <Badge variant={channel.enabled ? "success" : "neutral"}>{channel.enabled ? "Enabled" : "Off"}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
