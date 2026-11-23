import { resolve } from "node:path";
import { hash } from "@node-rs/argon2";
import { PrismaClient, type AppointmentStatus, type Prisma } from "@prisma/client";
import {
  addDaysToDayKey,
  dayOfWeek,
  generateSlotsForWindows,
  toDayKey,
  zonedDateTimeToUtc,
} from "@waitless/shared";
import { config as loadDotenv } from "dotenv";

for (const path of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  loadDotenv({ path, override: false, quiet: true });
}

const prisma = new PrismaClient();

const TIMEZONE = process.env.HOSPITAL_TIMEZONE ?? "Asia/Kolkata";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "Admin@12345";
const SEED_TAG = "[seed]";
/** `db:seed:demo` passes this flag; plain `db:seed` keeps the general fixture. */
const DEMO_MODE = process.argv.includes("--demo");

type SeedAppointment = {
  doctorIndex: number;
  patientIndex: number;
  slotStartMinute: number;
  status: AppointmentStatus;
  source?: "QR" | "REMOTE" | "WALK_IN";
  withQueue?: boolean;
  notes?: string;
  /** Demo-only: recorded duration for a finished consultation. */
  completedSeconds?: number;
};

type CreatedAppointment = {
  id: string;
  patientId: string;
  status: AppointmentStatus;
  doctorIndex: number;
  tokenNumber: number;
  queueEntryId?: string;
};

/**
 * Demo data for local development.
 *
 * Idempotency: structural rows (users, departments, doctors, schedules) are
 * upserted; demo-day appointments are tagged "[seed]" and recreated on every
 * run so the fixture never accumulates stale duplicates. `--demo` selects the
 * guided mid-flow fixture (see docs/demo.md) and seeds its history as well.
 */
