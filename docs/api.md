# API reference

Base URL: `http://localhost:4000/api/v1`. All timestamps are ISO-8601 UTC;
hospital-local day keys are `YYYY-MM-DD` in `HOSPITAL_TIMEZONE` (default
`Asia/Kolkata`). The client never sets a status — it posts an **action** and the
server validates it with the shared state machine.

## Conventions

- **Success envelope:** JSON responses are `{ "data": <payload> }`. `204` responses have no body. `GET /health*` are the exception (plain objects); the CSV export streams `text/csv`.
- **Error envelope:** `{ "error": { "code", "message", "details?", "requestId?" } }`. Codes are stable strings, never localised; see `docs/errors.md`.
- **Auth:** `Authorization: Bearer <accessToken>` (15 min). Refresh token is the httpOnly cookie `waitless_refresh` (7 days, path `/api/v1`). Roles: `ADMIN`, `STAFF`, `PATIENT`.
- **Idempotency:** `POST /api/v1/appointments` and `POST /api/v1/swaps` **require** `Idempotency-Key: <1–128 chars from [A-Za-z0-9._:-]>`. Replaying the same key + body + caller within 24 h returns the cached response; reusing a key with a different body returns `409 CONFLICT`.
- **Pagination:** most list payloads use `{ items | <plural>, pagination: { page, pageSize, total, totalPages } }`.
- **Request IDs:** `x-request-id` is echoed on every response; include it in bug reports.

Auth shorthand in the tables: **public** = no bearer, **any** = any authenticated role, **staff** = `ADMIN|STAFF`, **patient** = `PATIENT` only, **device** = HMAC-signed payload (see `docs/security.md`).

## Health

| Method / path | Auth | Request | Response `data` / body |
|---|---|---|---|
| `GET /health` | public | — | `{ status, service, version, environment, uptimeSeconds, timestamp }` (plain object, 200) |
| `GET /health/ready` | public | — | `{ status: "ready"\|"degraded", checks: { db, redis }, timestamp }`; `503` when either dependency is down |

## Auth (`/auth`)

| Method / path | Auth | Request body | Response `data` |
|---|---|---|---|
| `POST /login` | public | `{ identifier, password }` (email or phone) | `{ accessToken, user }`; sets refresh cookie. `401 INVALID_CREDENTIALS` / `403 ACCOUNT_DISABLED` / `429 RATE_LIMITED` |
| `POST /refresh` | public + cookie | — | New `{ accessToken, user }`, rotates cookie and revokes the old refresh hash |
| `POST /logout` | public + cookie | — | `204`; revokes the refresh row and clears the cookie |
| `GET /me` | any | — | `{ user: { id, role, name, email, phone, isActive, patient?, adminProfile? } }` |

## Patients (`/patients`)

| Method / path | Auth | Request | Response `data` |
|---|---|---|---|
| `POST /session` | public | `{ fullName, phone }` (10-digit IN mobile, spaces/dashes/+91/0-prefix accepted) | `{ accessToken, profile, verification: { phoneVerified, method: "mock" } }`, `201`; sets refresh cookie. Same phone always resolves to the same patient |
| `GET /me` | patient | — | `{ profile: { id, fullName, phone, email, phoneVerified } }` |
| `PATCH /me` | patient | `{ fullName?, email? }` (at least one; phone changes are not supported) | `{ profile }` |
| `GET /` | staff | `?q=&page=&pageSize=` | `{ patients: Patient[], pagination }` |

## Departments (`/departments`)

| Method / path | Auth | Request | Response `data` |
|---|---|---|---|
| `GET /` | public | `?active=true\|false&includeInactive=true&q=` | `{ departments: Department[] }` (active only by default) |
| `GET /:id` | public | — | `{ department }` |
| `POST /` | staff | `{ name, code, description?, location? }` | `{ department }`, `201` |
| `PATCH /:id` | staff | any create field + `isActive?` | `{ department }` |
| `DELETE /:id` | staff | — | `{ department }` with `isActive=false` (soft delete; blocked by active appointments) |

