import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, BellRing, CheckCircle2, Circle, CircleDot, Clock3, ListOrdered, MapPin, Timer, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { PatientSignInPrompt } from "@/components/shared/patient-sign-in-prompt";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useSocket } from "@/hooks/use-socket";
import { ApiError, api } from "@/lib/api";
import { formatEtaRange } from "@/lib/format";
import { cn } from "@/lib/utils";

type Appointment = {
  id: string;
  doctorId: string;
  serviceDay: string;
  tokenNumber: number;
  status: string;
  slotStart: string;
  doctor: { fullName: string; room?: { code: string } | null; department?: { name: string } | null };
};
type QueueEntry = {
  id: string;
  position: number;
  status: string;
  selfCheckInAt?: string | null;
  estimatedStartAt: string | null;
  estimatedWaitMinutes?: number;
  etaRange?: { min: number; max: number };
  appointment: { id: string; tokenNumber: number; patient: { fullName: string } };
};
type QueueData = {
  entries: QueueEntry[];
  currentPatient: QueueEntry | null;
  stats: { waiting: number; avgConsultMinutes: number; patientsAhead?: number; estimatedWaitMinutes?: number };
};

const ACTIVE = new Set(["BOOKED", "WAITING", "NOTIFIED", "CALLED", "IN_CONSULTATION", "DELAYED"]);
const CHECK_IN_KEY = "waitless:self-check-ins";

function readCheckedIn(): string[] {
  try {
    const value = sessionStorage.getItem(CHECK_IN_KEY);
    return value ? (JSON.parse(value) as string[]) : [];
  } catch {
    return [];
  }
}

type TimelineState = "done" | "current" | "upcoming";
type TimelineBranch = { label: string; detail: string; tone: "warning" | "danger" | "muted" };

const TIMELINE_STEPS = ["Booked", "Waiting / called", "In consultation", "Completed"];
const STEP_DETAILS: Record<string, string> = {
  NOTIFIED: "You've been notified",
  CALLED: "Head to the room",
  DELAYED: "Running late",
  IN_CONSULTATION: "With the doctor",
};

/** Maps an appointment or queue-entry status onto the patient-facing journey. */
function timelinePosition(status: string | null): number | null {
  if (!status) return null;
  if (status === "BOOKED") return 0;
  if (["WAITING", "NOTIFIED", "CALLED", "DELAYED"].includes(status)) return 1;
  if (status === "IN_CONSULTATION") return 2;
  if (status === "COMPLETED") return 3;
  if (["SKIPPED", "NO_SHOW", "CANCELLED"].includes(status)) return 1;
  return null;
}

function timelineBranch(status: string | null): TimelineBranch | null {
  if (status === "DELAYED") {
    return { label: "Delayed", detail: "Your visit is running late. Check at the desk if you need help.", tone: "warning" };
  }
  if (status === "SKIPPED") {
    return { label: "Skipped", detail: "Your turn was skipped. Please check in at the desk.", tone: "danger" };
  }
  if (status === "NO_SHOW") {
    return { label: "No show", detail: "This visit was marked as a no-show. Please speak to the desk.", tone: "danger" };
  }
  if (status === "CANCELLED") {
    return { label: "Cancelled", detail: "This appointment was cancelled.", tone: "muted" };
  }
  return null;
}

