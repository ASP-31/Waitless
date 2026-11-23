import type { Prisma } from "@prisma/client";
import { parseDayKey, toDayKey } from "@waitless/shared";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import type { AnalyticsRangeQuery } from "./analytics.schema";

const DAY_MS = 86_400_000;

/** Inclusive hospital-local day window used by all analytics queries. */
export interface DateRange {
  from: string;
  to: string;
}

/** Aggregate KPIs for a day window. `noShowRate` is a ratio in [0, 1]. */
export interface AnalyticsOverview {
  totals: {
    appointments: number;
    completed: number;
    cancelled: number;
    noShow: number;
    noShowRate: number;
  };
  /** Mean of `max(0, estimatedStartAt - slotStart)` in minutes. */
  avgWaitMinutes: number;
  /** Mean of completed `consultation.durationSeconds / 60`. */
  avgConsultMinutes: number;
  /** Appointment counts by hospital-local hour, busiest hour first. */
  peakHours: Array<{ hour: number; count: number }>;
  generatedAt: string;
}

/** Per-doctor productivity row. `throughputPerDay` is completed / days in range. */
export interface DoctorAnalyticsRow {
  doctorId: string;
  name: string;
  designation: string;
  department: string;
  appointments: number;
  completed: number;
  skipped: number;
  noShows: number;
  avgConsultMinutes: number;
  throughputPerDay: number;
}

const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: env.HOSPITAL_TIMEZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

/**
 * Fills in omitted range bounds with today in the hospital timezone and
 * rejects inverted windows. Callers validate the day-key format with the zod
 * schema before reaching this point.
 */
export function resolveDateRange(query: AnalyticsRangeQuery = {}): DateRange {
  const today = toDayKey(new Date(), env.HOSPITAL_TIMEZONE);
  const from = query.from ?? today;
  const to = query.to ?? today;
  if (from > to) throw AppError.badRequest("'from' must be on or before 'to'");
  return { from, to };
}

/** Appointment predicate for an inclusive `serviceDay` window. */
function appointmentWhere(range: DateRange): Prisma.AppointmentWhereInput {
  return { serviceDay: { gte: range.from, lte: range.to } };
}

