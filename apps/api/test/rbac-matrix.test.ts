import { ROLES, type Role } from "@waitless/shared";
import { describe, expect, it } from "vitest";

/**
 * Framework-free, DB-free RBAC contract. This local table mirrors
 * `docs/rbac.md` / `docs/api.md`; it deliberately does not import the Express
 * routers so it can run as a pure unit test. If a documented route changes its
 * role gate, update the table here and the docs in the same change.
 */

type Access = "PUBLIC" | "AUTH" | "STAFF" | "PATIENT";
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface RouteRule {
  method: Method;
  path: string;
  access: Access;
  module: string;
}

const STAFF_ROLES = ROLES.filter((role): role is Role => role === "ADMIN" || role === "STAFF");
const PATIENT_ROLES = ROLES.filter((role): role is Role => role === "PATIENT");

const ROUTES: readonly RouteRule[] = [
  // health
  { method: "GET", path: "/health", access: "PUBLIC", module: "health" },
  { method: "GET", path: "/health/ready", access: "PUBLIC", module: "health" },

  // auth
  { method: "POST", path: "/auth/login", access: "PUBLIC", module: "auth" },
  { method: "POST", path: "/auth/refresh", access: "PUBLIC", module: "auth" },
  { method: "POST", path: "/auth/logout", access: "PUBLIC", module: "auth" },
  { method: "GET", path: "/auth/me", access: "AUTH", module: "auth" },

  // patients
  { method: "POST", path: "/patients/session", access: "PUBLIC", module: "patients" },
  { method: "GET", path: "/patients/me", access: "PATIENT", module: "patients" },
  { method: "PATCH", path: "/patients/me", access: "PATIENT", module: "patients" },
  { method: "GET", path: "/patients", access: "STAFF", module: "patients" },

  // departments
  { method: "GET", path: "/departments", access: "PUBLIC", module: "departments" },
  { method: "GET", path: "/departments/:id", access: "PUBLIC", module: "departments" },
  { method: "POST", path: "/departments", access: "STAFF", module: "departments" },
  { method: "PATCH", path: "/departments/:id", access: "STAFF", module: "departments" },
  { method: "DELETE", path: "/departments/:id", access: "STAFF", module: "departments" },

  // doctors, schedules, exceptions, availability
  { method: "GET", path: "/doctors", access: "PUBLIC", module: "doctors" },
  { method: "GET", path: "/doctors/:id", access: "PUBLIC", module: "doctors" },
  { method: "GET", path: "/doctors/:id/availability", access: "PUBLIC", module: "doctors" },
  { method: "GET", path: "/doctors/:id/schedules", access: "PUBLIC", module: "doctors" },
  { method: "GET", path: "/doctors/:id/exceptions", access: "PUBLIC", module: "doctors" },
  { method: "POST", path: "/doctors", access: "STAFF", module: "doctors" },
  { method: "PATCH", path: "/doctors/:id", access: "STAFF", module: "doctors" },
  { method: "DELETE", path: "/doctors/:id", access: "STAFF", module: "doctors" },
  { method: "POST", path: "/doctors/:id/schedules", access: "STAFF", module: "doctors" },
  { method: "PATCH", path: "/doctors/:id/schedules/:scheduleId", access: "STAFF", module: "doctors" },
  { method: "DELETE", path: "/doctors/:id/schedules/:scheduleId", access: "STAFF", module: "doctors" },
  { method: "PUT", path: "/doctors/:id/exceptions", access: "STAFF", module: "doctors" },
  { method: "DELETE", path: "/doctors/:id/exceptions/:exceptionId", access: "STAFF", module: "doctors" },

  // appointments
  { method: "POST", path: "/appointments", access: "PATIENT", module: "appointments" },
  { method: "POST", path: "/appointments/walk-in", access: "STAFF", module: "appointments" },
  { method: "GET", path: "/appointments", access: "AUTH", module: "appointments" },
  { method: "GET", path: "/appointments/:id", access: "AUTH", module: "appointments" },
  { method: "PATCH", path: "/appointments/:id/cancel", access: "AUTH", module: "appointments" },
  { method: "PATCH", path: "/appointments/:id/reschedule", access: "STAFF", module: "appointments" },

  // queue
  { method: "GET", path: "/queue/:doctorId", access: "AUTH", module: "queue" },
  { method: "PATCH", path: "/queue/entries/:id/call", access: "STAFF", module: "queue" },
  { method: "PATCH", path: "/queue/entries/:id/start", access: "STAFF", module: "queue" },
  { method: "PATCH", path: "/queue/entries/:id/complete", access: "STAFF", module: "queue" },
  { method: "PATCH", path: "/queue/entries/:id/skip", access: "STAFF", module: "queue" },
  { method: "PATCH", path: "/queue/entries/:id/arrive", access: "STAFF", module: "queue" },
  { method: "PATCH", path: "/queue/entries/:id/reorder", access: "STAFF", module: "queue" },
  { method: "PATCH", path: "/queue/entries/:id/no-show", access: "STAFF", module: "queue" },
  { method: "POST", path: "/queue/entries/:id/check-in", access: "PATIENT", module: "queue" },

  // qr
  { method: "GET", path: "/qr/hospital", access: "STAFF", module: "qr" },
  { method: "POST", path: "/qr/verify", access: "PUBLIC", module: "qr" },

  // swaps
  { method: "GET", path: "/swaps", access: "AUTH", module: "swaps" },
  { method: "POST", path: "/swaps/eligible", access: "PATIENT", module: "swaps" },
  { method: "POST", path: "/swaps", access: "PATIENT", module: "swaps" },
  { method: "PATCH", path: "/swaps/:id/respond", access: "PATIENT", module: "swaps" },
  { method: "PATCH", path: "/swaps/:id/cancel", access: "AUTH", module: "swaps" },

  // notifications
  { method: "GET", path: "/notifications/vapid-public-key", access: "AUTH", module: "notifications" },
  { method: "GET", path: "/notifications", access: "AUTH", module: "notifications" },
  { method: "GET", path: "/notifications/preferences", access: "AUTH", module: "notifications" },
  { method: "PATCH", path: "/notifications/preferences", access: "PATIENT", module: "notifications" },
  { method: "POST", path: "/notifications/push-subscribe", access: "PATIENT", module: "notifications" },
  { method: "DELETE", path: "/notifications/push-subscribe", access: "AUTH", module: "notifications" },
  { method: "PATCH", path: "/notifications/:id/read", access: "AUTH", module: "notifications" },
  { method: "PATCH", path: "/notifications/read-all", access: "AUTH", module: "notifications" },

  // hardware
  { method: "POST", path: "/hardware/events", access: "PUBLIC", module: "hardware" },
  { method: "GET", path: "/hardware/events", access: "STAFF", module: "hardware" },
  { method: "GET", path: "/hardware/rooms", access: "STAFF", module: "hardware" },
  { method: "GET", path: "/hardware/rooms/:code/events", access: "STAFF", module: "hardware" },
  { method: "POST", path: "/hardware/simulate", access: "STAFF", module: "hardware" },

  // analytics (read-only, staff/admin)
  { method: "GET", path: "/analytics/overview", access: "STAFF", module: "analytics" },
  { method: "GET", path: "/analytics/doctors", access: "STAFF", module: "analytics" },
  { method: "GET", path: "/analytics/appointments.csv", access: "STAFF", module: "analytics" },

  // admin (audit + job visibility)
  { method: "GET", path: "/admin/audit", access: "STAFF", module: "admin" },
  { method: "GET", path: "/admin/jobs", access: "STAFF", module: "admin" },
];

