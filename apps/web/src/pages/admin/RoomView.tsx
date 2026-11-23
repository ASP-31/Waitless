import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CircleDot, Clock3, MonitorPlay, RefreshCw, Wifi } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSocket } from "@/hooks/use-socket";
import { api } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";

interface QueueEntry {
  id: string;
  position: number;
  status: string;
  appointment: {
    tokenNumber: number;
    patient: { fullName: string };
  };
}

interface QueueData {
  doctor: { id: string; fullName: string; room?: { code: string } | null };
  date: string;
  entries: QueueEntry[];
  currentPatient: QueueEntry | null;
  stats: { estimatedWaitMinutes?: number; avgConsultMinutes?: number };
}

interface HardwareRoom {
  id: string;
  code: string;
  name: string;
  status?: string | null;
  lastSeenAt?: string | null;
  doctor?: { id: string; fullName: string } | null;
}

interface HardwareEvent {
  id: string;
  type: string;
  result: string | null;
  occurredAt: string;
}

const UPCOMING = new Set(["WAITING", "NOTIFIED", "DELAYED", "BOOKED"]);

export function RoomViewPage() {
  const { doctorId = "" } = useParams<{ doctorId: string }>();
  useSocket({ doctorIds: doctorId ? [doctorId] : [] });
  const queueQ = useQuery({
    queryKey: ["queue", doctorId, "wall"],
    queryFn: async () => (await api.get<{ data: QueueData }>(`/queue/${doctorId}`)).data,
    enabled: !!doctorId,
    refetchInterval: 15_000,
  });

  const queue = queueQ.data;
  const roomsQ = useQuery({
    queryKey: ["hardware", "rooms"],
    queryFn: async () => (await api.get<{ data: { rooms: HardwareRoom[] } }>("/hardware/rooms")).data.rooms,
    refetchInterval: 30_000,
    retry: false,
  });
  const room = (roomsQ.data ?? []).find(
    (candidate) => candidate.doctor?.id === doctorId || (!!queue?.doctor.room?.code && candidate.code === queue.doctor.room.code),
  ) ?? null;
  const roomCode = room?.code ?? queue?.doctor.room?.code ?? null;
  const eventsQ = useQuery({
    queryKey: ["hardware", "room-events", roomCode],
    queryFn: async () => (await api.get<{ data: { events: HardwareEvent[] } }>(`/hardware/rooms/${encodeURIComponent(roomCode ?? "")}/events`)).data.events,
    enabled: !!roomCode,
    refetchInterval: 15_000,
    retry: false,
  });
  const latestEvent =
    eventsQ.data?.find((event) => event.type === "OCCUPIED" || event.type === "VACANT") ?? eventsQ.data?.[0] ?? null;

  const next = (queue?.entries ?? [])
    .filter((entry) => UPCOMING.has(entry.status) && entry.id !== queue?.currentPatient?.id)
    .sort((a, b) => a.position - b.position)
    .slice(0, 3);
  const updatedAt = queueQ.dataUpdatedAt ? new Date(queueQ.dataUpdatedAt) : null;

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-50">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-4 sm:px-8">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild className="text-slate-300 hover:bg-slate-800 hover:text-white">
            <Link to="/admin/queue" aria-label="Back to queue management">
              <ArrowLeft className="size-5" />
            </Link>
          </Button>
          <div>
            <p className="flex items-center gap-2 text-xs uppercase tracking-widest text-slate-400">
              <MonitorPlay className="size-4" /> Room display
            </p>
            <h1 className="text-xl font-semibold sm:text-2xl">
              {queue?.doctor.fullName ?? "Loading doctor…"}
              {queue?.doctor.room?.code ? <span className="ml-2 text-slate-400">· Room {queue.doctor.room.code}</span> : null}
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-400">
          <Badge variant="success" className="bg-emerald-500/15 text-emerald-300">
            <CircleDot className="size-3" /> Live · 15s refresh
          </Badge>
          <span className="hidden sm:inline">{queue?.date ?? ""}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh queue display"
            className="text-slate-300 hover:bg-slate-800 hover:text-white"
            onClick={() => void queueQ.refetch()}
          >
            <RefreshCw className="size-5" />
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl space-y-10 px-4 py-8 sm:px-8 sm:py-12">
        {queueQ.isLoading ? (
          <p className="text-center text-2xl text-slate-400">Loading queue…</p>
        ) : queueQ.isError || !queue ? (
          <div className="rounded-xl border border-slate-800 p-8 text-center">
            <p className="text-xl">Queue display unavailable</p>
            <p className="mt-2 text-sm text-slate-400">Check the doctor selection and try again.</p>
          </div>
        ) : (
          <>
            <section aria-label="Room status" className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:grid-cols-3 sm:p-6">
              <div>
                <p className="text-xs uppercase tracking-widest text-slate-400">Room</p>
                <p className="mt-1 text-lg font-semibold">{roomCode ? `Room ${roomCode}` : "Not assigned"}</p>
                <p className="text-sm text-slate-400">
                  {room?.name ?? (roomsQ.isError ? "Room list unavailable — configured by seed/admin API" : "Room details unavailable")}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-widest text-slate-400">Device</p>
                {room ? (
                  <Badge variant={room.status === "ONLINE" ? "success" : "warning"} className="mt-1 bg-emerald-500/15 text-emerald-300">
                    <Wifi className="size-3" aria-hidden="true" />{room.status ?? "UNKNOWN"}
                  </Badge>
                ) : (
                  <p className="mt-1 text-sm text-slate-400">Status unavailable</p>
                )}
                <p className="mt-1 text-xs text-slate-400">Last seen {formatRelativeTime(room?.lastSeenAt ?? null)}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-widest text-slate-400">Occupancy</p>
                {latestEvent ? (
                  <Badge
                    variant={latestEvent.type === "OCCUPIED" ? "info" : latestEvent.type === "VACANT" ? "success" : "muted"}
                    className="mt-1"
                  >
                    {latestEvent.type === "OCCUPIED" ? "Occupied" : latestEvent.type === "VACANT" ? "Vacant" : "Heartbeat"}
                  </Badge>
                ) : (
                  <p className="mt-1 text-sm text-slate-400">No sensor events</p>
                )}
                <p className="mt-1 text-xs text-slate-400">
                  {latestEvent ? `Updated ${formatRelativeTime(latestEvent.occurredAt)}` : "Sensor readings will appear here"}
                </p>
              </div>
            </section>

            <section aria-labelledby="current-token" className="rounded-3xl border border-slate-800 bg-slate-900/70 px-6 py-10 text-center shadow-2xl sm:px-12 sm:py-16">
              <p className="text-lg uppercase tracking-[0.3em] text-slate-400 sm:text-2xl">Now serving</p>
              <p
                id="current-token"
                aria-live="polite"
                className="mt-4 text-8xl font-black leading-none tracking-tight tabular-nums text-emerald-300 sm:text-[12rem]"
              >
                {queue.currentPatient ? `#${queue.currentPatient.appointment.tokenNumber}` : "—"}
              </p>
              <p className="mt-5 text-xl text-slate-200 sm:text-3xl">
                {queue.currentPatient?.appointment.patient.fullName ?? "Awaiting first patient"}
              </p>
              {queue.currentPatient && (
                <p className="mt-2 text-sm uppercase tracking-widest text-emerald-300/80 sm:text-base">
                  {queue.currentPatient.status.replace(/_/g, " ")}
                </p>
              )}
            </section>

            <section aria-labelledby="next-tokens">
              <h2 id="next-tokens" className="flex items-center gap-2 text-xl font-semibold text-slate-200 sm:text-2xl">
                <Clock3 className="size-5" /> Next up
              </h2>
              {next.length === 0 ? (
                <p className="mt-5 rounded-xl border border-slate-800 p-6 text-lg text-slate-400">No patients waiting.</p>
              ) : (
                <div className="mt-5 grid gap-4 sm:grid-cols-3">
                  {next.map((entry) => (
                    <div key={entry.id} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-center">
                      <p className="text-xs uppercase tracking-widest text-slate-400">Position {entry.position}</p>
                      <p className="mt-2 text-6xl font-bold tabular-nums text-slate-50 sm:text-7xl">#{entry.appointment.tokenNumber}</p>
                      <p className="mt-3 truncate text-lg text-slate-300">{entry.appointment.patient.fullName}</p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-5 text-sm text-slate-400">
          <p>
            Last updated {updatedAt ? `${formatRelativeTime(updatedAt.toISOString())} (${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })})` : "—"}
          </p>
          <p>{queue ? `${queue.entries.length} entries today` : ""}</p>
        </footer>
      </main>
    </div>
  );
}
