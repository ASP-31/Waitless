import type { AppointmentStatus } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { resolveRange, type AnalyticsQuery } from "./analytics.schema";

function hourInHospitalTime(date: Date): number {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: env.HOSPITAL_TIMEZONE,
  }).format(date);
  // `en-GB` with hour12:false can render midnight as "24".
  return Number(formatted) % 24;
}

/**
 * Range analytics computed from raw rows. The dataset is a single hospital
 * day-range, so aggregating in memory keeps one query per entity and avoids
 * raw SQL timezone pitfalls.
 */
export async function getOverview(query: AnalyticsQuery) {
  const { from, to } = resolveRange(query);

  const [appointments, queueEntries, consultations, doctors] = await Promise.all([
    prisma.appointment.findMany({
      where: { serviceDay: { gte: from, lte: to } },
      select: { id: true, status: true, slotStart: true, doctorId: true, patientId: true },
    }),
    prisma.queueEntry.findMany({
      where: { appointment: { serviceDay: { gte: from, lte: to } }, calledAt: { not: null } },
      select: { calledAt: true, appointment: { select: { slotStart: true } } },
    }),
    prisma.consultation.findMany({
      where: { endedAt: { not: null }, queueEntry: { appointment: { serviceDay: { gte: from, lte: to } } } },
      select: { durationSeconds: true },
    }),
    prisma.doctor.count({ where: { isActive: true } }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const appointment of appointments) {
    byStatus[appointment.status] = (byStatus[appointment.status] ?? 0) + 1;
  }

  const status = (value: AppointmentStatus) => byStatus[value] ?? 0;
  const total = appointments.length;
  const completed = status("COMPLETED");
  const cancelled = status("CANCELLED");
  const noShow = status("NO_SHOW");
  const skipped = status("SKIPPED");

  const waits = queueEntries
    .map((entry) => {
      if (!entry.calledAt) return null;
      return Math.max(0, entry.calledAt.getTime() - entry.appointment.slotStart.getTime()) / 60_000;
    })
    .filter((value): value is number => value !== null);
  const avgWaitMinutes = waits.length
    ? Math.round(waits.reduce((sum, value) => sum + value, 0) / waits.length)
    : 0;

  const durations = consultations
    .map((consultation) => consultation.durationSeconds ?? 0)
    .filter((seconds) => seconds > 0);
  const avgConsultMinutes = durations.length
    ? Math.round(durations.reduce((sum, seconds) => sum + seconds, 0) / durations.length / 60)
    : 0;

  const hourBuckets = new Map<number, number>();
  for (const appointment of appointments) {
    const hour = hourInHospitalTime(appointment.slotStart);
    hourBuckets.set(hour, (hourBuckets.get(hour) ?? 0) + 1);
  }
  const peakHours = [...hourBuckets.entries()]
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => a.hour - b.hour);

  return {
    range: { from, to },
    totals: {
      appointments: total,
      completed,
      cancelled,
      noShow,
      skipped,
      activeDoctors: doctors,
      noShowRate: total ? Math.round(((noShow + skipped) / total) * 1000) / 10 : 0,
      completionRate: total ? Math.round((completed / total) * 1000) / 10 : 0,
    },
    byStatus,
    avgWaitMinutes,
    avgConsultMinutes,
    peakHours,
  };
}

export async function getDoctorStats(query: AnalyticsQuery) {
  const { from, to } = resolveRange(query);

  const appointments = await prisma.appointment.findMany({
    where: { serviceDay: { gte: from, lte: to } },
    select: {
      doctorId: true,
      status: true,
      doctor: { select: { id: true, fullName: true, avgConsultMinutes: true, department: { select: { name: true } } } },
    },
  });

  const consultations = await prisma.consultation.findMany({
    where: { endedAt: { not: null }, queueEntry: { appointment: { serviceDay: { gte: from, lte: to } } } },
    select: { durationSeconds: true, queueEntry: { select: { doctorId: true } } },
  });

  const durationByDoctor = new Map<string, number[]>();
  for (const consultation of consultations) {
    const doctorId = consultation.queueEntry.doctorId;
    const list = durationByDoctor.get(doctorId) ?? [];
    if (consultation.durationSeconds) list.push(consultation.durationSeconds);
    durationByDoctor.set(doctorId, list);
  }

  const byDoctor = new Map<string, {
    doctorId: string;
    doctorName: string;
    department: string | null;
    appointments: number;
    completed: number;
    cancelled: number;
    skipped: number;
    noShow: number;
    avgConsultMinutes: number;
    skipRate: number;
  }>();

  for (const appointment of appointments) {
    const current = byDoctor.get(appointment.doctorId) ?? {
      doctorId: appointment.doctorId,
      doctorName: appointment.doctor.fullName,
      department: appointment.doctor.department?.name ?? null,
      appointments: 0,
      completed: 0,
      cancelled: 0,
      skipped: 0,
      noShow: 0,
      avgConsultMinutes: appointment.doctor.avgConsultMinutes,
      skipRate: 0,
    };
    current.appointments += 1;
    if (appointment.status === "COMPLETED") current.completed += 1;
    if (appointment.status === "CANCELLED") current.cancelled += 1;
    if (appointment.status === "SKIPPED") current.skipped += 1;
    if (appointment.status === "NO_SHOW") current.noShow += 1;
    byDoctor.set(appointment.doctorId, current);
  }

  return [...byDoctor.values()]
    .map((row) => {
      const durations = durationByDoctor.get(row.doctorId) ?? [];
      const measured = durations.length
        ? Math.round(durations.reduce((sum, seconds) => sum + seconds, 0) / durations.length / 60)
        : row.avgConsultMinutes;
      return {
        ...row,
        avgConsultMinutes: measured,
        skipRate: row.appointments
          ? Math.round(((row.skipped + row.noShow) / row.appointments) * 1000) / 10
          : 0,
      };
    })
    .sort((a, b) => b.appointments - a.appointments);
}
