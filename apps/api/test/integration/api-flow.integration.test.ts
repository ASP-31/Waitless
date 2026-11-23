import { hash } from "@node-rs/argon2";
import { addDaysToDayKey, dayOfWeek, toDayKey, zonedDateTimeToUtc } from "@waitless/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { env } from "../../src/config/env";
import { prisma } from "../../src/config/prisma";
import { signHardwareEvent } from "../../src/modules/hardware/hardware.service";

/**
 * End-to-end API flow against a disposable Postgres + Redis.
 *
 * Off by default so the normal unit-test run needs no infrastructure. CI's
 * integration job (and a local `RUN_DB_TESTS=true pnpm --filter @waitless/api test`)
 * enables it; `with-env.mjs` redirects DATABASE_URL to TEST_DATABASE_URL.
 */
const describeDb = process.env.RUN_DB_TESTS === "true" ? describe : describe.skip;

const app = createApp();
const TZ = env.HOSPITAL_TIMEZONE;

interface PatientSession {
  token: string;
  patientId: string;
}

let adminToken = "";
let patientA: PatientSession;
let patientB: PatientSession;
let patientC: PatientSession;
let doctorId = "";
let roomCode = "";
let serviceDay = "";
let slotA = "";
let slotB = "";
let slotC = "";
// Extra slots used by the ownership matrix and swap-concurrency checks.
let slotD = "";
let slotE = "";
let slotF = "";
let slotG = "";
let slotH = "";
let slotI = "";
let slotJ = "";
let appointmentAId = "";
let appointmentBId = "";
let appointmentCId = "";

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function createPatientSession(name: string, phone: string): Promise<PatientSession> {
  const response = await request(app)
    .post("/api/v1/patients/session")
    .send({ fullName: name, phone })
    .expect(201);
  const data = response.body.data as { accessToken: string; profile: { id: string } };
  return { token: data.accessToken, patientId: data.profile.id };
}

async function book(session: PatientSession, slotStart: string, key: string) {
  const response = await request(app)
    .post("/api/v1/appointments")
    .set(bearer(session.token))
    .set("Idempotency-Key", key)
    .send({ doctorId, slotStart, source: "REMOTE" })
    .expect(201);
  return response.body.data.appointment as { id: string; tokenNumber: number };
}