## Doctors, schedules and availability (`/doctors`)

| Method / path | Auth | Request | Response `data` |
|---|---|---|---|
| `GET /` | public | `?departmentId=&q=&date=YYYY-MM-DD&active=true&includeInactive=true&page=&pageSize=` | `{ doctors, pagination }`; with `date`, entries include `isOnDuty`, `queueLength`, `nextAvailableSlot` |
| `GET /:id` | public | — | `{ doctor }` |
| `GET /:id/availability` | public | `?date=YYYY-MM-DD` (required) | `{ date, doctor?, slots: [{ start, end, label, rangeLabel, isBooked, isPast }], isOnDuty, exception? }` |
| `GET /:id/schedules` | public | — | `{ schedules: DoctorSchedule[] }` |
| `POST /:id/schedules` | staff | `{ dayOfWeek, startMinute, endMinute, slotMinutes?, isActive? }` (minutes 0–1439, 0=Sunday) | `{ schedule }`, `201`; overlapping windows are rejected |
| `PATCH /:id/schedules/:scheduleId` | staff | partial schedule fields | `{ schedule }` |
| `DELETE /:id/schedules/:scheduleId` | staff | — | `{ ok: true }`-style result |
| `GET /:id/exceptions` | public | — | `{ exceptions: ScheduleException[] }` |
| `PUT /:id/exceptions` | staff | `{ date, isClosed, startMinute?, endMinute?, note? }` (times required when `isClosed=false`) | `{ exception }` |
| `DELETE /:id/exceptions/:exceptionId` | staff | — | deletion result |
| `POST /` | staff | `{ departmentId, fullName, designation, avgConsultMinutes?, roomId?, isActive? }` | `{ doctor }`, `201`; duplicate `roomId` → `409` |
| `PATCH /:id` | staff | partial doctor fields | `{ doctor }` |
| `DELETE /:id` | staff | — | `{ doctor }` with `isActive=false` |

## Appointments (`/appointments`)

| Method / path | Auth | Request | Response `data` |
|---|---|---|---|
| `POST /` | patient + idempotency key | `{ doctorId, slotStart, notes?, source?: "QR"\|"REMOTE" }` | `{ appointment }`, `201`; allocates token per doctor/day, writes `BOOKING_CONFIRMED` notification and 30-min reminder |
| `POST /walk-in` | staff | `{ doctorId, slotStart, patient: { fullName, phone }, notes? }` | `{ appointment }`, `201`; `source=WALK_IN`, finds-or-creates patient, audit logged |
| `GET /` | any | `?date=&doctorId=&patientId=&status=&q=&page=&pageSize=` | `{ appointments, pagination }`; patients are forced to their own records |
| `GET /:id` | any | — | `{ appointment }` with doctor/department/room/patient/queueEntry; patients get `403` for others' records |
| `PATCH /:id/cancel` | any (owner or staff) | `{ reason? }` | `{ appointment }` with `CANCELLED`; allowed from `BOOKED\|WAITING\|NOTIFIED\|DELAYED`, frees slot and queue entry |
| `PATCH /:id/reschedule` | staff | `{ slotStart, reason? }` | `{ appointment }` at the new slot |

## Queue (`/queue`)

