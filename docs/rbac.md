# RBAC matrix

Roles come from `Role` in the Prisma schema and `ROLES` in
`packages/shared/src/enums.ts`: `ADMIN`, `STAFF`, `PATIENT`, plus anonymous
(no token). Paths are relative to `/api/v1`.

Legend:

| Mark | Meaning |
|---|---|
| ✓ | Allowed |
| — | Denied: `401 UNAUTHORIZED` with no token, `403 FORBIDDEN` with the wrong role |
| `cookie` | Public route, but a valid `waitless_refresh` cookie is required |
| `HMAC` | Public HTTP route, but a valid device signature is required |

**AUTH** rows allow all three authenticated roles; they are still
**ownership-scoped** in the service layer (for example, a patient only sees
their own appointments). **STAFF** rows are `ADMIN|STAFF`; **PATIENT** rows are
`PATIENT` only.

## Complete route matrix

| Area / endpoint | Access | Anonymous | PATIENT | STAFF | ADMIN | Notes |
|---|---|---:|---:|---:|---:|---|
| `GET /health` | PUBLIC | ✓ | ✓ | ✓ | ✓ | Liveness |
| `GET /health/ready` | PUBLIC | ✓ | ✓ | ✓ | ✓ | 503 when DB/Redis down |
| `POST /auth/login` | PUBLIC | ✓ | ✓ | ✓ | ✓ | Staff (`ADMIN`/`STAFF`) accounts only; 401/403/429 |
| `POST /auth/refresh` | PUBLIC | `cookie` | `cookie` | `cookie` | `cookie` | Rotates refresh token |
| `POST /auth/logout` | PUBLIC | `cookie` | `cookie` | `cookie` | `cookie` | Revokes current refresh row; 204 |
| `GET /auth/me` | AUTH | — | ✓ | ✓ | ✓ | Current user profile |
| `POST /patients/session` | PUBLIC | ✓ | ✓ | ✓ | ✓ | Mock name+phone sign-in (no OTP), 201 |
| `GET /patients/me` | PATIENT | — | ✓ | — | — | Own profile only |
| `PATCH /patients/me` | PATIENT | — | ✓ | — | — | Name/email only; no phone change |
| `GET /patients` | STAFF | — | — | ✓ | ✓ | `?q=&page=&pageSize=` |
| `GET /departments` | PUBLIC | ✓ | ✓ | ✓ | ✓ | Active by default |
| `GET /departments/:id` | PUBLIC | ✓ | ✓ | ✓ | ✓ | — |
| `POST /departments` | STAFF | — | — | ✓ | ✓ | — |
| `PATCH /departments/:id` | STAFF | — | — | ✓ | ✓ | — |
| `DELETE /departments/:id` | STAFF | — | — | ✓ | ✓ | Soft delete |
| `GET /doctors` | PUBLIC | ✓ | ✓ | ✓ | ✓ | — |
| `GET /doctors/:id` | PUBLIC | ✓ | ✓ | ✓ | ✓ | — |
| `GET /doctors/:id/availability` | PUBLIC | ✓ | ✓ | ✓ | ✓ | `?date=` required |
| `GET /doctors/:id/schedules` | PUBLIC | ✓ | ✓ | ✓ | ✓ | — |
| `GET /doctors/:id/exceptions` | PUBLIC | ✓ | ✓ | ✓ | ✓ | — |
| `POST /doctors` | STAFF | — | — | ✓ | ✓ | — |
| `PATCH /doctors/:id` | STAFF | — | — | ✓ | ✓ | — |
| `DELETE /doctors/:id` | STAFF | — | — | ✓ | ✓ | Soft delete |
| `POST /doctors/:id/schedules` | STAFF | — | — | ✓ | ✓ | — |
| `PATCH /doctors/:id/schedules/:scheduleId` | STAFF | — | — | ✓ | ✓ | — |
| `DELETE /doctors/:id/schedules/:scheduleId` | STAFF | — | — | ✓ | ✓ | — |
| `PUT /doctors/:id/exceptions` | STAFF | — | — | ✓ | ✓ | — |
| `DELETE /doctors/:id/exceptions/:exceptionId` | STAFF | — | — | ✓ | ✓ | — |
| `POST /appointments` | PATIENT | — | ✓ | — | — | Requires `Idempotency-Key` |
| `POST /appointments/walk-in` | STAFF | — | — | ✓ | ✓ | Finds/creates patient |
| `GET /appointments` | AUTH | — | ✓ | ✓ | ✓ | Patients forced to own records |
| `GET /appointments/:id` | AUTH | — | ✓ own | ✓ | ✓ | 403 for others' records |
| `PATCH /appointments/:id/cancel` | AUTH | — | ✓ own | ✓ | ✓ | Status/cutoff rules apply |
| `PATCH /appointments/:id/reschedule` | STAFF | — | — | ✓ | ✓ | — |
| `GET /queue/:doctorId` | AUTH | — | ✓ | ✓ | ✓ | Any authenticated viewer |
| `PATCH /queue/entries/:id/call` | STAFF | — | — | ✓ | ✓ | — |
| `PATCH /queue/entries/:id/start` | STAFF | — | — | ✓ | ✓ | — |
| `PATCH /queue/entries/:id/complete` | STAFF | — | — | ✓ | ✓ | — |
| `PATCH /queue/entries/:id/skip` | STAFF | — | — | ✓ | ✓ | — |
| `PATCH /queue/entries/:id/arrive` | STAFF | — | — | ✓ | ✓ | — |
| `PATCH /queue/entries/:id/reorder` | STAFF | — | — | ✓ | ✓ | — |
| `PATCH /queue/entries/:id/no-show` | STAFF | — | — | ✓ | ✓ | — |
| `POST /queue/entries/:id/check-in` | PATIENT | — | ✓ own | — | — | One-time per appointment |
| `GET /qr/hospital` | STAFF | — | — | ✓ | ✓ | HMAC-signed token |
| `POST /qr/verify` | PUBLIC | ✓ | ✓ | ✓ | ✓ | Validates signature + age |
| `GET /swaps` | AUTH | — | ✓ own | ✓ | ✓ | Staff see recent list |
| `POST /swaps/eligible` | PATIENT | — | ✓ | — | — | Masked candidates |
| `POST /swaps` | PATIENT | — | ✓ | — | — | Requires `Idempotency-Key` |
| `PATCH /swaps/:id/respond` | PATIENT | — | ✓ target | — | — | See `docs/swap.md` |
| `PATCH /swaps/:id/cancel` | AUTH | — | ✓ requester | ✓ | ✓ | Patient must own request |
| `GET /notifications/vapid-public-key` | AUTH | — | ✓ | ✓ | ✓ | — |
| `GET /notifications` | AUTH | — | ✓ own | ✓ | ✓ | Latest 100 |
| `GET /notifications/preferences` | AUTH | — | ✓ | ✓ | ✓ | Staff see disabled flags |
| `PATCH /notifications/preferences` | PATIENT | — | ✓ | — | — | 403 for staff |
| `POST /notifications/push-subscribe` | PATIENT | — | ✓ | — | — | 201, enables push |
| `DELETE /notifications/push-subscribe` | AUTH | — | ✓ | ✓ no-op | ✓ no-op | Staff call is a no-op today |
| `PATCH /notifications/:id/read` | AUTH | — | ✓ own | ✓ | ✓ | Ownership checked |
| `PATCH /notifications/read-all` | AUTH | — | ✓ own | ✓ | ✓ | — |
| `POST /hardware/events` | PUBLIC | `HMAC` | `HMAC` | `HMAC` | `HMAC` | Signature substitutes for a token |
| `GET /hardware/events` | STAFF | — | — | ✓ | ✓ | `?room=OPD-1` |
| `GET /hardware/rooms` | STAFF | — | — | ✓ | ✓ | Live occupancy/watchdog status |
| `GET /hardware/rooms/:code/events` | STAFF | — | — | ✓ | ✓ | — |
| `POST /hardware/simulate` | STAFF | — | — | ✓ | ✓ | Demo shortcut, signs internally |
| `GET /analytics/overview` | STAFF | — | — | ✓ | ✓ | Read-only |
| `GET /analytics/doctors` | STAFF | — | — | ✓ | ✓ | Read-only |
| `GET /analytics/appointments.csv` | STAFF | — | — | ✓ | ✓ | Contains PII |
| `GET /admin/audit` | STAFF | — | — | ✓ | ✓ | Read-only audit log |
| `GET /admin/jobs` | STAFF | — | — | ✓ | ✓ | Read-only BullMQ overview |