function StatusTimeline({ status }: { status: string | null }) {
  const position = timelinePosition(status);
  const branch = timelineBranch(status);
  const label = status ? status.replace(/_/g, " ") : "No active visit";

  return (
    <section aria-label="Visit status timeline" className="space-y-2 rounded-xl border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Visit progress</p>
        <Badge
          variant={
            branch?.tone === "danger" ? "danger" : branch?.tone === "warning" ? "warning" : status === "COMPLETED" ? "success" : "info"
          }
        >
          {label}
        </Badge>
      </div>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TIMELINE_STEPS.map((step, index) => {
          const state: TimelineState = position === null ? "upcoming" : index < position ? "done" : index === position ? "current" : "upcoming";
          const Icon = state === "done" ? CheckCircle2 : state === "current" ? CircleDot : Circle;
          const detail = state === "current" ? (STEP_DETAILS[status ?? ""] ?? branch?.label) : undefined;
          return (
            <li
              key={step}
              aria-current={state === "current" ? "step" : undefined}
              className={cn(
                "flex items-start gap-2 rounded-lg border p-2 text-xs",
                state === "current" && "border-primary/40 bg-primary/10 font-medium text-foreground",
                state === "done" && "border-transparent bg-success/10 text-success-foreground",
                state === "upcoming" && "border-transparent bg-muted/40 text-muted-foreground",
              )}
            >
              <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block">{step}</span>
                {detail && <span className="block text-[11px] font-normal text-muted-foreground">{detail}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {branch && (
        <p
          role="status"
          className={cn(
            "flex items-start gap-1.5 text-xs",
            branch.tone === "danger" ? "text-destructive" : branch.tone === "warning" ? "text-warning-foreground" : "text-muted-foreground",
          )}
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {branch.detail}
        </p>
      )}
    </section>
  );
}

export function QueueStatusPage() {
  const qc = useQueryClient();
  const [checkedInIds, setCheckedInIds] = useState<string[]>(readCheckedIn);

  const apptsQ = useQuery({
    queryKey: ["appointments", "me", "queue"],
    queryFn: async () => (await api.get<{ data: { appointments: Appointment[] } }>("/appointments?pageSize=50")).data.appointments,
    refetchInterval: 15_000,
  });
  // Show the live visit first; otherwise fall back to the most recent visit so
  // the timeline can still highlight completed/skipped/no-show branches.
  const active = useMemo(() => {
    const items = apptsQ.data ?? [];
    return (
      items.find((a) => ACTIVE.has(a.status)) ??
      [...items].sort((a, b) => b.slotStart.localeCompare(a.slotStart))[0] ??
      null
    );
  }, [apptsQ.data]);

  // Socket events invalidate these queries; the 15s poll remains as a fallback.
  const { connected } = useSocket({ doctorIds: active?.doctorId ? [active.doctorId] : [] });

  const queueQ = useQuery({
    queryKey: ["queue", active?.doctorId, active?.serviceDay],
    queryFn: async () => (await api.get<{ data: QueueData }>(`/queue/${active!.doctorId}?date=${active!.serviceDay}`)).data,
    enabled: !!active && ACTIVE.has(active.status),
    refetchInterval: 15_000,
  });

  const checkIn = useMutation({
    mutationFn: (entryId: string) => api.post(`/queue/entries/${entryId}/check-in`),
    onSuccess: async (_result, entryId) => {
      setCheckedInIds((current) => {
        const next = current.includes(entryId) ? current : [...current, entryId];
        try {
          sessionStorage.setItem(CHECK_IN_KEY, JSON.stringify(next));
        } catch {
          // Session storage can be disabled; in-memory guard still applies.
        }
        return next;
      });
      toast.success("You're checked in — we'll show your live position shortly");
      await qc.invalidateQueries({ queryKey: ["queue"] });
      await qc.invalidateQueries({ queryKey: ["appointments"] });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not check in. Please see the reception desk."),
  });

  const unauthorized = [apptsQ.error, queueQ.error, checkIn.error].some(
    (error) => error instanceof ApiError && error.status === 401,
  );

  const myEntry = queueQ.data?.entries.find((e) => e.appointment.id === active?.id) ?? null;
  const currentStatus = myEntry?.status ?? active?.status ?? null;
  const nowServing = queueQ.data?.currentPatient?.appointment.tokenNumber ?? null;
  const patientsAhead =
    queueQ.data && myEntry
      ? queueQ.data.stats.patientsAhead ??
        queueQ.data.entries.filter((e) => e.position < myEntry.position && !["COMPLETED", "SKIPPED"].includes(e.status)).length
      : null;
  const eta = formatEtaRange(myEntry?.etaRange);
  const etaTime = myEntry?.estimatedStartAt
    ? new Date(myEntry.estimatedStartAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const checkedIn = !!myEntry?.selfCheckInAt || (!!myEntry && checkedInIds.includes(myEntry.id));
  const canCheckIn = !!myEntry && !checkedIn && ["BOOKED", "WAITING", "DELAYED"].includes(myEntry.status);

  if (unauthorized) {
    return (
      <div className="space-y-6">
        <PageHeader title="Live queue" description="Your token, the patients ahead of you and an estimate that updates as the clinic moves." />
        <PatientSignInPrompt
          title="Sign in to see your queue"
          description="Your session isn't active. Sign in with the same mobile number to track your live token."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Live queue"
        description="Your token, the patients ahead of you and an estimate that updates as the clinic moves."
      />

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Card className="gap-0 overflow-hidden p-0">
          <div className="flex items-start justify-between border-b bg-muted/40 px-5 py-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{active ? active.doctor.fullName : "No active visit"}</p>
              <p className="text-xs text-muted-foreground">
                {active ? `${active.doctor.department?.name ?? "Clinic"} · ${active.serviceDay}` : "Token appears after booking/check-in"}
              </p>
            </div>
            <Badge variant={active ? "info" : "neutral"}>{active ? active.status.replace(/_/g, " ") : "Idle"}</Badge>
          </div>

          <CardContent className="space-y-6 p-5">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Your token</p>
                <p className="text-5xl font-semibold tabular-nums">{active ? `#${active.tokenNumber}` : "—"}</p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Now serving</p>
                <p className="text-2xl font-semibold tabular-nums">{nowServing ? `#${nowServing}` : "—"}</p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {[
                { icon: Users, label: "Ahead", value: patientsAhead != null ? String(patientsAhead) : "—", hint: undefined },
                { icon: Timer, label: "Est. wait", value: eta, hint: etaTime ? `around ${etaTime}` : undefined },
                { icon: Clock3, label: "Slot", value: active ? new Date(active.slotStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—", hint: undefined },
              ].map((item) => (
                <div key={item.label} className="rounded-lg bg-muted/40 p-3">
                  <item.icon className="mb-2 size-4 text-muted-foreground" aria-hidden="true" />
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  <p className="text-sm font-medium">{item.value}</p>
                  {item.hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{item.hint}</p>}
                </div>
              ))}
            </div>

            <StatusTimeline status={currentStatus} />

            {!active ? (
              <div className="flex flex-col gap-2 rounded-xl border border-dashed bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2">
                  <ListOrdered className="mt-0.5 size-4 text-primary" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground">Book a slot to see your live position here.</p>
                </div>
                <Button size="sm" asChild><Link to="/patient/book">Book a visit</Link></Button>
              </div>
            ) : (
              <div className="space-y-3 rounded-xl border bg-muted/20 p-4 text-sm text-muted-foreground">
                {myEntry ? (
                  <p>You are at position <span className="font-medium text-foreground">{myEntry.position}</span> in the queue. Status: <span className="font-medium text-foreground">{myEntry.status.replace(/_/g, " ")}</span>.</p>
                ) : queueQ.isLoading ? (
                  <p>Loading live queue…</p>
                ) : queueQ.isError ? (
                  <p>Could not load live queue details. We&apos;ll retry automatically.</p>
                ) : (
                  <p>Your appointment is active. Queue details will appear when today&apos;s queue is prepared.</p>
                )}
                {checkedIn ? (
                  <p className="flex items-center gap-1.5 text-xs font-medium text-success">
                    <CheckCircle2 className="size-4" /> You&apos;re checked in
                  </p>
                ) : canCheckIn ? (
                  <Button
                    size="sm"
                    disabled={checkIn.isPending}
                    onClick={() => checkIn.mutate(myEntry.id)}
                  >
                    <MapPin className="size-4" />{checkIn.isPending ? "Checking in…" : "I'm here"}
                  </Button>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">How the queue works</CardTitle>
              <CardDescription>What each status means for you.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {[["Waiting", "You're checked in and hold a position."], ["Called", "Go to the room when called."], ["In consultation", "The doctor is with you now."], ["Delayed/Skipped", "Check in at the desk for assistance."]].map(([status, meaning]) => (
                <div key={status} className="flex items-start justify-between gap-3">
                  <Badge variant="outline" className="shrink-0">{status}</Badge>
                  <p className="text-right text-xs leading-relaxed text-muted-foreground">{meaning}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="bg-primary/5">
            <CardContent className="space-y-2 p-4">
              <p className="flex items-center gap-2 text-sm font-medium"><BellRing className="size-4 text-primary" />Live updates</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {connected
                  ? "Connected to realtime updates, with a 15-second refresh as a fallback."
                  : "Refreshing every 15 seconds. Realtime updates will resume automatically when the connection returns."}
              </p>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MapPin className="size-3.5" />{active?.doctor.room?.code ? `Room ${active.doctor.room.code}` : "Check room at reception"}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
