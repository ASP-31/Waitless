import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  ListOrdered,
  Repeat2,
  Stethoscope,
  Timer,
  Users,
  UserX,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { ApiStatus } from "@/components/shared/api-status";
import { PageHeader } from "@/components/shared/page-header";
import { PeakHoursChart, type PeakHour } from "@/components/shared/peak-hours-chart";
import { StatCard } from "@/components/shared/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useSocket } from "@/hooks/use-socket";
import { api, apiUrl, getAccessToken } from "@/lib/api";
import { toDateKey } from "@/lib/format";

type RangeKey = "today" | "7d" | "30d";

interface AnalyticsOverview {
  totals: {
    appointments: number;
    completed: number;
    cancelled: number;
    noShow: number;
    noShowRate: number;
  };
  avgWaitMinutes: number;
  avgConsultMinutes: number;
  peakHours: PeakHour[];
  generatedAt: string;
}

interface DoctorMetric {
  doctor?: { fullName?: string } | null;
  doctorName?: string;
  fullName?: string;
  name?: string;
  appointments?: number;
  total?: number;
  completed?: number;
  avgWaitMinutes?: number;
}

interface JobsData {
  queues?: {
    name: string;
    counts?: Record<string, number>;
    available?: boolean | number;
    failed?: unknown[];
    failedJobs?: unknown[];
  }[];
}

interface AuditItem {
  action?: string;
  createdAt?: string;
  entity?: string;
}

interface AuditData {
  items?: AuditItem[];
  meta?: { total?: number };
}

interface LiveDoctor {
  id: string;
  isActive: boolean;
}

interface LiveQueue {
  entries: { status: string; appointment: { slotStart: string } }[];
  stats: { waiting?: number; called?: number; inConsultation?: number };
}

function normalizeDoctors(payload: unknown): DoctorMetric[] {
  if (Array.isArray(payload)) return payload as DoctorMetric[];
  if (payload && typeof payload === "object" && "doctors" in payload) {
    const doctors = (payload as { doctors?: unknown }).doctors;
    if (Array.isArray(doctors)) return doctors as DoctorMetric[];
  }
  return [];
}

function doctorName(doctor: DoctorMetric) {
  return doctor.doctorName ?? doctor.name ?? doctor.fullName ?? doctor.doctor?.fullName ?? "Doctor";
}

function doctorTotal(doctor: DoctorMetric) {
  const value = doctor.appointments ?? doctor.total ?? 0;
  return typeof value === "number" ? value : 0;
}

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