## Guards

- `authenticate` (`middleware/auth.ts`) reads `Authorization: Bearer <token>`,
  verifies the access JWT and attaches
  `req.auth = { userId, role, patientId? }`. Invalid or missing tokens produce
  `401 UNAUTHORIZED`.
- `authorize(...roles)` is the role gate: no `req.auth` → 401, wrong role → 403.
  STAFF modules always pass `["ADMIN", "STAFF"]`; PATIENT modules pass
  `["PATIENT"]`.
- `requireSelf(param)` and service-level checks enforce ownership. Patients may
  only access their own appointments, queue entries, swaps, notifications, and
  preferences; staff/admin may access operational records as shown above.
- `optionalAuthenticate` exists for contexts where an invalid token should be
  ignored rather than rejected.
- The web app mirrors these rules: `/patient/**` requires `PATIENT`,
  `/admin/**` requires `ADMIN`/`STAFF`, with a redirect on forbidden navigation.

## Notes

- Patient sign-in is mock/unverified (`phoneVerified=false`) behind
  `PatientAuthProvider`. OTP is a stubbed upgrade path. See
  `docs/security.md` before using real patient data.
- The full table above is mirrored by the DB-free test
  `apps/api/test/rbac-matrix.test.ts`; it asserts exact role arrays for staff
  and patient endpoints and verifies that admin/analytics routes are
  `ADMIN|STAFF` only.
- `POST /hardware/events` has no role gate by design; authenticity is the HMAC
  signature over the canonical event payload, not a bearer token.
- Socket.IO rejects connections without a valid `auth.token`; `queue:joinDoctor`
  allows only `ADMIN|STAFF` into `doctor:{doctorId}` rooms. Socket events are
  advisory UI hints — REST remains authoritative. See `docs/security.md`.
- `DELETE /notifications/push-subscribe` is documented as AUTH, not PATIENT,
  because staff calls currently succeed as a no-op.
