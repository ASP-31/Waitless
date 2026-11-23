import { expect, type APIRequestContext } from "@playwright/test";

/**
 * Small API client used by the Playwright specs. The specs are driven against
 * a running API + web pair (the web origin proxies /api to the API), and rely
 * on `pnpm db:seed:demo` for doctors, schedules, staff accounts and a busy
 * clinic. Every helper fails loudly when an upstream contract changes.
 */

const API = "/api/v1";
const HOSPITAL_TIMEZONE = process.env.E2E_HOSPITAL_TIMEZONE ?? "Asia/Kolkata";

let phoneSequence = 0;

export interface PatientSession {
  token: string;
  patientId: string;
}

export interface StaffSession {
  token: string;
}

export interface Doctor {
  id: string;
  fullName: string;
}

export interface AvailableSlot {
  date: string;
  start: string;
  end: string;
  startMinute: number;
}

export interface Appointment {
  id: string;
  tokenNumber: number;
  slotStart: string;
  status: string;
  serviceDay: string;
}

export interface QueueEntry {
  id: string;
  appointmentId: string;
  status: string;
  serviceDay: string;
}

export interface Swap {
  id: string;
  status: string;
}

export interface NotificationRow {
  id: string;
  patientId: string | null;
  readAt: string | null;
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function uniquePhone(): string {
  phoneSequence += 1;
  return `9${Date.now().toString().slice(-8)}${String(phoneSequence).padStart(2, "0")}`;
}

/** Calendar day key in the hospital timezone, offset from today. */
export function dayKey(offsetDays: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HOSPITAL_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const date = new Date(`${value("year")}-${value("month")}-${value("day")}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export async function patientSession(
  request: APIRequestContext,
  fullName: string,
  phone = uniquePhone(),
): Promise<PatientSession> {
  const response = await request.post(`${API}/patients/session`, {
    data: { fullName, phone },
  });
  expect(response.status(), "patient session").toBe(201);
  const body = (await response.json()) as {
    data: { accessToken: string; profile: { id: string } };
  };
  return { token: body.data.accessToken, patientId: body.data.profile.id };
}

export async function staffLogin(request: APIRequestContext): Promise<StaffSession> {
  const response = await request.post(`${API}/auth/login`, {
    data: {
      identifier: process.env.E2E_ADMIN_EMAIL ?? "admin@waitless.local",
      password: process.env.E2E_ADMIN_PASSWORD ?? "Admin@12345",
    },
  });
  expect(response.status(), "staff login").toBe(200);
  const body = (await response.json()) as { data: { accessToken: string } };
  return { token: body.data.accessToken };
}

export async function listDoctors(request: APIRequestContext): Promise<Doctor[]> {
  const response = await request.get(`${API}/doctors`);
  expect(response.status(), "doctor list").toBe(200);
  const body = (await response.json()) as { data: { doctors: Doctor[] } };
  expect(body.data.doctors.length).toBeGreaterThan(0);
  return body.data.doctors;
}

/**
 * Finds `count` genuinely free, future slots on one seeded clinic day.
 * Keeping the slots on the same service day is a precondition for swaps.
 */
export async function findAvailableSlots(
  request: APIRequestContext,
  doctorId: string,
  count: number,
  minOffsetDays = 2,
): Promise<AvailableSlot[]> {
  for (let offset = minOffsetDays; offset < minOffsetDays + 10; offset++) {
    const date = dayKey(offset);
    const response = await request.get(`${API}/doctors/${doctorId}/availability`, {
      params: { date },
    });
    expect(response.status(), `availability for ${date}`).toBe(200);
    const body = (await response.json()) as {
      data: {
        slots: Array<{
          start: string;
          end: string;
          startMinute: number;
          isBooked: boolean;
          isPast: boolean;
        }>;
      };
    };
    const free = body.data.slots.filter((slot) => !slot.isBooked && !slot.isPast);
    if (free.length >= count) {
      return free.slice(0, count).map((slot) => ({
        date,
        start: slot.start,
        end: slot.end,
        startMinute: slot.startMinute,
      }));
    }
  }
  throw new Error(`Could not find ${count} free slots for doctor ${doctorId}`);
}

export async function book(
  request: APIRequestContext,
  patient: PatientSession,
  doctorId: string,
  slotStart: string,
  idempotencyKey: string,
): Promise<Appointment> {
  const response = await request.post(`${API}/appointments`, {
    headers: {
      ...bearer(patient.token),
      "Idempotency-Key": idempotencyKey,
    },
    data: { doctorId, slotStart, source: "REMOTE" },
  });
  expect(response.status(), "book appointment").toBe(201);
  const body = (await response.json()) as { data: { appointment: Appointment } };
  return body.data.appointment;
}

export async function getAppointment(
  request: APIRequestContext,
  patient: PatientSession,
  appointmentId: string,
): Promise<Appointment> {
  const response = await request.get(`${API}/appointments/${appointmentId}`, {
    headers: bearer(patient.token),
  });
  expect(response.status(), "read appointment").toBe(200);
  const body = (await response.json()) as { data: { appointment: Appointment } };
  return body.data.appointment;
}

export async function findWaitingQueueEntry(
  request: APIRequestContext,
  staff: StaffSession,
  doctorId: string,
): Promise<QueueEntry> {
  for (let offset = 0; offset < 8; offset++) {
    const date = dayKey(offset);
    const response = await request.get(`${API}/queue/${doctorId}`, {
      headers: bearer(staff.token),
      params: { date },
    });
    expect(response.status(), `queue for ${date}`).toBe(200);
    const body = (await response.json()) as { data: { entries: QueueEntry[] } };
    const waiting = body.data.entries.find((entry) => entry.status === "WAITING");
    if (waiting) return waiting;
  }
  throw new Error(`No seeded WAITING queue entry found for doctor ${doctorId}`);
}

export async function queueEntryStatus(
  request: APIRequestContext,
  staff: StaffSession,
  doctorId: string,
  date: string,
  entryId: string,
): Promise<string> {
  const response = await request.get(`${API}/queue/${doctorId}`, {
    headers: bearer(staff.token),
    params: { date },
  });
  expect(response.status(), "queue refresh").toBe(200);
  const body = (await response.json()) as { data: { entries: QueueEntry[] } };
  return body.data.entries.find((entry) => entry.id === entryId)?.status ?? "MISSING";
}

export async function createSwap(
  request: APIRequestContext,
  requester: PatientSession,
  requesterAppointmentId: string,
  targetAppointmentId: string,
  idempotencyKey: string,
): Promise<Swap> {
  const response = await request.post(`${API}/swaps`, {
    headers: {
      ...bearer(requester.token),
      "Idempotency-Key": idempotencyKey,
    },
    data: { requesterAppointmentId, targetAppointmentId },
  });
  expect(response.status(), "create swap").toBe(201);
  const body = (await response.json()) as { data: { swap: Swap } };
  return body.data.swap;
}
