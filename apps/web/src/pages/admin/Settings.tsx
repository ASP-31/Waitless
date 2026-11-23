import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Cpu, Hospital, QrCode, Radio, TimerReset } from "lucide-react";
import { toast } from "sonner";
import { ApiError, api } from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

type QrData = { scanUrl: string; qrDataUrl: string; token: string };
type HardwareRoom = {
  id: string;
  code: string;
  name: string;
  online: boolean;
  occupancy: "OCCUPIED" | "VACANT" | "UNKNOWN";
  lastSeenAt: string | null;
  lastEvent: { type: string; result: string | null; receivedAt: string } | null;
  doctor: { id: string; fullName: string; department: string | null } | null;
};
type HardwareEvent = {
  id: string;
  type: string;
  result: string | null;
  receivedAt: string;
  room: { code: string; name: string };
  doctor: { fullName: string } | null;
};
type AuditRow = {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  createdAt: string;
  actor: { name: string } | null;
};

function timeAgo(iso: string | null) {
  if (!iso) return "never";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function SettingsPage() {
  const qc = useQueryClient();
  const qrQ = useQuery({
    queryKey: ["qr", "hospital"],
    queryFn: async () => (await api.get<{ data: QrData }>("/qr/hospital")).data,
  });
  const roomsQ = useQuery({
    queryKey: ["hardware", "rooms"],
    queryFn: async () => (await api.get<{ data: { rooms: HardwareRoom[] } }>("/hardware/rooms")).data.rooms,
    refetchInterval: 15_000,
  });
  const eventsQ = useQuery({
    queryKey: ["hardware", "events"],
    queryFn: async () => (await api.get<{ data: { events: HardwareEvent[] } }>("/hardware/events")).data.events.slice(0, 20),
    refetchInterval: 15_000,
  });
  const auditQ = useQuery({
    queryKey: ["admin", "audit", "recent"],
    queryFn: async () =>
      (await api.get<{ data: { auditLogs: AuditRow[] } }>("/admin/audit?pageSize=10")).data.auditLogs,
    refetchInterval: 60_000,
  });

  const simulate = useMutation({
    mutationFn: async (room: HardwareRoom) =>
      api.post("/hardware/events", {
        v: 1,
        roomId: room.code,
        type: room.occupancy === "OCCUPIED" ? "VACANT" : "OCCUPIED",
        ts: Date.now(),
        seq: Date.now(),
        payload: { simulated: true },
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["hardware"] }),
        qc.invalidateQueries({ queryKey: ["queue"] }),
      ]);
      toast.success("Simulated occupancy event sent");
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not send event"),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Hospital profile, queue rules and integrations."
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

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Hospital className="size-4 text-primary" />Hospital profile</CardTitle>
            <CardDescription>Shown to patients on booking and token slips.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {[ ["Name", "City Care Hospital"], ["Timezone", "Asia/Kolkata"], ["Booking horizon", "7 days"], ["QR code", qrQ.data ? "Active" : "—"] ].map(([label, value]) => (
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
            {[ ["Grace period", "10 minutes after call"], ["Delay before skip", "10 more minutes"], ["Skip policy", "Requeue to end"], ["Ready alert", "30 minutes before turn"], ["Swap cut-off", "60 minutes before slot"] ].map(([label, value], index, rows) => (
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

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><BellRing className="size-4 text-primary" />Notifications</CardTitle>
            <CardDescription>Channel rollout status.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between"><span className="text-muted-foreground">In-app</span><Badge variant="success">Active</Badge></div>
            <div className="flex items-center justify-between"><span className="text-muted-foreground">Browser push</span><Badge variant="neutral">Planned</Badge></div>
            <div className="flex items-center justify-between"><span className="text-muted-foreground">SMS / WhatsApp</span><Badge variant="neutral">Stub</Badge></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Cpu className="size-4 text-primary" />Hardware</CardTitle>
            <CardDescription>Room occupancy bridge.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between"><span className="text-muted-foreground">MQTT broker</span><Badge variant="success">mosquitto:1883</Badge></div>
            <div className="flex items-center justify-between"><span className="text-muted-foreground">Auto-complete</span><Badge variant="neutral">Staff confirm</Badge></div>
            <p className="rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">Hardware occupancy events are treated as hints with staff override.</p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Radio className="size-4 text-primary" />Rooms &amp; live occupancy</CardTitle>
            <CardDescription>Assign rooms from the Doctors page. Occupancy updates arrive over MQTT or the HTTP fallback.</CardDescription>
          </CardHeader>
          <CardContent>
            {roomsQ.isLoading && <p className="text-sm text-muted-foreground">Loading rooms…</p>}
            {!roomsQ.isLoading && (roomsQ.data ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No rooms configured yet.</p>
            )}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {(roomsQ.data ?? []).map((room) => (
                <div
                  key={room.id}
                  className={
                    "rounded-xl border p-3 transition-colors " +
                    (room.occupancy === "OCCUPIED"
                      ? "border-warning/40 bg-warning/10"
                      : room.occupancy === "VACANT"
                        ? "border-success/40 bg-success/10"
                        : "")
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">{room.code} · {room.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {room.doctor ? `${room.doctor.fullName}${room.doctor.department ? ` · ${room.doctor.department}` : ""}` : "No doctor assigned"}
                      </p>
                    </div>
                    <Badge variant={room.online ? "success" : "neutral"}>{room.online ? "Online" : "Offline"}</Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant={room.occupancy === "OCCUPIED" ? "warning" : room.occupancy === "VACANT" ? "success" : "neutral"}>
                      {room.occupancy}
                    </Badge>
                    <span className="text-muted-foreground">Seen {timeAgo(room.lastSeenAt)}</span>
                    {room.lastEvent?.result === "SUGGESTED_END" && <Badge variant="info">Consult may be over</Badge>}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 w-full"
                    onClick={() => simulate.mutate(room)}
                    disabled={simulate.isPending}
                  >
                    Simulate {room.occupancy === "OCCUPIED" ? "vacant" : "occupied"}
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Recent hardware events</CardTitle>
            <CardDescription>Last 20 occupancy/heartbeat events, newest first.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {eventsQ.isLoading && <p className="text-sm text-muted-foreground">Loading events…</p>}
            {!eventsQ.isLoading && (eventsQ.data ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No hardware events yet. Run the simulator to see them here.</p>
            )}
            {(eventsQ.data ?? []).map((event) => (
              <div key={event.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{event.room.code}</Badge>
                  <span className="font-medium">{event.type}</span>
                  {event.doctor && <span className="text-muted-foreground">{event.doctor.fullName}</span>}
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  {event.result && <span>{event.result.replace(/_/g, " ")}</span>}
                  <span>{timeAgo(event.receivedAt)}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>Every state mutation is audit-logged. Newest 10 shown.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {auditQ.isLoading && <p className="text-sm text-muted-foreground">Loading activity…</p>}
            {!auditQ.isLoading && (auditQ.data ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No audit events yet.</p>
            )}
            {(auditQ.data ?? []).map((row) => (
              <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{row.action.replace(/_/g, " ")}</Badge>
                  <span className="text-muted-foreground">{row.entity}</span>
                </div>
                <div className="flex items-center gap-3 text-muted-foreground">
                  <span>{row.actor?.name ?? "System"}</span>
                  <span>{timeAgo(row.createdAt)}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