| Method / path | Auth | Request | Response `data` |
|---|---|---|---|
| `GET /:doctorId` | any | `?date=YYYY-MM-DD` (default today) | `{ doctor, date, entries, currentPatient, stats }`; entries carry `position`, `estimatedWaitMinutes`, `etaRange {min,max}`; stats `{ waiting, called, inConsultation, completed, skipped, avgConsultMinutes, patientsAhead, estimatedWaitMinutes }`. Missing day entries are created on first read |
| `PATCH /entries/:id/call` | staff | — | `{ entry }` → `CALLED`, sets `calledAt`/`graceDeadlineAt`, enqueues grace job |
| `PATCH /entries/:id/start` | staff | — | `{ entry }` → `IN_CONSULTATION`, opens `Consultation`, cancels grace jobs |
| `PATCH /entries/:id/complete` | staff | — | `{ entry }` → `COMPLETED`, records duration + `endSource=STAFF` |
| `PATCH /entries/:id/skip` | staff | `{ reason? }` | `{ entry }` → `SKIPPED`; with `SKIP_POLICY=drop` the entry is removed after the transaction |
| `PATCH /entries/:id/arrive` | staff | — | `{ entry }`: requeues `SKIPPED`/`WAITING` to the tail, otherwise calls the patient and restarts grace |
| `PATCH /entries/:id/reorder` | staff | `{ position: number > 0 }` | `{ entry }`; positions recomputed 1..n and audit logged |
| `PATCH /entries/:id/no-show` | staff | — | `{ entry }` → appointment `NO_SHOW` (queue entry marked skipped) |
| `POST /entries/:id/check-in` | patient (owner) | — | `{ entry }`; "I'm here" once per appointment, clears grace; `DELAYED → CALLED`, `BOOKED → WAITING` |

Every mutation is state-machine guarded, wrapped in a transaction that writes `AuditLog`, recalculates ETAs, and emits `queue:updated` / `appointment:updated` over Socket.IO.

## QR (`/qr`)

| Method / path | Auth | Request | Response `data` |
|---|---|---|---|
| `GET /hospital` | staff | — | `{ payload: { v, hid, ts, sig }, token, scanUrl, qrDataUrl }`; HMAC signed with `QR_SIGNING_SECRET` |
| `POST /verify` | public | `{ token }` | `{ valid: true, payload, hid }`; `400 BAD_REQUEST` for malformed, tampered or >24 h old tokens |

## Swaps (`/swaps`)

| Method / path | Auth | Request | Response `data` |
|---|---|---|---|
| `GET /` | any | `?role=incoming\|outgoing\|all` | `{ swaps }`; staff see the full recent list, patients only their own |
| `POST /eligible` | patient | `{ appointmentId }` | `{ eligible: [{ appointmentId, tokenNumber, slotStart, patientInitials }] }` — no full names/phones |
| `POST /` | patient + idempotency key | `{ requesterAppointmentId, targetAppointmentId, message? }` | `{ swap }`, `201`; one pending per appointment, 10-min expiry |
| `PATCH /:id/respond` | patient (target) | `{ action: "ACCEPT"\|"REJECT" }` | `{ swap }`; `ACCEPT` exchanges slots/tokens/positions in one transaction |
| `PATCH /:id/cancel` | any (requester or staff) | — | `{ swap }` with `CANCELLED` |

See `docs/swap.md` for the full rule table.

## Notifications (`/notifications`)

| Method / path | Auth | Request | Response `data` |
|---|---|---|---|
| `GET /vapid-public-key` | any | — | `{ publicKey: string \| null }` |
| `GET /` | any | — | `{ notifications: Notification[], unread: number }` (latest 100, own records only) |
| `GET /preferences` | any | — | `{ inAppEnabled: true, pushEnabled, smsEnabled, emailEnabled, subscriptions: string[] }`; staff get disabled flags |
| `PATCH /preferences` | patient | `{ pushEnabled?, smsEnabled?, emailEnabled? }` | `{ preferences }`; `403` for staff |
| `POST /push-subscribe` | patient | `{ endpoint, keys: { p256dh, auth } }` | `{ ok: true }`, `201`; also enables push |
| `DELETE /push-subscribe` | any | `{ endpoint }` | `{ ok: true }`; no-op for staff |
| `PATCH /:id/read` | any (owner/staff) | — | `{ notification }` with `readAt` |
| `PATCH /read-all` | any | — | `{ ok: true }` |

