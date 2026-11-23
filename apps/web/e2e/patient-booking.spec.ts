import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  bearer,
  findAvailableSlots,
  getAppointment,
  listDoctors,
  patientSession,
  uniquePhone,
  type Appointment,
  type PatientSession,
} from "./helpers/api";

async function appointmentsForSlot(
  request: APIRequestContext,
  patient: PatientSession,
  date: string,
): Promise<Appointment[]> {
  const response = await request.get("/api/v1/appointments", {
    headers: bearer(patient.token),
    params: { date },
  });
  expect(response.status(), "appointment list").toBe(200);
  const body = (await response.json()) as { data: { appointments: Appointment[] } };
  return body.data.appointments;
}

test("patient books a slot and an idempotent retry returns the same appointment", async ({
  request,
}) => {
  const patient = await patientSession(request, "E2E Booking Patient", uniquePhone());
  const [doctor] = await listDoctors(request);
  expect(doctor, "seeded doctor").toBeDefined();
  const [slot] = await findAvailableSlots(request, doctor!.id, 1);

  const key = `e2e-book-${Date.now()}`;
  const payload = { doctorId: doctor!.id, slotStart: slot!.start, source: "REMOTE" };
  const headers = { ...bearer(patient.token), "Idempotency-Key": key };

  const first = await request.post("/api/v1/appointments", { headers, data: payload });
  expect(first.status(), "first booking").toBe(201);
  const booked = (await first.json()) as { data: { appointment: Appointment } };
  expect(booked.data.appointment.slotStart).toBe(slot!.start);

  // Same key, same caller, same body: a network retry must not create another
  // appointment or consume another token.
  const retry = await request.post("/api/v1/appointments", { headers, data: payload });
  expect(retry.status(), "idempotent retry").toBe(201);
  const replayed = (await retry.json()) as { data: { appointment: Appointment } };
  expect(replayed.data.appointment.id).toBe(booked.data.appointment.id);
  expect(replayed.data.appointment.tokenNumber).toBe(booked.data.appointment.tokenNumber);

  const persisted = await getAppointment(request, patient, booked.data.appointment.id);
  expect(persisted.id).toBe(booked.data.appointment.id);
  const mine = await appointmentsForSlot(request, patient, slot!.date);
  expect(mine.filter((appointment) => appointment.id === booked.data.appointment.id)).toHaveLength(
    1,
  );
});
