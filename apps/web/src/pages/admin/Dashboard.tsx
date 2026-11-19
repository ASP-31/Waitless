import { useQuery } from "@tanstack/react-query";
import { Activity, CalendarDays, CheckCircle2, ChevronRight, ListOrdered, Repeat2, Stethoscope, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiStatus } from "@/components/shared/api-status";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

type Appointment = { status: string; slotStart: string; doctorId: string; doctor: { fullName: string } };
type Overview = {
  totals: { appointments: number; completed: number; cancelled: number; noShow: number; skipped: number; noShowRate: number; completionRate: number };
  avgWaitMinutes: number;
  avgConsultMinutes: number;
  peakHours: Array<{ hour: number; count: number }>;
};

export function AdminDashboardPage() {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  const apptsQ = useQuery({
    queryKey: ["appointments", "admin", "dashboard", today],
    queryFn: async () => (await api.get<{ data: { appointments: Appointment[] } }>(`/appointments?date=${today}&pageSize=200`)).data.appointments,
    refetchInterval: 15000,
  });
  const overviewQ = useQuery({
    queryKey: ["analytics", "overview", from, to],
    queryFn: async () =>
      (await api.get<{ data: Overview }>(`/analytics/overview?from=${from}&to=${to}`)).data,
    refetchInterval: 60_000,
  });

  const items = useMemo(() => apptsQ.data ?? [], [apptsQ.data]);
  const overview = overviewQ.data;
  const stats = useMemo(() => {
    const waiting = items.filter((a) => ["WAITING", "NOTIFIED", "DELAYED", "BOOKED"].includes(a.status)).length;
    const inConsult = items.filter((a) => a.status === "IN_CONSULTATION").length;
    const completed = items.filter((a) => a.status === "COMPLETED").length;
    const called = items.filter((a) => a.status === "CALLED").length;
    const byDoctor = new Map<string, { name: string; active: number }>();
    for (const a of items) {
      const cur = byDoctor.get(a.doctorId) ?? { name: a.doctor.fullName, active: 0 };
      if (["WAITING", "NOTIFIED", "DELAYED", "BOOKED", "CALLED", "IN_CONSULTATION"].includes(a.status)) cur.active++;
      byDoctor.set(a.doctorId, cur);
    }
    return { waiting: waiting + called, inConsult, completed, doctors: Array.from(byDoctor.values()).sort((a, b) => b.active - a.active).slice(0, 5) };
  }, [items]);

  const peakHours = overview?.peakHours ?? [];
  const maxPeak = Math.max(1, ...peakHours.map((bucket) => bucket.count));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Live view of today's clinic activity."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
              className="h-9 w-36"
              aria-label="From date"
            />
            <Input
              type="date"
              value={to}
              min={from}
              onChange={(event) => setTo(event.target.value)}
              className="h-9 w-36"
              aria-label="To date"
            />
            <Button variant="outline" asChild><Link to="/admin/queue"><ListOrdered className="size-4" />Open queue</Link></Button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Waiting now" value={String(stats.waiting)} hint="Active in queue flow" icon={Users} tone="info" />
        <StatCard label="In consultation" value={String(stats.inConsult)} hint="Rooms currently active" icon={Stethoscope} tone="success" />
        <StatCard
          label="Appointments in range"
          value={String(overview?.totals.appointments ?? items.length)}
          hint={from === to ? `For ${from}` : `${from} → ${to}`}
          icon={CalendarDays}
          tone="warning"
        />
        <StatCard
          label="Completed in range"
          value={String(overview?.totals.completed ?? stats.completed)}
          hint={overview ? `${overview.totals.completionRate}% completion` : "Consultations closed"}
          icon={CheckCircle2}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <CardTitle>Queue snapshot</CardTitle>
                <CardDescription>Doctor-wise active load for today.</CardDescription>
              </div>
              <Badge variant="neutral"><Activity className="size-3" />Live polling</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {apptsQ.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : stats.doctors.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active appointments for today yet.</p>
            ) : (
              <div className="space-y-3">
                {stats.doctors.map((d) => (
                  <div key={d.name} className="flex items-center gap-3">
                    <div className="flex-1">
                      <p className="text-sm font-medium">{d.name}</p>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary/50" style={{ width: `${Math.min(100, d.active * 15)}%` }} /></div>
                    </div>
                    <Badge variant="muted">{d.active} active</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Bookings by hour</CardTitle>
              <CardDescription>
                {overview
                  ? `Avg wait ${overview.avgWaitMinutes} min · Avg consult ${overview.avgConsultMinutes} min · No-show ${overview.totals.noShowRate}%`
                  : "Distribution for the selected range."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {peakHours.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No bookings in this range.</p>
              ) : (
                <>
                  <div className="flex h-28 items-end gap-1.5">
                    {peakHours.map((bucket) => (
                      <div key={bucket.hour} className="flex-1" title={`${bucket.hour}:00 · ${bucket.count} booking(s)`}>
                        <div
                          className="w-full rounded-t-sm bg-primary/30"
                          style={{ height: `${Math.max(4, Math.round((bucket.count / maxPeak) * 100))}%` }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
                    <span>{peakHours[0]?.hour ?? 0}:00</span>
                    <span>{peakHours[Math.floor(peakHours.length / 2)]?.hour ?? 0}:00</span>
                    <span>{peakHours[peakHours.length - 1]?.hour ?? 0}:00</span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">System</CardTitle><CardDescription>Local environment status.</CardDescription></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center justify-between"><span className="text-muted-foreground">API</span><ApiStatus /></div>
              <div className="flex items-center justify-between"><span className="text-muted-foreground">Realtime</span><Badge variant="success">Socket.IO active</Badge></div>
              <div className="flex items-center justify-between"><span className="text-muted-foreground">Hardware</span><Badge variant="neutral">MQTT ingest ready</Badge></div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {[{ to: "/admin/appointments", title: "Appointments", body: "Cancel, reschedule or register a walk-in.", icon: CalendarDays }, { to: "/admin/swaps", title: "Swap oversight", body: "Review pending swaps and stop abuse.", icon: Repeat2 }, { to: "/admin/doctors", title: "Doctors", body: "Schedules, capacity and room assignment.", icon: Stethoscope }].map((item) => (
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