async function main() {
  console.log(`Seeding Waitless ${DEMO_MODE ? "guided demo" : "general"} data (timezone: ${TIMEZONE})`);

  const passwordHash = await hash(ADMIN_PASSWORD);

  // --- Staff accounts -------------------------------------------------------
  const admin = await prisma.user.upsert({
    where: { email: process.env.SEED_ADMIN_EMAIL ?? "admin@waitless.local" },
    update: { name: process.env.SEED_ADMIN_NAME ?? "Hospital Admin", passwordHash },
    create: {
      email: process.env.SEED_ADMIN_EMAIL ?? "admin@waitless.local",
      phone: process.env.SEED_ADMIN_PHONE ?? "9000000000",
      name: process.env.SEED_ADMIN_NAME ?? "Hospital Admin",
      role: "ADMIN",
      passwordHash,
    },
  });

  await prisma.adminProfile.upsert({
    where: { userId: admin.id },
    update: { designation: "Hospital Administrator" },
    create: { userId: admin.id, designation: "Hospital Administrator", staffCode: "ADM-001" },
  });

  const staff = await prisma.user.upsert({
    where: { email: "frontdesk@waitless.local" },
    update: { passwordHash },
    create: {
      email: "frontdesk@waitless.local",
      phone: "9000000001",
      name: "Front Desk",
      role: "STAFF",
      passwordHash,
    },
  });

  await prisma.adminProfile.upsert({
    where: { userId: staff.id },
    update: { designation: "Front Desk Executive" },
    create: { userId: staff.id, designation: "Front Desk Executive", staffCode: "STF-001" },
  });

  // --- Departments ----------------------------------------------------------
  const departmentSeeds = [
    {
      code: "GM",
      name: "General Medicine",
      description: "Primary care, fevers, infections and routine check-ups.",
      location: "Ground floor, Block A",
    },
    {
      code: "CARD",
      name: "Cardiology",
      description: "Heart health, ECG, echocardiography and follow-ups.",
      location: "First floor, Block B",
    },
    {
      code: "ORTHO",
      name: "Orthopaedics",
      description: "Bone, joint and sports injuries.",
      location: "Ground floor, Block C",
    },
    {
      code: "PAED",
      name: "Paediatrics",
      description: "Child health, vaccination and growth monitoring.",
      location: "Second floor, Block A",
    },
    {
      code: "DERM",
      name: "Dermatology",
      description: "Skin, hair and nail conditions.",
      location: "First floor, Block C",
    },
  ] as const;

  const departments = new Map<string, string>();
  for (const seed of departmentSeeds) {
    const department = await prisma.department.upsert({
      where: { code: seed.code },
      update: { name: seed.name, description: seed.description, location: seed.location },
      create: seed,
    });
    departments.set(seed.code, department.id);
  }

  // --- Rooms ----------------------------------------------------------------
  const rooms = new Map<string, string>();
  for (let index = 1; index <= 8; index += 1) {
    const code = `OPD-${index}`;
    const room = await prisma.room.upsert({
      where: { code },
      update: { name: `Consultation Room ${index}` },
      create: { code, name: `Consultation Room ${index}` },
    });
    rooms.set(code, room.id);
  }

  // --- Doctors --------------------------------------------------------------
  const doctorSeeds = [
    {
      fullName: "Dr. Anita Rao",
      department: "GM",
      designation: "Senior Consultant",
      avgConsultMinutes: 10,
      room: "OPD-1",
    },
    {
      fullName: "Dr. Vikram Menon",
      department: "CARD",
      designation: "Consultant Cardiologist",
      avgConsultMinutes: 15,
      room: "OPD-2",
    },
    {
      fullName: "Dr. Sneha Kulkarni",
      department: "ORTHO",
      designation: "Consultant Orthopaedic Surgeon",
      avgConsultMinutes: 12,
      room: "OPD-3",
    },
    {
      fullName: "Dr. Arjun Nair",
      department: "PAED",
      designation: "Consultant Paediatrician",
      avgConsultMinutes: 10,
      room: "OPD-4",
    },
    {
      fullName: "Dr. Priya Sharma",
      department: "DERM",
      designation: "Consultant Dermatologist",
      avgConsultMinutes: 8,
      room: "OPD-5",
    },
    {
      fullName: "Dr. Rahul Verma",
      department: "GM",
      designation: "Consultant Physician",
      avgConsultMinutes: 12,
      room: "OPD-6",
    },
    {
      fullName: "Dr. Meera Iyer",
      department: "CARD",
      designation: "Senior Consultant Cardiologist",
      avgConsultMinutes: 18,
      room: "OPD-7",
    },
    {
      fullName: "Dr. Karthik Reddy",
      department: "ORTHO",
      designation: "Consultant Orthopaedic Surgeon",
      avgConsultMinutes: 15,
      room: "OPD-8",
    },
  ] as const;

  const doctors = [];
  for (const seed of doctorSeeds) {
    const departmentId = departments.get(seed.department);
    const roomId = rooms.get(seed.room);
    if (!departmentId || !roomId) throw new Error(`Missing department/room for ${seed.fullName}`);

    const doctor = await prisma.doctor.upsert({
      where: { roomId },
      update: {
        departmentId,
        fullName: seed.fullName,
        designation: seed.designation,
        avgConsultMinutes: seed.avgConsultMinutes,
      },
      create: {
        departmentId,
        roomId,
        fullName: seed.fullName,
        designation: seed.designation,
        avgConsultMinutes: seed.avgConsultMinutes,
      },
    });
    doctors.push(doctor);
  }

  // Weekly schedule: Mon-Sat, morning and evening clinics.
  const scheduleWindows = [
    { startMinute: 9 * 60, endMinute: 13 * 60, slotMinutes: 15 },
    { startMinute: 17 * 60, endMinute: 20 * 60, slotMinutes: 15 },
  ];
  for (const doctor of doctors) {
    await prisma.doctorSchedule.deleteMany({ where: { doctorId: doctor.id } });
    await prisma.doctorSchedule.createMany({
      data: [1, 2, 3, 4, 5, 6].flatMap((weekday) =>
        scheduleWindows.map((window) => ({
          doctorId: doctor.id,
          dayOfWeek: weekday,
          startMinute: window.startMinute,
          endMinute: window.endMinute,
          slotMinutes: window.slotMinutes,
        })),
      ),
    });
  }

  // --- Patients -------------------------------------------------------------
  const patientSeeds = [
    { fullName: "Rohan Kumar", phone: "9876543210", email: "rohan@example.com", gender: "male" },
    { fullName: "Ananya Desai", phone: "9876543211", email: "ananya@example.com", gender: "female" },
    { fullName: "Mohammed Faiz", phone: "9876543212", email: "faiz@example.com", gender: "male" },
    { fullName: "Kavya Pillai", phone: "9876543213", email: "kavya@example.com", gender: "female" },
    { fullName: "Aditya Bose", phone: "9876543214", email: "aditya@example.com", gender: "male" },
    { fullName: "Fatima Sheikh", phone: "9876543215", email: "fatima@example.com", gender: "female" },
  ] as const;

  const patients = [];
  for (const seed of patientSeeds) {
    const user = await prisma.user.upsert({
      where: { phone: seed.phone },
      update: { name: seed.fullName },
      create: { name: seed.fullName, phone: seed.phone, role: "PATIENT" },
    });
    const patient = await prisma.patient.upsert({
      where: { phone: seed.phone },
      update: { fullName: seed.fullName, email: seed.email, userId: user.id },
      create: {
        fullName: seed.fullName,
        phone: seed.phone,
        email: seed.email,
        gender: seed.gender,
        userId: user.id,
      },
    });
    await prisma.notificationPreference.upsert({
      where: { patientId: patient.id },
      update: {},
      create: { patientId: patient.id },
    });
    patients.push(patient);
  }

  // --- Demo day -------------------------------------------------------------
  const today = toDayKey(new Date(), TIMEZONE);
  const demoDay = nextWorkingDay(today);
  const now = new Date();

  const historyDay = previousWorkingDay(today);
  const taggedDays = [...new Set([demoDay, historyDay])];
  const taggedAppointments = await prisma.appointment.findMany({
    where: { OR: taggedDays.map((serviceDay) => ({ serviceDay, notes: { startsWith: SEED_TAG } })) },
    select: { id: true },
  });
  const taggedAppointmentIds = taggedAppointments.map((row) => row.id);
  const taggedQueueEntries = await prisma.queueEntry.findMany({
    where: { appointmentId: { in: taggedAppointmentIds } },
    select: { id: true },
  });
  const taggedQueueEntryIds = taggedQueueEntries.map((row) => row.id);
  // Notifications/audit rows have no FK to the seeded appointments, so remove
  // them first to avoid accumulating duplicates on repeated seeds.
  await prisma.notification.deleteMany({ where: { appointmentId: { in: taggedAppointmentIds } } });
  await prisma.auditLog.deleteMany({
    where: {
      entity: { in: ["Appointment", "QueueEntry"] },
      entityId: { in: [...taggedAppointmentIds, ...taggedQueueEntryIds] },
    },
  });
  await prisma.appointment.deleteMany({ where: { id: { in: taggedAppointmentIds } } });

  const tokenCounters = new Map<string, number>();
  const positionCounters = new Map<string, number>();

  /** Standard local fixture used by `pnpm db:seed`. */
  const generalAppointments: SeedAppointment[] = [
    // Dr. Anita Rao — busy clinic mid-flow (positions 1..6)
    { doctorIndex: 0, patientIndex: 1, slotStartMinute: 540, status: "COMPLETED", withQueue: true },
    { doctorIndex: 0, patientIndex: 2, slotStartMinute: 555, status: "COMPLETED", withQueue: true },
    {
      doctorIndex: 0,
      patientIndex: 0,
      slotStartMinute: 570,
      status: "IN_CONSULTATION",
      withQueue: true,
    },
    { doctorIndex: 0, patientIndex: 3, slotStartMinute: 585, status: "CALLED", withQueue: true },
    { doctorIndex: 0, patientIndex: 4, slotStartMinute: 600, status: "WAITING", withQueue: true },
    { doctorIndex: 0, patientIndex: 5, slotStartMinute: 615, status: "WAITING", withQueue: true },

    // Dr. Vikram Menon — a delayed patient plus a swap candidate
    { doctorIndex: 1, patientIndex: 3, slotStartMinute: 540, status: "DELAYED", withQueue: true },
    { doctorIndex: 1, patientIndex: 4, slotStartMinute: 555, status: "WAITING", withQueue: true },
    { doctorIndex: 1, patientIndex: 5, slotStartMinute: 570, status: "NOTIFIED", withQueue: true },
    { doctorIndex: 1, patientIndex: 1, slotStartMinute: 585, status: "BOOKED" },

    // Other doctors — upcoming bookings
    { doctorIndex: 2, patientIndex: 0, slotStartMinute: 540, status: "BOOKED" },
    { doctorIndex: 2, patientIndex: 2, slotStartMinute: 555, status: "BOOKED" },
    { doctorIndex: 3, patientIndex: 4, slotStartMinute: 540, status: "BOOKED", source: "QR" },
    { doctorIndex: 4, patientIndex: 3, slotStartMinute: 540, status: "BOOKED", source: "QR" },
    { doctorIndex: 5, patientIndex: 1, slotStartMinute: 1020, status: "BOOKED" },
    { doctorIndex: 6, patientIndex: 5, slotStartMinute: 1020, status: "BOOKED" },
    { doctorIndex: 7, patientIndex: 2, slotStartMinute: 1020, status: "BOOKED" },
  ];

  /**
   * Guided fixture for `pnpm db:seed:demo` (docs/demo.md):
   * Dr. Rao tokens 1-2 COMPLETED, 3 IN_CONSULTATION, 4 CALLED, 5-6 WAITING;
   * Dr. Menon DELAYED/WAITING/NOTIFIED/BOOKED. Totals: 6 still waiting,
   * 1 in consultation, 1 delayed.
   */
  const demoAppointments: SeedAppointment[] = [
    { doctorIndex: 0, patientIndex: 1, slotStartMinute: 540, status: "COMPLETED", withQueue: true, notes: "demo token 1", completedSeconds: 9 * 60 },
    { doctorIndex: 0, patientIndex: 2, slotStartMinute: 555, status: "COMPLETED", withQueue: true, notes: "demo token 2", completedSeconds: 11 * 60 },
    { doctorIndex: 0, patientIndex: 0, slotStartMinute: 570, status: "IN_CONSULTATION", withQueue: true, notes: "demo token 3" },
    { doctorIndex: 0, patientIndex: 3, slotStartMinute: 585, status: "CALLED", withQueue: true, notes: "demo token 4" },
    { doctorIndex: 0, patientIndex: 4, slotStartMinute: 600, status: "WAITING", withQueue: true, notes: "demo token 5" },
    { doctorIndex: 0, patientIndex: 5, slotStartMinute: 615, status: "WAITING", withQueue: true, notes: "demo token 6" },

    { doctorIndex: 1, patientIndex: 3, slotStartMinute: 540, status: "DELAYED", withQueue: true, notes: "demo delayed" },
    { doctorIndex: 1, patientIndex: 4, slotStartMinute: 555, status: "WAITING", withQueue: true, notes: "demo waiting" },
    { doctorIndex: 1, patientIndex: 5, slotStartMinute: 570, status: "NOTIFIED", withQueue: true, notes: "demo notified" },
    { doctorIndex: 1, patientIndex: 1, slotStartMinute: 585, status: "BOOKED", notes: "demo swap candidate" },

    // Three more waiting visits bring the documented demo total to six.
    { doctorIndex: 2, patientIndex: 0, slotStartMinute: 540, status: "WAITING", withQueue: true, notes: "demo waiting" },
    { doctorIndex: 3, patientIndex: 4, slotStartMinute: 540, status: "WAITING", withQueue: true, notes: "demo waiting", source: "QR" },
    { doctorIndex: 4, patientIndex: 3, slotStartMinute: 540, status: "WAITING", withQueue: true, notes: "demo waiting", source: "QR" },

    { doctorIndex: 2, patientIndex: 2, slotStartMinute: 555, status: "BOOKED" },
    { doctorIndex: 5, patientIndex: 1, slotStartMinute: 1020, status: "BOOKED" },
    { doctorIndex: 6, patientIndex: 5, slotStartMinute: 1020, status: "BOOKED" },
    { doctorIndex: 7, patientIndex: 2, slotStartMinute: 1020, status: "BOOKED" },
  ];

  const appointmentSeeds = DEMO_MODE ? demoAppointments : generalAppointments;
  const created: CreatedAppointment[] = [];

  for (const seed of appointmentSeeds) {
    const doctor = doctors[seed.doctorIndex];
    const patient = patients[seed.patientIndex];
    if (!doctor || !patient) throw new Error("Seed index out of range");

    const tokenNumber = (tokenCounters.get(doctor.id) ?? 0) + 1;
    tokenCounters.set(doctor.id, tokenNumber);

    const slotStart = zonedDateTimeToUtc(demoDay, seed.slotStartMinute, TIMEZONE);
    const slotEnd = new Date(slotStart.getTime() + doctor.avgConsultMinutes * 60_000);
    const notes = [SEED_TAG, seed.notes].filter(Boolean).join(" ");

    const appointment = await prisma.appointment.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        departmentId: doctor.departmentId,
        slotStart,
        slotEnd,
        serviceDay: demoDay,
        tokenNumber,
        status: seed.status,
        source: seed.source ?? "REMOTE",
        notes,
        checkedInAt: seed.withQueue ? new Date(now.getTime() - 20 * 60_000) : null,
      },
    });
    const record: CreatedAppointment = {
      id: appointment.id,
      patientId: patient.id,
      status: seed.status,
      doctorIndex: seed.doctorIndex,
      tokenNumber,
    };
    created.push(record);

    if (!seed.withQueue) continue;

    const position = (positionCounters.get(doctor.id) ?? 0) + 1;
    positionCounters.set(doctor.id, position);

    const ahead = position - 1;
    const estimatedStartAt =
      seed.status === "IN_CONSULTATION"
        ? new Date(now.getTime() - 6 * 60_000)
        : new Date(now.getTime() + ahead * doctor.avgConsultMinutes * 60_000);

    const queueEntry = await prisma.queueEntry.create({
      data: {
        appointmentId: appointment.id,
        doctorId: doctor.id,
        serviceDay: demoDay,
        position,
        status: seed.status,
        estimatedStartAt,
        calledAt: seed.status === "CALLED" ? new Date(now.getTime() - 60_000) : null,
        graceDeadlineAt:
          seed.status === "CALLED" ? new Date(now.getTime() + 9 * 60_000) : null,
        notifiedAt:
          seed.status === "NOTIFIED" ? new Date(now.getTime() - 5 * 60_000) : null,
        completedAt: seed.status === "COMPLETED" ? new Date(now.getTime() - 15 * 60_000) : null,
      },
    });

    record.queueEntryId = queueEntry.id;

    if (seed.status === "IN_CONSULTATION") {
      await prisma.consultation.create({
        data: {
          queueEntryId: queueEntry.id,
          startedAt: new Date(now.getTime() - 6 * 60_000),
          startedByUserId: staff.id,
        },
      });
    } else if (seed.status === "COMPLETED" && seed.completedSeconds) {
      // The guided demo's finished tokens show a realistic rolling average.
      const endedAt = new Date(now.getTime() - 15 * 60_000);
      await prisma.consultation.create({
        data: {
          queueEntryId: queueEntry.id,
          startedAt: new Date(endedAt.getTime() - seed.completedSeconds * 1000),
          endedAt,
          endSource: "STAFF",
          durationSeconds: seed.completedSeconds,
          startedByUserId: staff.id,
        },
      });
    }
  }

  if (DEMO_MODE) {
    await seedDemoHistory(created, staff.id, now);

    const flowCounts = {
      waiting: created.filter((appointment) => appointment.status === "WAITING").length,
      inConsultation: created.filter((appointment) => appointment.status === "IN_CONSULTATION").length,
      delayed: created.filter((appointment) => appointment.status === "DELAYED").length,
    };
    console.log(`Demo flow: ${JSON.stringify(flowCounts)}`);
    if (flowCounts.waiting !== 6 || flowCounts.inConsultation !== 1 || flowCounts.delayed !== 1) {
      throw new Error(`Demo fixture flow counts are wrong: ${JSON.stringify(flowCounts)}`);
    }
  }

  // --- Past visit history ---------------------------------------------------
  const historyDoctor = doctors[0];
  const historyPatient = patients[0];
  if (historyDoctor && historyPatient) {
    const historyStart = zonedDateTimeToUtc(historyDay, 600, TIMEZONE);
    await prisma.appointment.create({
      data: {
        patientId: historyPatient.id,
        doctorId: historyDoctor.id,
        departmentId: historyDoctor.departmentId,
        slotStart: historyStart,
        slotEnd: new Date(historyStart.getTime() + historyDoctor.avgConsultMinutes * 60_000),
        serviceDay: historyDay,
        tokenNumber: 3,
        status: "COMPLETED",
        source: "REMOTE",
        notes: `${SEED_TAG} past visit for history`,
        checkedInAt: historyStart,
      },
    });
  }

  // --- Notifications --------------------------------------------------------
  const primary = created.find((appointment) => appointment.status === "IN_CONSULTATION");
  if (primary) {
    const doctor = doctors[0];
    await prisma.notification.upsert({
      where: { dedupeKey: `booking:${primary.id}` },
      update: {},
      create: {
        patientId: primary.patientId,
        appointmentId: primary.id,
        type: "BOOKING_CONFIRMED",
        channel: "IN_APP",
        title: "Appointment confirmed",
        body: `Your appointment with ${doctor?.fullName ?? "the doctor"} is confirmed. Token #${
          created.indexOf(primary) + 1
        }.`,
        status: "SENT",
        sentAt: new Date(now.getTime() - 90 * 60_000),
        dedupeKey: `booking:${primary.id}`,
        data: { appointmentId: primary.id, tag: SEED_TAG },
      },
    });
    await prisma.notification.upsert({
      where: { dedupeKey: `ready30:${primary.id}` },
      update: {},
      create: {
        patientId: primary.patientId,
        appointmentId: primary.id,
        type: "READY_30_MIN",
        channel: "IN_APP",
        title: "Get ready — about 30 minutes to go",
        body: "Please reach the hospital desk within 20 minutes.",
        status: "SENT",
        sentAt: new Date(now.getTime() - 35 * 60_000),
        dedupeKey: `ready30:${primary.id}`,
        data: { appointmentId: primary.id, tag: SEED_TAG },
      },
    });
  }

  // --- Pending swap ---------------------------------------------------------
  const swapRequester = created.find((appointment) => appointment.status === "WAITING");
  const swapTarget = created.find((appointment) => appointment.status === "NOTIFIED");
  if (swapRequester && swapTarget) {
    await prisma.swapRequest.deleteMany({
      where: { message: { startsWith: SEED_TAG } },
    });
    await prisma.swapRequest.create({
      data: {
        requesterAppointmentId: swapRequester.id,
        targetAppointmentId: swapTarget.id,
        requesterPatientId: swapRequester.patientId,
        targetPatientId: swapTarget.patientId,
        status: "PENDING",
        message: `${SEED_TAG} demo swap request`,
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      },
    });
  }

  const counts = {
    departments: await prisma.department.count(),
    doctors: await prisma.doctor.count(),
    patients: await prisma.patient.count(),
    appointments: await prisma.appointment.count({ where: { serviceDay: demoDay } }),
    queueEntries: await prisma.queueEntry.count({ where: { serviceDay: demoDay } }),
  };

  console.log(`Demo day: ${demoDay} (${TIMEZONE})`);
  console.log(`Seeded: ${JSON.stringify(counts)}`);
  console.log(`Admin login: ${admin.email} / ${ADMIN_PASSWORD}`);
  console.log(`Front desk login: ${staff.email} / ${ADMIN_PASSWORD}`);
}