function label(route: RouteRule): string {
  return `${route.method} ${route.path}`;
}

/** Roles that may call an endpoint; PUBLIC is handled separately (no token). */
function permittedRoles(route: RouteRule): readonly Role[] {
  if (route.access === "STAFF") return STAFF_ROLES;
  if (route.access === "PATIENT") return PATIENT_ROLES;
  return ROLES; // AUTH
}

describe("documented RBAC matrix", () => {
  it("uses the shared ROLES enum with exactly three roles", () => {
    expect(ROLES).toEqual(["ADMIN", "STAFF", "PATIENT"]);
    expect(STAFF_ROLES).toEqual(["ADMIN", "STAFF"]);
    expect(PATIENT_ROLES).toEqual(["PATIENT"]);
  });

  it("declares each method/path at most once", () => {
    const keys = ROUTES.map(label);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ROUTES.length).toBeGreaterThan(50);
  });

  it("marks every documented admin and analytics endpoint ADMIN/STAFF-only", () => {
    const adminRoutes = ROUTES.filter((route) => route.module === "admin" || route.module === "analytics");
    expect(adminRoutes.length).toBeGreaterThanOrEqual(5);
    for (const route of adminRoutes) {
      expect(route.access, label(route)).toBe("STAFF");
      expect(permittedRoles(route)).toEqual(STAFF_ROLES);
      expect(permittedRoles(route)).not.toContain("PATIENT");
    }
  });

  it("marks every patient endpoint PATIENT-only", () => {
    const patientRoutes = ROUTES.filter((route) => route.access === "PATIENT");
    expect(patientRoutes.length).toBeGreaterThanOrEqual(9);
    for (const route of patientRoutes) {
      expect(permittedRoles(route)).toEqual(["PATIENT"]);
      expect(permittedRoles(route)).not.toContain("ADMIN");
      expect(permittedRoles(route)).not.toContain("STAFF");
    }
    expect(patientRoutes.map(label)).toContain("POST /appointments");
    expect(patientRoutes.map(label)).toContain("POST /queue/entries/:id/check-in");
    expect(patientRoutes.map(label)).toContain("PATCH /swaps/:id/respond");
    expect(patientRoutes.map(label)).toContain("PATCH /notifications/preferences");
  });

  it("requires a token for every endpoint that is not explicitly public", () => {
    const protectedRoutes = ROUTES.filter((route) => route.access !== "PUBLIC");
    expect(protectedRoutes.length).toBeGreaterThan(30);
    for (const route of protectedRoutes) {
      expect(["AUTH", "STAFF", "PATIENT"]).toContain(route.access);
      expect(permittedRoles(route).length).toBeGreaterThan(0);
    }
  });

  it("keeps all queue mutations staff-only except the patient's own check-in", () => {
    const mutations = ROUTES.filter((route) => route.module === "queue" && route.method !== "GET");
    expect(mutations.length).toBeGreaterThanOrEqual(8);
    for (const route of mutations) {
      if (route.path === "/queue/entries/:id/check-in") {
        expect(route.access).toBe("PATIENT");
      } else {
        expect(route.access, label(route)).toBe("STAFF");
      }
    }
  });

  it("keeps swap creation, candidate lookup and response patient-only", () => {
    const writes = ROUTES.filter((route) => route.module === "swaps" && route.method !== "GET");
    expect(writes.map((route) => route.access)).toEqual(["PATIENT", "PATIENT", "PATIENT", "AUTH"]);
    expect(writes.slice(0, 3).map(permittedRoles)).toEqual([["PATIENT"], ["PATIENT"], ["PATIENT"]]);
  });

  it("allows all roles on read-only shared views and ownership-scoped actions", () => {
    const shared = ROUTES.filter((route) => route.access === "AUTH");
    expect(shared.map(label)).toEqual(
      expect.arrayContaining([
        "GET /auth/me",
        "GET /appointments",
        "GET /appointments/:id",
        "PATCH /appointments/:id/cancel",
        "GET /queue/:doctorId",
        "GET /swaps",
        "GET /notifications",
        "PATCH /notifications/:id/read",
      ]),
    );
    for (const route of shared) expect(permittedRoles(route)).toEqual(ROLES);
  });

  it("only exposes the documented unauthenticated entry points", () => {
    const publicRoutes = ROUTES.filter((route) => route.access === "PUBLIC").map(label);
    expect(publicRoutes).toEqual(
      expect.arrayContaining([
        "GET /health",
        "GET /health/ready",
        "POST /auth/login",
        "POST /auth/refresh",
        "POST /patients/session",
        "GET /departments",
        "GET /doctors",
        "POST /qr/verify",
        "POST /hardware/events",
      ]),
    );
    expect(publicRoutes).not.toContain("GET /admin/jobs");
    expect(publicRoutes).not.toContain("GET /analytics/overview");
    expect(publicRoutes).not.toContain("POST /queue/entries/:id/check-in");
  });
});