describeDb("API integration flow", () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        "AuditLog", "HardwareEvent", "SwapRequest", "Notification",
        "Consultation", "QueueEntry", "Appointment", "ScheduleException",
        "DoctorSchedule", "Doctor", "Department", "NotificationPreference",
        "Patient", "AdminProfile", "RefreshToken", "User", "Room"
      RESTART IDENTITY CASCADE
    `);

    const admin = await prisma.user.create({
      data: {
        role: "ADMIN",
        name: "Integration Admin",
        email: "admin.integration@waitless.local",
        phone: "9100000001",
        passwordHash: await hash("Integration@123"),
        adminProfile: { create: { designation: "Administrator", staffCode: "INT-ADMIN" } },
      },
    });

    const department = await prisma.department.create({
      data: { name: "Integration Medicine", code: "INT-MED" },
    });
    const room = await prisma.room.create({
      data: { code: "INT-1", name: "Integration Room 1" },
    });
    const doctor = await prisma.doctor.create({
      data: {
        departmentId: department.id,
        fullName: "Dr Integration",
        designation: "Consultant",
        roomId: room.id,
        avgConsultMinutes: 10,
      },
    });
    doctorId = doctor.id;
    roomCode = room.code;

    const today = toDayKey(new Date(), TZ);
    serviceDay = addDaysToDayKey(today, 2);
    await prisma.doctorSchedule.create({
      data: {
        doctorId,
        dayOfWeek: dayOfWeek(serviceDay),
        startMinute: 9 * 60,
        endMinute: 12 * 60,
        slotMinutes: 15,
      },
    });
    slotA = zonedDateTimeToUtc(serviceDay, 10 * 60, TZ).toISOString();
    slotB = zonedDateTimeToUtc(serviceDay, 10 * 60 + 15, TZ).toISOString();
    slotC = zonedDateTimeToUtc(serviceDay, 10 * 60 + 30, TZ).toISOString();

    // Extra slots for the ownership matrix and swap-concurrency fixtures.
    await prisma.doctorSchedule.updateMany({
      where: { doctorId },
      data: { endMinute: 13 * 60 },
    });
    slotD = zonedDateTimeToUtc(serviceDay, 10 * 60 + 45, TZ).toISOString();
    slotE = zonedDateTimeToUtc(serviceDay, 11 * 60, TZ).toISOString();
    slotF = zonedDateTimeToUtc(serviceDay, 11 * 60 + 15, TZ).toISOString();
    slotG = zonedDateTimeToUtc(serviceDay, 11 * 60 + 30, TZ).toISOString();
    slotH = zonedDateTimeToUtc(serviceDay, 11 * 60 + 45, TZ).toISOString();
    slotI = zonedDateTimeToUtc(serviceDay, 12 * 60, TZ).toISOString();
    slotJ = zonedDateTimeToUtc(serviceDay, 12 * 60 + 15, TZ).toISOString();

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ identifier: admin.email, password: "Integration@123" })
      .expect(200);
    adminToken = (login.body.data as { accessToken: string }).accessToken;

    patientA = await createPatientSession("Alpha Patient", "9190000001");
    patientB = await createPatientSession("Beta Patient", "9190000002");
    patientC = await createPatientSession("Gamma Patient", "9190000003");
  }, 60_000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        "AuditLog", "HardwareEvent", "SwapRequest", "Notification",
        "Consultation", "QueueEntry", "Appointment", "ScheduleException",
        "DoctorSchedule", "Doctor", "Department", "NotificationPreference",
        "Patient", "AdminProfile", "RefreshToken", "User", "Room"
      RESTART IDENTITY CASCADE
    `);
  });

  it("authenticates staff and normalises patient phone numbers", async () => {
    const me = await request(app).get("/api/v1/auth/me").set(bearer(adminToken)).expect(200);
    expect((me.body.data as { role: string }).role).toBe("ADMIN");

    const returning = await request(app)
      .post("/api/v1/patients/session")
      .send({ fullName: "Alpha Patient Updated", phone: "91 90000 00001" })
      .expect(201);
    expect((returning.body.data as { profile: { id: string } }).profile.id).toBe(
      patientA.patientId,
    );

    const forbidden = await request(app)
      .get("/api/v1/admin/audit")
      .set(bearer(patientA.token))
      .expect(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
  });

  it("books appointments, conflicts on a taken slot, and replays idempotent writes", async () => {
    appointmentAId = (await book(patientA, slotA, "int-book-a")).id;
    appointmentBId = (await book(patientB, slotB, "int-book-b")).id;
    appointmentCId = (await book(patientC, slotC, "int-book-c")).id;

    const conflict = await request(app)
      .post("/api/v1/appointments")
      .set(bearer(patientC.token))
      .set("Idempotency-Key", "int-book-conflict")
      .send({ doctorId, slotStart: slotA, source: "REMOTE" })
      .expect(409);
    expect(conflict.body.error.code).toBe("SLOT_TAKEN");

    // Same key + same body returns the original 201 without creating a row.
    const replay = await request(app)
      .post("/api/v1/appointments")
      .set(bearer(patientA.token))
      .set("Idempotency-Key", "int-book-a")
      .send({ doctorId, slotStart: slotA, source: "REMOTE" })
      .expect(201);
    expect((replay.body.data.appointment as { id: string }).id).toBe(appointmentAId);

    const notifications = await prisma.notification.count({
      where: { type: "BOOKING_CONFIRMED" },
    });
    expect(notifications).toBe(3);
  });

  it("walks a queue entry through call, start and complete", async () => {
    const queue = await request(app)
      .get(`/api/v1/queue/${doctorId}`)
      .query({ date: serviceDay })
      .set(bearer(adminToken))
      .expect(200);
    const entries = (
      queue.body.data as { entries: Array<{ id: string; appointmentId: string; status: string }> }
    ).entries;
    expect(entries).toHaveLength(3);
    const first = entries.find((entry) => entry.appointmentId === appointmentAId);
    expect(first?.status).toBe("WAITING");

    await request(app)
      .patch(`/api/v1/queue/entries/${first!.id}/call`)
      .set(bearer(adminToken))
      .expect(200);
    await request(app)
      .patch(`/api/v1/queue/entries/${first!.id}/start`)
      .set(bearer(adminToken))
      .expect(200);
    await request(app)
      .patch(`/api/v1/queue/entries/${first!.id}/complete`)
      .set(bearer(adminToken))
      .expect(200);

    const completed = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentAId },
      include: { queueEntry: true },
    });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.queueEntry?.status).toBe("COMPLETED");
    expect(
      await prisma.auditLog.count({ where: { action: "QUEUE_COMPLETED", entityId: first!.id } }),
    ).toBe(1);
  });

  it("executes a swap with exchanged tokens and an audit record", async () => {
    const originalB = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentBId } });
    const originalC = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentCId } });

    const eligible = await request(app)
      .post("/api/v1/swaps/eligible")
      .set(bearer(patientB.token))
      .send({ appointmentId: appointmentBId })
      .expect(200);
    const candidates = (eligible.body.data as { eligible: Array<{ appointmentId: string }> })
      .eligible;
    expect(candidates.some((candidate) => candidate.appointmentId === appointmentCId)).toBe(true);

    const created = await request(app)
      .post("/api/v1/swaps")
      .set(bearer(patientB.token))
      .set("Idempotency-Key", "int-swap-1")
      .send({ requesterAppointmentId: appointmentBId, targetAppointmentId: appointmentCId })
      .expect(201);
    const swapId = (created.body.data.swap as { id: string }).id;

    await request(app)
      .patch(`/api/v1/swaps/${swapId}/respond`)
      .set(bearer(patientC.token))
      .send({ action: "ACCEPT" })
      .expect(200);

    const [before, after] = await Promise.all([
      prisma.appointment.findUniqueOrThrow({ where: { id: appointmentBId } }),
      prisma.appointment.findUniqueOrThrow({ where: { id: appointmentCId } }),
    ]);
    expect(before.slotStart.toISOString()).toBe(originalC.slotStart.toISOString());
    expect(after.slotStart.toISOString()).toBe(originalB.slotStart.toISOString());
    expect(before.tokenNumber).toBe(originalC.tokenNumber);
    expect(after.tokenNumber).toBe(originalB.tokenNumber);
    expect(
      await prisma.auditLog.count({ where: { action: "SWAP_ACCEPTED", entityId: swapId } }),
    ).toBe(1);
  });

  it("serves analytics that reconcile with stored appointments", async () => {
    const overview = await request(app)
      .get("/api/v1/analytics/overview")
      .query({ from: serviceDay, to: serviceDay })
      .set(bearer(adminToken))
      .expect(200);
    const summary = overview.body.data as { appointments: number; completed: number };
    const dbCount = await prisma.appointment.count({ where: { serviceDay } });
    expect(summary.appointments).toBe(dbCount);
    expect(summary.completed).toBeGreaterThanOrEqual(1);

    const csv = await request(app)
      .get("/api/v1/analytics/appointments.csv")
      .query({ from: serviceDay, to: serviceDay })
      .set(bearer(adminToken))
      .expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
  });

  it("accepts signed hardware events and ignores replays", async () => {
    const base = { roomId: roomCode, type: "OCCUPIED" as const, ts: 1_700_000_000, seq: 77, v: 1 };
    const signed = { ...base, sig: signHardwareEvent(base) };
    const first = await request(app).post("/api/v1/hardware/events").send(signed).expect(201);
    expect((first.body.data as { duplicate: boolean }).duplicate).toBe(false);

    const replay = await request(app).post("/api/v1/hardware/events").send(signed).expect(200);
    expect((replay.body.data as { duplicate: boolean }).duplicate).toBe(true);

    await request(app)
      .post("/api/v1/hardware/events")
      .send({ ...base, sig: "0".repeat(64) })
      .expect(401);
  });

  it("rejects cross-patient access to appointments, swaps and notifications", async () => {
    // Role gates: a patient token cannot reach any staff-only surface.
    await request(app)
      .post("/api/v1/appointments/walk-in")
      .set(bearer(patientA.token))
      .send({
        doctorId,
        slotStart: slotD,
        patient: { fullName: "Should Fail", phone: "9100000099" },
      })
      .expect(403);
    await request(app)
      .patch(`/api/v1/appointments/${appointmentBId}/reschedule`)
      .set(bearer(patientA.token))
      .send({ slotStart: slotD })
      .expect(403);
    await request(app)
      .patch("/api/v1/queue/entries/00000000-0000-0000-0000-000000000000/call")
      .set(bearer(patientA.token))
      .expect(403);
    await request(app).get("/api/v1/analytics/overview").set(bearer(patientA.token)).expect(403);
    await request(app).get("/api/v1/admin/audit").set(bearer(patientA.token)).expect(403);

    // Ownership: patient A cannot read or cancel patient B's appointment.
    await request(app)
      .get(`/api/v1/appointments/${appointmentBId}`)
      .set(bearer(patientA.token))
      .expect(403);
    await request(app)
      .patch(`/api/v1/appointments/${appointmentBId}/cancel`)
      .set(bearer(patientA.token))
      .send({ reason: "not mine" })
      .expect(403);
    const untouchedAppointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentBId },
    });
    expect(untouchedAppointment.status).not.toBe("CANCELLED");

    // Ownership: patient C cannot respond to or cancel A's swap, and cannot
    // discover it through the filtered swap list.
    const requesterAppointment = await book(patientA, slotD, "int-own-req");
    const targetAppointment = await book(patientB, slotE, "int-own-target");
    const created = await request(app)
      .post("/api/v1/swaps")
      .set(bearer(patientA.token))
      .set("Idempotency-Key", "int-own-swap")
      .send({
        requesterAppointmentId: requesterAppointment.id,
        targetAppointmentId: targetAppointment.id,
      })
      .expect(201);
    const swapId = (created.body.data.swap as { id: string }).id;

    await request(app)
      .patch(`/api/v1/swaps/${swapId}/respond`)
      .set(bearer(patientC.token))
      .send({ action: "ACCEPT" })
      .expect(403);
    await request(app)
      .patch(`/api/v1/swaps/${swapId}/cancel`)
      .set(bearer(patientC.token))
      .expect(403);
    const swapsForC = await request(app)
      .get("/api/v1/swaps")
      .set(bearer(patientC.token))
      .expect(200);
    expect(
      (swapsForC.body.data.swaps as Array<{ id: string }>).some((swap) => swap.id === swapId),
    ).toBe(false);

    // Ownership: patient B cannot mark patient A's notification as read.
    const notification = await prisma.notification.findFirstOrThrow({
      where: { patientId: patientA.patientId, type: "BOOKING_CONFIRMED" },
    });
    await request(app)
      .patch(`/api/v1/notifications/${notification.id}/read`)
      .set(bearer(patientB.token))
      .expect(403);
    const untouchedNotification = await prisma.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });
    expect(untouchedNotification.readAt).toBeNull();
    const notificationsForB = await request(app)
      .get("/api/v1/notifications")
      .set(bearer(patientB.token))
      .expect(200);
    expect(
      (notificationsForB.body.data.notifications as Array<{ id: string }>).some(
        (row) => row.id === notification.id,
      ),
    ).toBe(false);

    // The failed requests must not have mutated the pending swap.
    expect((await prisma.swapRequest.findUniqueOrThrow({ where: { id: swapId } })).status).toBe(
      "PENDING",
    );
  });

  it("accepts only one of two concurrent swap responses", async () => {
    const requesterAppointment = await book(patientA, slotF, "int-race-req");
    const targetAppointment = await book(patientB, slotG, "int-race-target");
    const beforeRequester = await prisma.appointment.findUniqueOrThrow({
      where: { id: requesterAppointment.id },
    });
    const beforeTarget = await prisma.appointment.findUniqueOrThrow({
      where: { id: targetAppointment.id },
    });

    const created = await request(app)
      .post("/api/v1/swaps")
      .set(bearer(patientA.token))
      .set("Idempotency-Key", "int-race-swap")
      .send({
        requesterAppointmentId: requesterAppointment.id,
        targetAppointmentId: targetAppointment.id,
      })
      .expect(201);
    const swapId = (created.body.data.swap as { id: string }).id;

    const attempts = await Promise.allSettled([
      request(app)
        .patch(`/api/v1/swaps/${swapId}/respond`)
        .set(bearer(patientB.token))
        .send({ action: "ACCEPT" }),
      request(app)
        .patch(`/api/v1/swaps/${swapId}/respond`)
        .set(bearer(patientB.token))
        .send({ action: "ACCEPT" }),
    ]);
    const statuses = attempts.map((attempt) =>
      attempt.status === "fulfilled" ? attempt.value.status : 500,
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);

    const settled = await prisma.swapRequest.findUniqueOrThrow({ where: { id: swapId } });
    expect(settled.status).toBe("ACCEPTED");

    const afterRequester = await prisma.appointment.findUniqueOrThrow({
      where: { id: requesterAppointment.id },
    });
    const afterTarget = await prisma.appointment.findUniqueOrThrow({
      where: { id: targetAppointment.id },
    });
    expect(afterRequester.slotStart.toISOString()).toBe(beforeTarget.slotStart.toISOString());
    expect(afterTarget.slotStart.toISOString()).toBe(beforeRequester.slotStart.toISOString());
    expect(afterRequester.tokenNumber).toBe(beforeTarget.tokenNumber);
    expect(afterTarget.tokenNumber).toBe(beforeRequester.tokenNumber);
    expect(
      await prisma.auditLog.count({ where: { action: "SWAP_ACCEPTED", entityId: swapId } }),
    ).toBe(1);

    const rows = await prisma.appointment.findMany({
      where: { doctorId, serviceDay },
      select: { slotStart: true, tokenNumber: true },
    });
    expect(new Set(rows.map((row) => row.slotStart.toISOString())).size).toBe(rows.length);
    expect(new Set(rows.map((row) => row.tokenNumber)).size).toBe(rows.length);
  });

  it("allows only one of two overlapping swap requests", async () => {
    const sharedTarget = await book(patientB, slotI, "int-overlap-target");
    const firstRequester = await book(patientA, slotH, "int-overlap-a");
    const secondRequester = await book(patientC, slotJ, "int-overlap-c");
    const before = await Promise.all(
      [sharedTarget.id, firstRequester.id, secondRequester.id].map((id) =>
        prisma.appointment.findUniqueOrThrow({ where: { id } }),
      ),
    );

    const attempts = await Promise.allSettled([
      request(app)
        .post("/api/v1/swaps")
        .set(bearer(patientA.token))
        .set("Idempotency-Key", "int-overlap-1")
        .send({
          requesterAppointmentId: firstRequester.id,
          targetAppointmentId: sharedTarget.id,
        }),
      request(app)
        .post("/api/v1/swaps")
        .set(bearer(patientC.token))
        .set("Idempotency-Key", "int-overlap-2")
        .send({
          requesterAppointmentId: secondRequester.id,
          targetAppointmentId: sharedTarget.id,
        }),
    ]);
    const statuses = attempts.map((attempt) =>
      attempt.status === "fulfilled" ? attempt.value.status : 500,
    );
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);

    expect(
      await prisma.swapRequest.count({
        where: { status: "PENDING", targetAppointmentId: sharedTarget.id },
      }),
    ).toBe(1);

    // A pending request must not exchange slots or tokens yet.
    const after = await Promise.all(
      [sharedTarget.id, firstRequester.id, secondRequester.id].map((id) =>
        prisma.appointment.findUniqueOrThrow({ where: { id } }),
      ),
    );
    for (let index = 0; index < before.length; index += 1) {
      expect(after[index]!.slotStart.toISOString()).toBe(before[index]!.slotStart.toISOString());
      expect(after[index]!.tokenNumber).toBe(before[index]!.tokenNumber);
    }

    const rows = await prisma.appointment.findMany({
      where: { doctorId, serviceDay },
      select: { slotStart: true, tokenNumber: true },
    });
    expect(new Set(rows.map((row) => row.slotStart.toISOString())).size).toBe(rows.length);
    expect(new Set(rows.map((row) => row.tokenNumber)).size).toBe(rows.length);
  });
});