/** Calendar days covered by an inclusive day-key range. */
function inclusiveDayCount(range: DateRange): number {
  const [fy, fm, fd] = parseDayKey(range.from);
  const [ty, tm, td] = parseDayKey(range.to);
  const start = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  return Math.max(1, Math.round((end - start) / DAY_MS) + 1);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Hospital-local hour (0-23) for a stored UTC instant, via Intl. */
function localHour(instant: Date): number {
  const part = hourFormatter.formatToParts(instant).find((item) => item.type === "hour");
  return Number(part?.value ?? "0") % 24;
}

/**
 * Builds the dashboard KPIs in a fixed number of queries: one status groupBy,
 * one ETA join for waits, one consultation aggregate and one slotStart scan
 * (needed to bucket local hours with Intl).
 */
export async function getOverview(query: AnalyticsRangeQuery = {}): Promise<AnalyticsOverview> {
  const range = resolveDateRange(query);
  const where = appointmentWhere(range);

  const [statusGroups, etaRows, consultAggregate, slotRows] = await Promise.all([
    prisma.appointment.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.queueEntry.findMany({
      where: { appointment: where, estimatedStartAt: { not: null } },
      select: { estimatedStartAt: true, appointment: { select: { slotStart: true } } },
    }),
    prisma.consultation.aggregate({
      where: { durationSeconds: { not: null }, queueEntry: { appointment: where } },
      _avg: { durationSeconds: true },
    }),
    prisma.appointment.findMany({ where, select: { slotStart: true } }),
  ]);

  const totals = { appointments: 0, completed: 0, cancelled: 0, noShow: 0, noShowRate: 0 };
  for (const group of statusGroups) {
    const count = group._count._all;
    totals.appointments += count;
    if (group.status === "COMPLETED") totals.completed += count;
    else if (group.status === "CANCELLED") totals.cancelled += count;
    else if (group.status === "NO_SHOW") totals.noShow += count;
  }
  totals.noShowRate = totals.appointments === 0 ? 0 : totals.noShow / totals.appointments;

  let totalWaitMs = 0;
  let waitSamples = 0;
  for (const row of etaRows) {
    if (!row.estimatedStartAt) continue;
    totalWaitMs += Math.max(0, row.estimatedStartAt.getTime() - row.appointment.slotStart.getTime());
    waitSamples += 1;
  }

  const avgSeconds = consultAggregate._avg.durationSeconds;
  const hourCounts = new Map<number, number>();
  for (const row of slotRows) {
    const hour = localHour(row.slotStart);
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
  }

  return {
    totals,
    avgWaitMinutes: waitSamples === 0 ? 0 : round(totalWaitMs / waitSamples / 60_000, 1),
    avgConsultMinutes: avgSeconds === null ? 0 : round(avgSeconds / 60, 1),
    peakHours: [...hourCounts.entries()]
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => b.count - a.count || a.hour - b.hour),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Per-doctor throughput for the window. Status counts come from a grouped
 * query; consultation durations are grouped in memory to avoid one query per
 * doctor. Doctors with no appointments in the window are still returned.
 */
export async function getDoctorAnalytics(query: AnalyticsRangeQuery = {}): Promise<DoctorAnalyticsRow[]> {
  const range = resolveDateRange(query);
  const where = appointmentWhere(range);

  const [doctors, statusGroups, consultations] = await Promise.all([
    prisma.doctor.findMany({
      select: {
        id: true,
        fullName: true,
        designation: true,
        department: { select: { name: true } },
      },
      orderBy: { fullName: "asc" },
    }),
    prisma.appointment.groupBy({
      by: ["doctorId", "status"],
      where,
      _count: { _all: true },
    }),
    prisma.consultation.findMany({
      where: { durationSeconds: { not: null }, queueEntry: { appointment: where } },
      select: { durationSeconds: true, queueEntry: { select: { doctorId: true } } },
    }),
  ]);

  interface StatusCounts {
    appointments: number;
    completed: number;
    skipped: number;
    noShows: number;
  }
  const counts = new Map<string, StatusCounts>();
  const newCounts = (): StatusCounts => ({ appointments: 0, completed: 0, skipped: 0, noShows: 0 });

  for (const doctor of doctors) counts.set(doctor.id, newCounts());
  for (const group of statusGroups) {
    const bucket = counts.get(group.doctorId) ?? newCounts();
    const count = group._count._all;
    bucket.appointments += count;
    if (group.status === "COMPLETED") bucket.completed += count;
    else if (group.status === "SKIPPED") bucket.skipped += count;
    else if (group.status === "NO_SHOW") bucket.noShows += count;
    counts.set(group.doctorId, bucket);
  }

  const durations = new Map<string, { sum: number; count: number }>();
  for (const consultation of consultations) {
    const doctorId = consultation.queueEntry.doctorId;
    const bucket = durations.get(doctorId) ?? { sum: 0, count: 0 };
    bucket.sum += consultation.durationSeconds ?? 0;
    bucket.count += 1;
    durations.set(doctorId, bucket);
  }

  const days = inclusiveDayCount(range);
  return doctors
    .map((doctor): DoctorAnalyticsRow => {
      const stats = counts.get(doctor.id) ?? newCounts();
      const duration = durations.get(doctor.id);
      return {
        doctorId: doctor.id,
        name: doctor.fullName,
        designation: doctor.designation,
        department: doctor.department.name,
        appointments: stats.appointments,
        completed: stats.completed,
        skipped: stats.skipped,
        noShows: stats.noShows,
        avgConsultMinutes: duration && duration.count > 0 ? round(duration.sum / duration.count / 60, 1) : 0,
        throughputPerDay: round(stats.completed / days, 2),
      };
    })
    .sort((a, b) => b.completed - a.completed || a.name.localeCompare(b.name));
}

const CSV_COLUMNS = [
  "id",
  "serviceDay",
  "tokenNumber",
  "patientName",
  "phone",
  "doctor",
  "department",
  "status",
  "slotStart",
  "source",
] as const;

/** RFC 4180 cell: every value is quoted and embedded quotes are doubled. */
function csvCell(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * Renders the window's appointments as CSV with a plain header row and quoted
 * data cells. Patient phone numbers are included for authorised staff export.
 */
export async function renderAppointmentsCsv(query: AnalyticsRangeQuery = {}): Promise<string> {
  const range = resolveDateRange(query);
  const rows = await prisma.appointment.findMany({
    where: appointmentWhere(range),
    orderBy: [{ serviceDay: "asc" }, { doctorId: "asc" }, { tokenNumber: "asc" }],
    select: {
      id: true,
      serviceDay: true,
      tokenNumber: true,
      patient: { select: { fullName: true, phone: true } },
      doctor: { select: { fullName: true } },
      department: { select: { name: true } },
      status: true,
      slotStart: true,
      source: true,
    },
  });

  const lines: string[] = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.serviceDay,
        row.tokenNumber,
        row.patient.fullName,
        row.patient.phone,
        row.doctor.fullName,
        row.department.name,
        row.status,
        row.slotStart.toISOString(),
        row.source,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
