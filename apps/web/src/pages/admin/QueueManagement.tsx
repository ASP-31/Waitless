import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  DoorOpen,
  ListOrdered,
  MonitorPlay,
  PhoneCall,
  Radio,
  Play,
  RefreshCw,
  SkipForward,
  Timer,
  UserCheck,
  UserX,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { listDoctors, updateDoctor, type Doctor } from "@/lib/admin-api";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSocket } from "@/hooks/use-socket";
import { ApiError, api } from "@/lib/api";
import { formatEtaRange, formatElapsed, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type QueueEntry = {
  id: string;
  position: number;
  status: string;
  calledAt: string | null;
  estimatedStartAt: string | null;
  estimatedWaitMinutes?: number;
  etaRange?: { min: number; max: number };
  appointment: {
    tokenNumber: number;
    slotStart: string;
    patient: { fullName: string; phone: string };
  };
};

type QueueData = {
  doctor: { id: string; fullName: string };
  date: string;
  entries: QueueEntry[];
  currentPatient: QueueEntry | null;
  stats: {
    waiting: number;
    called: number;
    inConsultation: number;
    completed: number;
    skipped: number;
    avgConsultMinutes: number;
    patientsAhead: number;
    estimatedWaitMinutes?: number;
  };
};

type HardwareEvent = {
  id: string;
  type: string;
  result: string | null;
  occurredAt: string;
  receivedAt: string;
  room?: { code: string; name: string } | null;
  doctor?: { fullName: string } | null;
};

type HardwareRoom = {
  id: string;
  code: string;
  name: string;
  status?: string | null;
  lastSeenAt?: string | null;
  doctor?: { id: string; fullName: string; isActive?: boolean } | null;
};

type ActionKind = "call" | "start" | "complete" | "skip" | "arrive" | "no-show" | "reorder";
const UPCOMING = new Set(["WAITING", "NOTIFIED", "DELAYED", "BOOKED"]);
const REORDERABLE = new Set(["WAITING", "NOTIFIED", "DELAYED", "BOOKED"]);
const NO_SHOWABLE = new Set(["WAITING", "NOTIFIED", "DELAYED", "CALLED"]);

function statusVariant(status: string): "default" | "success" | "warning" | "danger" | "info" | "muted" {
  if (status === "COMPLETED") return "success";
  if (["SKIPPED", "CANCELLED", "NO_SHOW"].includes(status)) return "danger";
  if (["CALLED", "DELAYED"].includes(status)) return "warning";
  if (status === "IN_CONSULTATION") return "info";
  return "muted";
}

export function QueueManagementPage() {
  const qc = useQueryClient();
  const today = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }, []);
  const [date, setDate] = useState(today);
  const [doctorId, setDoctorId] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [reason, setReason] = useState("");
  const [roomFilter, setRoomFilter] = useState("all");
  const [roomChoice, setRoomChoice] = useState("");

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const doctorsQ = useQuery({ queryKey: ["doctors", "queue"], queryFn: async () => (await listDoctors({ includeInactive: false })).doctors });
  const doctors = doctorsQ.data ?? [];
  const selectedDoctorId = doctorId || doctors[0]?.id || "";
  useSocket({ doctorIds: selectedDoctorId ? [selectedDoctorId] : [] });

  const queueQ = useQuery({
    queryKey: ["queue", selectedDoctorId, date],
    queryFn: async () => (await api.get<{ data: QueueData }>(`/queue/${selectedDoctorId}?date=${date}`)).data,
    enabled: !!selectedDoctorId,
    refetchInterval: 15_000,
  });

  const doctorRecord = doctors.find((doctor) => doctor.id === selectedDoctorId) ?? null;
  const roomsQ = useQuery({
    queryKey: ["hardware", "rooms"],
    queryFn: async () => (await api.get<{ data: { rooms: HardwareRoom[] } }>("/hardware/rooms")).data.rooms,
    refetchInterval: 30_000,
    retry: false,
  });
  const eventsQ = useQuery({
    queryKey: ["hardware", "events", roomFilter],
    queryFn: async () =>
      (await api.get<{ data: { events: HardwareEvent[] } }>(`/hardware/events${roomFilter === "all" ? "" : `?room=${encodeURIComponent(roomFilter)}`}`))
        .data.events.slice(0, 20),
    refetchInterval: 30_000,
    retry: false,
  });

  const action = useMutation({
    mutationFn: async ({ id, kind, position, reason: actionReason }: { id: string; kind: ActionKind; position?: number; reason?: string }) => {
      const body: Record<string, unknown> = {};
      if (kind === "reorder") body.position = position;
      const trimmed = actionReason?.trim();
      if (kind === "skip") body.reason = trimmed || "Skipped by staff";
      else if (trimmed && ["call", "no-show", "reorder"].includes(kind)) body.reason = trimmed;
      return api.patch(`/queue/entries/${id}/${kind}`, body);
    },
    onSuccess: async () => {
      setReason("");
      await qc.invalidateQueries({ queryKey: ["queue"] });
      await qc.invalidateQueries({ queryKey: ["appointments"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Queue action failed"),
  });

  const roomMut = useMutation({
    mutationFn: async ({ doctorId: id, roomId }: { doctorId: string; roomId: string | null }) => updateDoctor(id, { roomId }),
    onSuccess: async (_doctor, variables) => {
      setRoomChoice("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["doctors"] }),
        qc.invalidateQueries({ queryKey: ["queue"] }),
        qc.invalidateQueries({ queryKey: ["hardware", "rooms"] }),
      ]);
      toast.success(variables.roomId ? "Room assigned" : "Room assignment cleared");
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save room assignment"),
  });

  const rooms = roomsQ.data ?? [];
  const currentRoom = rooms.find((room) => room.id === doctorRecord?.roomId) ?? doctorRecord?.room ?? null;
  const currentRoomId = doctorRecord?.roomId ?? currentRoom?.id ?? "";
  const effectiveRoomId = roomChoice || currentRoomId;
  const assignableRooms = rooms.filter((room) => !room.doctor || room.doctor.id === selectedDoctorId);
  const deviceStatus = rooms.find((room) => room.id === currentRoomId)?.status ?? null;

  const q = queueQ.data;
  const sorted = q ? [...q.entries].sort((a, b) => a.position - b.position) : [];
  const nextUpId = sorted.find((entry) => UPCOMING.has(entry.status) && entry.id !== q?.currentPatient?.id)?.id;
  const maxPosition = sorted.reduce((max, entry) => Math.max(max, entry.position), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Queue management"
        description="Call, start, complete and manage the live queue for each doctor."
        actions={
          <>
            {selectedDoctorId && (
              <Button variant="outline" asChild>
                <Link to={`/admin/room/${selectedDoctorId}`} aria-label="Open wall display for selected doctor">
                  <MonitorPlay className="size-4" />Wall display
                </Link>
              </Button>
            )}
            <Button variant="outline" onClick={() => void qc.invalidateQueries({ queryKey: ["queue"] })}>
              <RefreshCw className="size-4" />Refresh
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={selectedDoctorId}
          onValueChange={(value) => {
            setDoctorId(value);
            setRoomChoice("");
          }}
        >
          <SelectTrigger className="w-full sm:w-64" aria-label="Select doctor">
            <SelectValue placeholder={doctorsQ.isLoading ? "Loading doctors…" : "Select doctor"} />
          </SelectTrigger>
          <SelectContent>
            {doctors.map((d: Doctor) => <SelectItem key={d.id} value={d.id}>{d.fullName}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" value={date} aria-label="Queue date" onChange={(e) => setDate(e.target.value)} className="w-auto" />
        <div className="flex w-full flex-col gap-1 sm:w-64">
          <Label htmlFor="queue-reason" className="text-xs text-muted-foreground">Reason (optional)</Label>
          <Input
            id="queue-reason"
            value={reason}
            maxLength={300}
            placeholder="Used for call, skip, no-show, reorder"
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        {q && (
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="muted">Waiting: {q.stats.waiting}</Badge>
            <Badge variant="warning">Called: {q.stats.called}</Badge>
            <Badge variant="info">In consult: {q.stats.inConsultation}</Badge>
            <Badge variant="success">Completed: {q.stats.completed}</Badge>
            <Badge variant="danger">Skipped: {q.stats.skipped}</Badge>
            <Badge variant="neutral">Avg consult: {Math.round(q.stats.avgConsultMinutes)} min</Badge>
          </div>
        )}
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1.5">
            <p className="flex items-center gap-2 text-sm font-medium"><DoorOpen className="size-4 text-muted-foreground" aria-hidden="true" />Room assignment</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {selectedDoctorId
                ? `${doctorRecord?.fullName ?? "Doctor"} · ${currentRoom ? `Room ${currentRoom.code}${currentRoom.name ? ` (${currentRoom.name})` : ""}` : "No room assigned"}`
                : "Select a doctor to see their room."}
              {" "}Saved on the doctor profile — each room has one doctor.
            </p>
            {deviceStatus && <Badge variant={deviceStatus === "ONLINE" ? "success" : "warning"}>Device {deviceStatus}</Badge>}
            {roomsQ.isError && (
              <p className="text-xs text-warning-foreground" role="status">
                Room list unavailable — rooms are configured by the seed or admin API.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={effectiveRoomId}
              onValueChange={setRoomChoice}
              disabled={!selectedDoctorId || roomsQ.isLoading || roomsQ.isError || roomMut.isPending}
            >
              <SelectTrigger className="w-full sm:w-60" aria-label="Select room to assign">
                <SelectValue placeholder={roomsQ.isError ? "Room list unavailable" : "Select room"} />
              </SelectTrigger>
              <SelectContent>
                {currentRoom && !assignableRooms.some((room) => room.id === currentRoom.id) && (
                  <SelectItem value={currentRoom.id}>Room {currentRoom.code} (current)</SelectItem>
                )}
                {assignableRooms.map((room) => (
                  <SelectItem key={room.id} value={room.id}>{room.code} · {room.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={!selectedDoctorId || !effectiveRoomId || effectiveRoomId === currentRoomId || roomMut.isPending || roomsQ.isError}
              onClick={() => roomMut.mutate({ doctorId: selectedDoctorId, roomId: effectiveRoomId })}
            >
              Save room
            </Button>
            {currentRoom && (
              <Button
                size="sm"
                variant="ghost"
                disabled={roomMut.isPending || roomsQ.isError}
                onClick={() => roomMut.mutate({ doctorId: selectedDoctorId, roomId: null })}
              >
                Clear room
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {!selectedDoctorId ? (
            <div className="p-6 text-sm text-muted-foreground">Select a doctor to view their queue.</div>
          ) : queueQ.isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading queue…</div>
          ) : !q || q.entries.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground flex items-center gap-2"><ListOrdered className="size-4" />No queue entries for this day.</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pos</TableHead>
                    <TableHead>Token</TableHead>
                    <TableHead>Patient</TableHead>
                    <TableHead>Slot</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>ETA</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((e) => {
                    const isNext = e.id === nextUpId;
                    const canReorder = REORDERABLE.has(e.status);
                    const name = e.appointment.patient.fullName;
                    return (
                      <TableRow key={e.id} className={cn(isNext && "bg-primary/5")}>
                        <TableCell className="font-medium">
                          <span className="flex items-center gap-1.5">
                            {e.position}
                            {isNext && <Badge variant="info">Next up</Badge>}
                          </span>
                        </TableCell>
                        <TableCell className="font-medium">#{e.appointment.tokenNumber}</TableCell>
                        <TableCell>
                          <div>{name}</div>
                          <div className="text-xs text-muted-foreground">{e.appointment.patient.phone}</div>
                        </TableCell>
                        <TableCell>{new Date(e.appointment.slotStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant={statusVariant(e.status)}>{e.status.replace(/_/g, " ")}</Badge>
                            {e.status === "CALLED" && (
                              <span className="flex items-center gap-1 text-xs tabular-nums text-warning-foreground" title="Time since called">
                                <Timer className="size-3" aria-hidden="true" />
                                <span aria-label={`Called ${formatElapsed(e.calledAt, now)} ago`}>{formatElapsed(e.calledAt, now)}</span>
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatEtaRange(e.etaRange)}
                          {e.estimatedStartAt && (
                            <span className="block text-[11px]">
                              {new Date(e.estimatedStartAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Move ${name} up`}
                              disabled={action.isPending || !canReorder || e.position <= 1}
                              onClick={() => action.mutate({ id: e.id, kind: "reorder", position: e.position - 1, reason })}
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Move ${name} down`}
                              disabled={action.isPending || !canReorder || e.position >= maxPosition}
                              onClick={() => action.mutate({ id: e.id, kind: "reorder", position: e.position + 1, reason })}
                            >
                              <ArrowDown />
                            </Button>
                            {["WAITING", "NOTIFIED", "DELAYED", "BOOKED"].includes(e.status) && (
                              <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate({ id: e.id, kind: "call", reason })}>
                                <PhoneCall className="size-4" />Call
                              </Button>
                            )}
                            {e.status === "CALLED" && (
                              <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate({ id: e.id, kind: "start" })}>
                                <Play className="size-4" />Start
                              </Button>
                            )}
                            {e.status === "IN_CONSULTATION" && (
                              <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate({ id: e.id, kind: "complete" })}>
                                <CheckCircle2 className="size-4" />Complete
                              </Button>
                            )}
                            {["CALLED", "DELAYED"].includes(e.status) && (
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Skip ${name}`}
                                disabled={action.isPending}
                                onClick={() => action.mutate({ id: e.id, kind: "skip", reason })}
                              >
                                <SkipForward />
                              </Button>
                            )}
                            {NO_SHOWABLE.has(e.status) && (
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Mark ${name} as no-show`}
                                disabled={action.isPending}
                                onClick={() => action.mutate({ id: e.id, kind: "no-show", reason })}
                              >
                                <UserX />
                              </Button>
                            )}
                            {e.status === "SKIPPED" && (
                              <Button size="sm" variant="ghost" disabled={action.isPending} onClick={() => action.mutate({ id: e.id, kind: "arrive" })}>
                                <UserCheck className="size-4" />Requeue
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base"><Radio className="size-4 text-muted-foreground" aria-hidden="true" />Hardware events</CardTitle>
              <CardDescription>Last 20 signed room events, newest first. Occupancy is advisory only.</CardDescription>
            </div>
            <Select value={roomFilter} onValueChange={setRoomFilter}>
              <SelectTrigger className="w-full sm:w-48" aria-label="Filter hardware events by room">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All rooms</SelectItem>
                {rooms.map((room) => <SelectItem key={room.id} value={room.code}>{room.code} · {room.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {eventsQ.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading hardware events…</p>
          ) : eventsQ.isError ? (
            <p className="p-6 text-sm text-muted-foreground" role="alert">Hardware events are unavailable right now.</p>
          ) : (eventsQ.data ?? []).length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No hardware events recorded for this room yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table aria-label="Recent hardware events">
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Room</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Doctor</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(eventsQ.data ?? []).map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground" title={new Date(event.occurredAt).toLocaleString()}>
                        {formatRelativeTime(event.occurredAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{event.room?.code ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={event.type === "OCCUPIED" ? "info" : event.type === "VACANT" ? "success" : "muted"}>
                          {event.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{event.result ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{event.doctor?.fullName ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