Notification types: `BOOKING_CONFIRMED`, `READY_30_MIN`, `NEXT_IN_QUEUE`, `DELAY_WARNING`, `SKIPPED`, `QUEUE_UPDATED`, `SWAP_REQUESTED`, `SWAP_ACCEPTED`, `SWAP_REJECTED`, `SWAP_EXPIRED`, `APPOINTMENT_CANCELLED`. Channels: `IN_APP` (always available) and `WEB_PUSH` (only when the patient has a subscription); `SMS`/`EMAIL` are inert stubs.

## Hardware (`/hardware`)

| Method / path | Auth | Request | Response `data` |
|---|---|---|---|
| `POST /events` | device (HMAC) | `{ v?, roomId, type: "OCCUPIED"\|"VACANT"\|"HEARTBEAT", ts, seq, sig, payload? }` | `{ event, duplicate }`; `201` new, `200` replay, `401 UNAUTHORIZED` for a bad/missing signature, `404 NOT_FOUND` for an unknown room |
| `GET /events` | staff | `?room=OPD-1` | `{ events }` (recent) |
| `GET /rooms` | staff | — | `{ rooms }` with assigned doctor, `status` (`ONLINE`/`DEGRADED`), last event, and last heartbeat |
| `GET /rooms/:code/events` | staff | — | `{ events }` for one room |
| `POST /simulate` | staff | `{ roomId, type?, ts?, seq?, payload? }` | `{ event, duplicate }`; staff-only demo shortcut that signs the event internally |

Occupancy is advisory only: it never creates a consultation. A `VACANT` event
sets `suggestedEndAt`; completion requires staff confirmation unless
`HARDWARE_AUTO_COMPLETE=true`. See the canonical
[`hardware/docs/contract.md`](../hardware/docs/contract.md) and
`docs/errors.md` for the declared-but-unused hardware error codes.

## Analytics (`/analytics`)

All endpoints are staff/admin-only and accept inclusive hospital-local day keys `?from=YYYY-MM-DD&to=YYYY-MM-DD` (defaults: today). `from > to` → `400 BAD_REQUEST`.

| Method / path | Auth | Request | Response `data` |
|---|---|---|---|
| `GET /overview` | staff | range above | `{ totals: { appointments, completed, cancelled, noShow, noShowRate }, avgWaitMinutes, avgConsultMinutes, peakHours: [{ hour, count }], generatedAt }` |
| `GET /doctors` | staff | range above | `DoctorAnalyticsRow[]` (`doctorId, name, designation, department, appointments, completed, skipped, noShows, avgConsultMinutes, throughputPerDay`) |
| `GET /appointments.csv` | staff | range above | `text/csv` with header + quoted cells: `id, serviceDay, tokenNumber, patientName, phone, doctor, department, status, slotStart, source` (includes PII — staff export only) |

## Admin (`/admin`)

Read-only oversight endpoints, staff/admin-only.

| Method / path | Auth | Request | Response `data` |
|---|---|---|---|
| `GET /audit` | staff | `?entity=&action=&actorUserId=&from=&to=&page=&pageSize=` | `{ items: [{ id, actorUserId, actorName, action, entity, entityId, before, after, ip, createdAt }], meta: { page, pageSize, total, totalPages }, filters }` |
| `GET /jobs` | staff | — | `{ queues: [{ name, available, counts: { waiting, active, completed, failed, delayed }, failedJobs: [{ id, name, failedReason, timestamp }] }], generatedAt }`. One unreachable queue is reported as `available: false`, not a 5xx |

Queue names: `waitless-notifications`, `waitless-queue`, `waitless-swaps`, `waitless-maintenance`, `waitless-hardware`.

## Realtime events

Socket.IO at `/socket.io` with `auth: { token }` (access token). Connections
without a valid token are rejected. Rooms: `patient:{patientId}`,
`user:{userId}`, `admin:queue` (staff only), `doctor:{doctorId}` (joined via
`queue:joinDoctor`, also staff only). Events emitted by the server:
`queue:updated`, `queue:called`, `appointment:updated`, `notification:new`,
`swap:requested`, `swap:responded`, `hardware:occupancy`, `server:hello`.
Socket events are advisory UI hints; REST remains authoritative. See
`docs/security.md`.