/** Adds realistic (but tagged) queue history for the guided demo fixture. */
async function seedDemoHistory(
  created: CreatedAppointment[],
  actorUserId: string,
  now: Date,
): Promise<void> {
  type QueueAction = "QUEUE_CALLED" | "QUEUE_STARTED" | "QUEUE_COMPLETED";

  const raoToken = (tokenNumber: number) => {
    const record = created.find(
      (appointment) => appointment.doctorIndex === 0 && appointment.tokenNumber === tokenNumber,
    );
    if (!record?.queueEntryId) {
      throw new Error(`Missing demo queue entry for Dr. Rao token ${tokenNumber}`);
    }
    return { record, queueEntryId: record.queueEntryId };
  };

  const writeAudit = async (
    queueEntryId: string,
    tokenNumber: number,
    action: QueueAction,
    status: string,
    minutesAgo: number,
  ) => {
    await prisma.auditLog.create({
      data: {
        actorUserId,
        action,
        entity: "QueueEntry",
        entityId: queueEntryId,
        after: {
          tag: SEED_TAG,
          tokenNumber,
          status,
        } as Prisma.InputJsonValue,
        createdAt: new Date(now.getTime() - minutesAgo * 60_000),
      },
    });
  };

  const token1 = raoToken(1);
  await writeAudit(token1.queueEntryId, 1, "QUEUE_CALLED", "CALLED", 28);
  await writeAudit(token1.queueEntryId, 1, "QUEUE_STARTED", "IN_CONSULTATION", 27);
  await writeAudit(token1.queueEntryId, 1, "QUEUE_COMPLETED", "COMPLETED", 15);

  const token2 = raoToken(2);
  await writeAudit(token2.queueEntryId, 2, "QUEUE_CALLED", "CALLED", 20);
  await writeAudit(token2.queueEntryId, 2, "QUEUE_STARTED", "IN_CONSULTATION", 19);
  await writeAudit(token2.queueEntryId, 2, "QUEUE_COMPLETED", "COMPLETED", 15);

  const token3 = raoToken(3);
  await writeAudit(token3.queueEntryId, 3, "QUEUE_CALLED", "CALLED", 8);
  await writeAudit(token3.queueEntryId, 3, "QUEUE_STARTED", "IN_CONSULTATION", 6);

  const token4 = raoToken(4);
  await writeAudit(token4.queueEntryId, 4, "QUEUE_CALLED", "CALLED", 1);

  const delayed = created.find(
    (appointment) => appointment.doctorIndex === 1 && appointment.status === "DELAYED",
  );
  if (!delayed) throw new Error("Missing demo delayed appointment for Dr. Menon");

  await prisma.notification.upsert({
    where: { dedupeKey: `seed-delay:${delayed.id}` },
    update: {},
    create: {
      patientId: delayed.patientId,
      appointmentId: delayed.id,
      type: "DELAY_WARNING",
      channel: "IN_APP",
      title: "Running behind schedule",
      body: "Your consultation is delayed. Please check in with the front desk.",
      status: "SENT",
      sentAt: new Date(now.getTime() - 5 * 60_000),
      dedupeKey: `seed-delay:${delayed.id}`,
      data: {
        tag: SEED_TAG,
        appointmentId: delayed.id,
        tokenNumber: delayed.tokenNumber,
      } as Prisma.InputJsonValue,
    },
  });
}

function nextWorkingDay(startDay: string): string {
  for (let offset = 0; offset < 7; offset += 1) {
    const day = addDaysToDayKey(startDay, offset);
    if (dayOfWeek(day) !== 0) return day;
  }
  return startDay;
}

function previousWorkingDay(startDay: string): string {
  for (let offset = 1; offset < 8; offset += 1) {
    const day = addDaysToDayKey(startDay, -offset);
    if (dayOfWeek(day) !== 0) return day;
  }
  return startDay;
}

// Keeps the shared slot generator honest: the seeded clinics must actually
// produce the slots the demo appointments assume.
const sanitySlots = generateSlotsForWindows([
  { startMinute: 9 * 60, endMinute: 13 * 60, slotMinutes: 15 },
]);
if (sanitySlots.length !== 16) throw new Error("Schedule generator sanity check failed");

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