export function AdminDashboardPage() {
  const [rangeKey, setRangeKey] = useState<RangeKey>("today");
  const { connected } = useSocket();
  const { from, to } = useMemo(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (rangeKey === "today" ? 0 : rangeKey === "7d" ? 6 : 29));
    return { from: toDateKey(start), to: toDateKey(end) };
  }, [rangeKey]);
  const params = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const overviewQ = useQuery({
    queryKey: ["analytics", "overview", from, to],
    queryFn: async () => (await api.get<{ data: AnalyticsOverview }>(`/analytics/overview?${params}`)).data,
    refetchInterval: 60_000,
  });
  const doctorsQ = useQuery({
    queryKey: ["analytics", "doctors", from, to],
    queryFn: async () => normalizeDoctors((await api.get<{ data: unknown }>(`/analytics/doctors?${params}`)).data),
    refetchInterval: 60_000,
  });
  const jobsQ = useQuery({
    queryKey: ["admin", "jobs"],
    queryFn: async () => (await api.get<{ data: JobsData }>("/admin/jobs")).data,
    refetchInterval: 60_000,
    retry: false,
  });
  const auditQ = useQuery({
    queryKey: ["admin", "audit"],
    queryFn: async () => (await api.get<{ data: AuditData }>("/admin/audit?limit=5")).data,
    refetchInterval: 60_000,
    retry: false,
  });

  const todayKey = useMemo(() => toDateKey(new Date()), []);
  const liveQ = useQuery({
    queryKey: ["dashboard", "live-queue", todayKey],
    queryFn: async () => {
      const doctors = (await api.get<{ data: { doctors: LiveDoctor[] } }>("/doctors?active=true&pageSize=100")).data.doctors
        .filter((doctor) => doctor.isActive)
        .slice(0, 20);
      const queues = await Promise.allSettled(
        doctors.map(async (doctor) => (await api.get<{ data: LiveQueue }>(`/queue/${doctor.id}?date=${todayKey}`)).data),
      );
      const now = Date.now();
      let waiting = 0;
      let inProgress = 0;
      let longestWaitMinutes: number | null = null;
      let reporting = 0;
      for (const result of queues) {
        if (result.status !== "fulfilled") continue;
        reporting += 1;
        const queue = result.value;
        waiting += queue.stats.waiting ?? 0;
        inProgress += (queue.stats.called ?? 0) + (queue.stats.inConsultation ?? 0);
        for (const entry of queue.entries ?? []) {
          if (!["WAITING", "NOTIFIED", "DELAYED"].includes(entry.status)) continue;
          const slotTime = new Date(entry.appointment.slotStart).getTime();
          if (!Number.isFinite(slotTime)) continue;
          const minutes = Math.max(0, Math.floor((now - slotTime) / 60_000));
          longestWaitMinutes = longestWaitMinutes === null ? minutes : Math.max(longestWaitMinutes, minutes);
        }
      }
      return { waiting, inProgress, longestWaitMinutes, reporting, doctors: doctors.length };
    },
    refetchInterval: 30_000,
    retry: false,
  });

  const csvDownload = useMutation({
    mutationFn: async () => {
      const token = getAccessToken();
      const response = await fetch(apiUrl(`/analytics/appointments.csv?${params}`), {
        credentials: "include",
        headers: {
          Accept: "text/csv",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `waitless-appointments-${from}-to-${to}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast.success("CSV export downloaded"),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not download CSV"),
  });

  const overview = overviewQ.data;
  const queues = jobsQ.data?.queues ?? [];
  const auditItems = auditQ.data?.items ?? [];
  const doctors = [...(doctorsQ.data ?? [])].sort((a, b) => doctorTotal(b) - doctorTotal(a)).slice(0, 5);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Clinic activity and operational health for the selected period."
        actions={<Button variant="outline" asChild><Link to="/admin/queue"><ListOrdered className="size-4" />Open queue</Link></Button>}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg border bg-card p-1" role="group" aria-label="Analytics date range">
          {RANGES.map((item) => (
            <Button
              key={item.key}
              size="sm"
              variant={rangeKey === item.key ? "default" : "ghost"}
              aria-pressed={rangeKey === item.key}
              onClick={() => setRangeKey(item.key)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{from} → {to}</span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={csvDownload.isPending}
          onClick={() => csvDownload.mutate()}
        >
          <Download className="size-4" /> Export CSV
        </Button>
      </div>

      <section aria-label="Live clinic status" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Right now · {todayKey}</h2>
          <span className="text-xs text-muted-foreground">
            {liveQ.data ? `${liveQ.data.reporting} of ${liveQ.data.doctors} active doctors reporting` : "Live queue snapshot"}
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            label="Waiting"
            value={liveQ.data ? liveQ.data.waiting : "—"}
            hint={overview ? `Analytics avg wait ${Math.round(overview.avgWaitMinutes)} min` : "Patients waiting today"}
            icon={Users}
            tone="info"
          />
          <StatCard
            label="Longest wait"
            value={liveQ.data?.longestWaitMinutes != null ? `${liveQ.data.longestWaitMinutes} min` : "—"}
            hint="Oldest still-waiting slot"
            icon={Timer}
            tone="warning"
          />
          <StatCard
            label="In progress"
            value={liveQ.data ? liveQ.data.inProgress : "—"}
            hint="Called or in consultation"
            icon={Activity}
            tone="success"
          />
        </div>
        {liveQ.isError && (
          <p className="text-xs text-muted-foreground" role="status">Live queue counts are unavailable; analytics cards below are still current.</p>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Appointments" value={overview?.totals.appointments ?? "—"} hint="Booked in this period" icon={CalendarDays} tone="info" />
        <StatCard label="Completed" value={overview?.totals.completed ?? "—"} hint="Consultations closed" icon={CheckCircle2} tone="success" />
        <StatCard label="Cancelled" value={overview?.totals.cancelled ?? "—"} hint="Cancelled visits" icon={Activity} tone="warning" />
        <StatCard label="No-shows" value={overview?.totals.noShow ?? "—"} hint={overview ? `${(overview.totals.noShowRate * 100).toFixed(1)}% no-show rate` : "Rate unavailable"} icon={UserX} />
        <StatCard label="Avg wait" value={overview ? `${Math.round(overview.avgWaitMinutes)} min` : "—"} hint="Check-in to call" icon={Clock3} tone="warning" />
        <StatCard label="Avg consultation" value={overview ? `${Math.round(overview.avgConsultMinutes)} min` : "—"} hint="Call to completion" icon={Stethoscope} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <CardTitle>Peak hours</CardTitle>
                <CardDescription>Appointment volume by hour for this date range.</CardDescription>
              </div>
              {overview && <Badge variant="neutral"><Activity className="size-3" />Updated {new Date(overview.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Badge>}
            </div>
          </CardHeader>
          <CardContent>
            {overviewQ.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading analytics…</p>
            ) : overviewQ.isError || !overview ? (
              <p className="text-sm text-muted-foreground">Analytics are unavailable for this period.</p>
            ) : overview.peakHours.length === 0 ? (
              <p className="text-sm text-muted-foreground">No appointments in this period yet.</p>
            ) : (
              <PeakHoursChart hours={overview.peakHours} />
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Doctor load</CardTitle>
              <CardDescription>Appointment volume by doctor.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {doctorsQ.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading doctors…</p>
              ) : doctors.length === 0 ? (
                <p className="text-sm text-muted-foreground">No doctor metrics available.</p>
              ) : (
                doctors.map((doctor, index) => (
                  <div key={`${doctorName(doctor)}-${index}`} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <Users className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{doctorName(doctor)}</span>
                    </span>
                    <Badge variant="muted">{doctorTotal(doctor)} visits</Badge>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">System</CardTitle><CardDescription>Local environment status.</CardDescription></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center justify-between"><span className="text-muted-foreground">API</span><ApiStatus /></div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Realtime</span>
                <Badge variant={connected ? "success" : "warning"}>{connected ? "Socket connected" : "Reconnecting / polling"}</Badge>
              </div>
              <div className="flex items-center justify-between"><span className="text-muted-foreground">Hardware</span><Badge variant="neutral">MQTT ingest ready</Badge></div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Background jobs</CardTitle>
            <CardDescription>Queue depth and failed jobs from the worker pool.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {jobsQ.isError || queues.length === 0 ? (
              <p className="text-muted-foreground">Job queues are unavailable right now.</p>
            ) : (
              queues.map((queue) => {
                const failedCount = queue.failedJobs?.length ?? queue.failed?.length ?? 0;
                const isAvailable = typeof queue.available === "boolean" ? queue.available : (queue.available ?? 0) > 0;
                return (
                  <div key={queue.name} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2">
                    <span className="font-medium">{queue.name}</span>
                    <span className="flex flex-wrap gap-1.5">
                      <Badge variant={isAvailable ? "success" : "warning"}>{isAvailable ? "Available" : "Unavailable"}</Badge>
                      <Badge variant={failedCount ? "danger" : "neutral"}>{failedCount} failed</Badge>
                      {queue.counts && <Badge variant="muted">{queue.counts.waiting ?? 0} waiting</Badge>}
                    </span>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Audit activity</CardTitle>
            <CardDescription>Most recent administrative actions.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {auditQ.isError || auditItems.length === 0 ? (
              <p className="text-muted-foreground">No audit activity available.</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">{auditQ.data?.meta?.total ?? auditItems.length} total entries</p>
                {auditItems.slice(0, 4).map((item, index) => (
                  <div key={`${item.action ?? "entry"}-${index}`} className="flex items-center justify-between gap-3 border-b py-1.5 last:border-0">
                    <span className="truncate font-medium">{item.action ?? "Action"}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {item.createdAt ? new Date(item.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—"}
                    </span>
                  </div>
                ))}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { to: "/admin/appointments", title: "Appointments", body: "Cancel, reschedule or register a walk-in.", icon: CalendarDays },
          { to: "/admin/swaps", title: "Swap oversight", body: "Review pending swaps and stop abuse.", icon: Repeat2 },
          { to: "/admin/doctors", title: "Doctors", body: "Schedules, capacity and room assignment.", icon: Stethoscope },
        ].map((item) => (
          <Link key={item.to} to={item.to} className="group rounded-xl border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
            <div className="flex items-center justify-between">
              <span className="grid size-9 place-items-center rounded-lg bg-accent text-accent-foreground"><item.icon className="size-4.5" /></span>
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </div>
            <p className="mt-3 text-sm font-medium">{item.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{item.body}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
