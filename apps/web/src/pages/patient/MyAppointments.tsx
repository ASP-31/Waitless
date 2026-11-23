import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarX2, Download, Repeat2, Ticket, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { ApiError, api } from "@/lib/api";
import { CardEmptyState } from "@/components/shared/empty-state";
import { PatientSignInPrompt } from "@/components/shared/patient-sign-in-prompt";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buildIcsCalendar, downloadIcsFile } from "@/lib/ics";

type Appointment = {
  id: string;
  tokenNumber: number;
  serviceDay: string;
  slotStart: string;
  slotEnd?: string | null;
  status: string;
  doctor: { fullName: string; department?: { name: string } | null; room?: { code: string } | null };
  department?: { name: string } | null;
  cancelReason?: string | null;
};

type SwapCandidate = {
  appointmentId: string;
  tokenNumber: number;
  slotStart: string;
  /** Masked initials only — the API never returns another patient's name or phone. */
  patientInitials: string;
};

const UPCOMING = new Set(["BOOKED", "WAITING", "NOTIFIED", "CALLED", "IN_CONSULTATION", "DELAYED"]);
const CANCELLED = new Set(["CANCELLED", "SKIPPED", "NO_SHOW"]);
const SWAPPABLE = new Set(["BOOKED", "WAITING", "NOTIFIED"]);

function statusVariant(status: string): "default" | "success" | "warning" | "danger" | "info" | "muted" {
  if (status === "COMPLETED") return "success";
  if (status === "CANCELLED" || status === "NO_SHOW" || status === "SKIPPED") return "danger";
  if (status === "DELAYED" || status === "CALLED") return "warning";
  if (status === "IN_CONSULTATION") return "info";
  return "muted";
}

function canCancel(status: string) {
  return ["BOOKED", "WAITING", "NOTIFIED", "DELAYED"].includes(status);
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function AppointmentCard({
  appt,
  onCancel,
  onSwap,
  onDownload,
  cancelling,
}: {
  appt: Appointment;
  onCancel: () => void;
  onSwap: () => void;
  onDownload: () => void;
  cancelling: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Token #{appt.tokenNumber}</span>
            <Badge variant={statusVariant(appt.status)}>{appt.status.replace(/_/g, " ")}</Badge>
          </div>
          <p className="text-sm">{appt.doctor.fullName} · {appt.department?.name ?? appt.doctor.department?.name ?? "—"}</p>
          <p className="text-xs text-muted-foreground">{appt.serviceDay} · {timeLabel(appt.slotStart)}{appt.doctor.room?.code ? ` · Room ${appt.doctor.room.code}` : ""}</p>
          {appt.cancelReason && <p className="text-xs text-muted-foreground">Reason: {appt.cancelReason}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {SWAPPABLE.has(appt.status) && (
            <Button variant="outline" size="sm" onClick={onSwap} aria-label={`Swap slot for token ${appt.tokenNumber}`}>
              <Repeat2 className="size-4" />Swap slot
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onDownload}
            aria-label={`Download calendar event for token ${appt.tokenNumber}`}
          >
            <Download className="size-4" />Add to calendar
          </Button>
          {canCancel(appt.status) && (
            <Button variant="outline" size="sm" disabled={cancelling} onClick={onCancel}>
              <X className="size-4" />Cancel
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function MyAppointmentsPage() {
  const qc = useQueryClient();
  const [swapId, setSwapId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState("");
  const [swapMessage, setSwapMessage] = useState("");
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const apptsQ = useQuery({
    queryKey: ["appointments", "me"],
    queryFn: async () => (await api.get<{ data: { appointments: Appointment[] } }>("/appointments?pageSize=100")).data.appointments,
    retry: false,
  });

  const swapAppt = (apptsQ.data ?? []).find((a) => a.id === swapId) ?? null;
  const cancelAppt = (apptsQ.data ?? []).find((a) => a.id === cancelId) ?? null;

  const eligibleQ = useQuery({
    queryKey: ["swaps", "eligible", swapId],
    queryFn: async () =>
      (await api.post<{ data: { eligible: SwapCandidate[] } }>("/swaps/eligible", { appointmentId: swapId })).data.eligible,
    enabled: !!swapId,
    retry: false,
  });

  const swapMut = useMutation({
    mutationFn: async ({ requesterId, targetId: selected, message }: { requesterId: string; targetId: string; message: string }) =>
      api.post("/swaps", {
        requesterAppointmentId: requesterId,
        targetAppointmentId: selected,
        message: message.trim() || undefined,
      }),
    onSuccess: async () => {
      setSwapId(null);
      setTargetId("");
      setSwapMessage("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["swaps"] }),
        qc.invalidateQueries({ queryKey: ["appointments"] }),
        qc.invalidateQueries({ queryKey: ["queue"] }),
      ]);
      toast.success("Swap request sent — the other patient can accept or decline");
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not send the swap request"),
  });

  const cancelMut = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      api.patch<{ data: { appointment: Appointment } }>(`/appointments/${id}/cancel`, {
        reason: reason.trim() || undefined,
      }),
    onSuccess: async () => {
      setCancelId(null);
      setCancelReason("");
      await qc.invalidateQueries({ queryKey: ["appointments"] });
      await qc.invalidateQueries({ queryKey: ["queue"] });
      toast.success("Appointment cancelled");
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not cancel appointment"),
  });

  const unauthorized =
    [apptsQ.error, eligibleQ.error, swapMut.error, cancelMut.error].some(
      (error) => error instanceof ApiError && error.status === 401,
    );

  const groups = useMemo(() => {
    const items = apptsQ.data ?? [];
    return {
      upcoming: items.filter((a) => UPCOMING.has(a.status)),
      past: items.filter((a) => a.status === "COMPLETED"),
      cancelled: items.filter((a) => CANCELLED.has(a.status)),
    };
  }, [apptsQ.data]);

  function downloadIcs(appt: Appointment) {
    const location = [appt.doctor.room?.code ? `Room ${appt.doctor.room.code}` : null, appt.department?.name ?? appt.doctor.department?.name]
      .filter(Boolean)
      .join(", ");
    const contents = buildIcsCalendar([
      {
        id: appt.id,
        title: `Visit with ${appt.doctor.fullName}`,
        start: appt.slotStart,
        end: appt.slotEnd,
        description: `Waitless token #${appt.tokenNumber}. Status: ${appt.status.replace(/_/g, " ")}.`,
        location: location || undefined,
      },
    ]);
    downloadIcsFile(`waitless-token-${appt.tokenNumber}-${appt.serviceDay}.ics`, contents);
    toast.success("Calendar event downloaded");
  }

  function openSwap(appt: Appointment) {
    setSwapId(appt.id);
    setTargetId("");
    setSwapMessage("");
  }

  function openCancel(appt: Appointment) {
    setCancelId(appt.id);
    setCancelReason("");
  }

  function renderList(list: Appointment[], emptyTitle: string, emptyDesc: string) {
    if (apptsQ.isLoading) return <p className="text-sm text-muted-foreground">Loading appointments…</p>;
    if (apptsQ.isError) {
      const message = apptsQ.error instanceof ApiError ? apptsQ.error.message : "Could not load appointments";
      return (
        <Card>
          <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between" role="alert">
            <p className="text-sm text-muted-foreground">{message}</p>
            <Button variant="outline" size="sm" onClick={() => void apptsQ.refetch()}>Try again</Button>
          </CardContent>
        </Card>
      );
    }
    if (list.length === 0) {
      return (
        <CardEmptyState
          icon={list === groups.upcoming ? Ticket : CalendarX2}
          title={emptyTitle}
          description={emptyDesc}
          action={list === groups.upcoming ? <Button asChild size="sm"><Link to="/patient/book">Book an appointment</Link></Button> : undefined}
        />
      );
    }
    return (
      <div className="space-y-3">
        {list.map((appt) => (
          <AppointmentCard
            key={appt.id}
            appt={appt}
            cancelling={cancelMut.isPending}
            onCancel={() => openCancel(appt)}
            onSwap={() => openSwap(appt)}
            onDownload={() => downloadIcs(appt)}
          />
        ))}
      </div>
    );
  }

  if (unauthorized) {
    return (
      <div className="space-y-6">
        <PageHeader title="My visits" description="Every appointment, with its token and current status." />
        <PatientSignInPrompt
          title="Sign in to see your visits"
          description="Your session isn't active. Sign in with the same mobile number to view, swap or cancel appointments."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="My visits"
        description="Every appointment, with its token and current status."
        actions={<Button asChild><Link to="/patient/book">Book a visit</Link></Button>}
      />

      <Tabs defaultValue="upcoming">
        <TabsList>
          <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
          <TabsTrigger value="past">Past</TabsTrigger>
          <TabsTrigger value="cancelled">Cancelled</TabsTrigger>
        </TabsList>

        <TabsContent value="upcoming">
          {renderList(groups.upcoming, "No upcoming appointments", "Once you book, your token and live queue position appear here.")}
        </TabsContent>
        <TabsContent value="past">
          {renderList(groups.past, "No past visits yet", "Completed consultations will be listed here for your records.")}
        </TabsContent>
        <TabsContent value="cancelled">
          {renderList(groups.cancelled, "Nothing cancelled", "Cancelled appointments stay visible here, with the reason if the hospital added one.")}
        </TabsContent>
      </Tabs>

      <Dialog open={!!swapAppt} onOpenChange={(open) => !open && setSwapId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Swap token #{swapAppt?.tokenNumber}</DialogTitle>
            <DialogDescription>
              Choose another patient&apos;s slot on the same day with the same doctor. Only masked initials are shown;
              the other patient must accept before anything changes.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {eligibleQ.isLoading ? (
              <p className="text-sm text-muted-foreground">Finding eligible slots…</p>
            ) : eligibleQ.isError ? (
              <p className="text-sm text-destructive" role="alert">
                {eligibleQ.error instanceof ApiError ? eligibleQ.error.message : "Could not load eligible slots. Please try again."}
              </p>
            ) : (eligibleQ.data ?? []).length === 0 ? (
              <p className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                No eligible slots are available right now. Check back later or ask at the desk.
              </p>
            ) : (
              <fieldset className="max-h-64 space-y-2 overflow-y-auto rounded-lg border p-2">
                <legend className="sr-only">Eligible appointment slots</legend>
                {eligibleQ.data?.map((candidate) => (
                  <label
                    key={candidate.appointmentId}
                    className="flex cursor-pointer items-start gap-3 rounded-md p-2 text-sm hover:bg-accent"
                  >
                    <input
                      type="radio"
                      name="swap-target"
                      className="mt-1 accent-primary"
                      value={candidate.appointmentId}
                      checked={targetId === candidate.appointmentId}
                      onChange={() => setTargetId(candidate.appointmentId)}
                      aria-label={`Swap with token ${candidate.tokenNumber} at ${timeLabel(candidate.slotStart)}, patient ${candidate.patientInitials}`}
                    />
                    <span>
                      <span className="font-medium">Token #{candidate.tokenNumber} · {timeLabel(candidate.slotStart)}</span>
                      <span className="block text-xs text-muted-foreground">Other patient: {candidate.patientInitials}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="swap-message">Message (optional)</Label>
            <Input
              id="swap-message"
              value={swapMessage}
              maxLength={300}
              placeholder="e.g. Would 11:30 work for you?"
              onChange={(event) => setSwapMessage(event.target.value)}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSwapId(null)}>Not now</Button>
            <Button
              disabled={!targetId || eligibleQ.isLoading || !!eligibleQ.error || swapMut.isPending}
              onClick={() => swapAppt && swapMut.mutate({ requesterId: swapAppt.id, targetId, message: swapMessage })}
            >
              {swapMut.isPending ? "Sending…" : "Send swap request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!cancelAppt} onOpenChange={(open) => !open && setCancelId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel token #{cancelAppt?.tokenNumber}?</DialogTitle>
            <DialogDescription>
              This frees the slot for another patient. You can book a new visit afterwards, but this action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="cancel-reason">Reason (optional)</Label>
            <Input
              id="cancel-reason"
              value={cancelReason}
              maxLength={300}
              placeholder="e.g. Can no longer attend"
              onChange={(event) => setCancelReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelId(null)}>Keep appointment</Button>
            <Button
              variant="destructive"
              disabled={cancelMut.isPending}
              onClick={() => cancelAppt && cancelMut.mutate({ id: cancelAppt.id, reason: cancelReason })}
            >
              {cancelMut.isPending ? "Cancelling…" : "Cancel appointment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
