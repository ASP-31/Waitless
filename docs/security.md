# Security notes

This is a practical checklist of what the API does today, plus the gaps that
must be closed before an internet-facing deployment. Source files are named so
the notes can be verified during review.

## Authentication and sessions

- Staff sign in with email or phone + password at `POST /auth/login`.
  Passwords are verified with Argon2 via `@node-rs/argon2`
  (`modules/auth/auth.service.ts`); seeded demo accounts use
  `Admin@12345` only in local development.
- Access tokens are JWTs signed with `JWT_ACCESS_SECRET`, default TTL `15m`,
  and carry `sub`, `role`, `patientId`, and a random `sid`
  (`utils/auth.ts`). They are sent as `Bearer <token>`.
- Refresh tokens are JWTs signed with a **different** `JWT_REFRESH_SECRET`,
  default TTL `7d`, and stored only as a SHA-256 hash in `RefreshToken`
  together with user agent and IP. Refresh rotates the token: the old row is
  revoked, a new one issued, and the httpOnly cookie replaced
  (`modules/auth/auth.service.ts`).
- The refresh cookie is `waitless_refresh`, `httpOnly`, `sameSite=lax`,
  `path=/api/v1`, and `secure` when `NODE_ENV=production`. There is no JS
  access to it.
- Logout revokes the current refresh row and clears the cookie. Access tokens
  are **not** server-revoked; they simply expire. Keep the access TTL short.
- Patients use `POST /patients/session` with name + phone. The current
  `MockPatientAuthProvider` issues a session without an OTP and stores
  `phoneVerified=false`. This is an explicit demo/product decision, not a
  production identity guarantee: anyone who knows a phone number can start
  that patient's session. The `SmsOtpPatientAuthProvider` is a stub; enable it
  before real patient data. See `docs/rbac.md`.
- Sign-in is rate limited: staff login 5/min keyed by IP + identifier, patient
  session 20/min keyed by IP + phone (`middleware/rate-limit.ts`).

## Transport, headers, and input

- Helmet is enabled with CSP disabled (the API serves JSON, not pages),
  `crossOriginResourcePolicy: cross-origin`, and `x-powered-by` removed
  (`app.ts`).
- CORS is an allowlist from comma-separated `WEB_ORIGIN` with `credentials:
  true`; Socket.IO uses the same allowlist (`app.ts`, `sockets/index.ts`).
  Do not set `WEB_ORIGIN=*`.
- JSON and URL-encoded bodies are capped at 1 MB.
- Every `body`/`query`/`params` object is parsed by a Zod schema via
  `validate()` before handlers run. Validation failures become
  `VALIDATION_FAILED` (422) with field paths (`middleware/validate.ts`).
- Requests get an `x-request-id` (incoming value accepted up to 128 chars,
  otherwise generated) and structured Pino logs. Health checks are excluded
  from access logging. See `docs/errors.md`.
- Rate limits are in-memory and per process: API 300/min, writes 120/min,
  hardware events 600/min, health exempt, all skipped in `NODE_ENV=test`.
  Terminate TLS at a proxy, keep `trust proxy=1` correct, and add distributed
  rate limiting at the edge for multi-instance deployments.

## Authorisation and data scope

- Roles are `ADMIN`, `STAFF`, `PATIENT`. `authenticate` verifies the bearer
  token; `authorize(...roles)` gates staff/patient modules; `requireSelf` and
  service-level checks constrain patients to their own appointments, queue
  entries, swaps, notifications, and preferences.
- Staff and admin share the same write permissions in v1. Admin/analytics
  endpoints are read-only oversight (`GET /admin/audit`, `/admin/jobs`,
  `/analytics/*`) and are `ADMIN|STAFF` only. `GET /analytics/appointments.csv`
  contains PII and must stay staff-only.
- Queue mutations, doctor/department/schedule management, QR generation,
  walk-ins, reschedules, hardware simulation, and hardware reads are
  `ADMIN|STAFF` only. Patients may call `POST /queue/entries/:id/check-in` for
  **their own** entry only.
- `DELETE /notifications/push-subscribe` is `AUTH` today. Staff calls succeed
  as a no-op; patient calls remove their own subscription.
- The full route/role contract is in `docs/rbac.md` and the DB-free table test
  `apps/api/test/rbac-matrix.test.ts`.

## Write safety and replay

- `POST /appointments` and `POST /swaps` **require** `Idempotency-Key` (or
  `X-Idempotency-Key`), 1–128 characters from `[A-Za-z0-9._:-]`.
- Redis records a 24-hour fingerprint of key + method + path + query + body +
  SHA-256 of the bearer token. Replaying the same request returns the cached
  response; a different body/token with the same key returns `CONFLICT`.
  Failures are never cached; an in-flight duplicate waits up to 10 seconds.
- Redis outages fail **open**: writes are not blocked, but replay protection is
  temporarily unavailable. BullMQ already requires Redis for durable jobs.
  See `middleware/idempotency.ts`.
- Appointment slots, token numbers, and queue positions are protected by
  database unique constraints and transactions; swap acceptance uses row locks
  in a stable order (see `docs/swap.md`).

## Device and MQTT security

- `POST /hardware/events` is deliberately unauthenticated at the HTTP layer;
  authenticity comes from an HMAC-SHA256 `sig` over exactly
  `{"v":1,"roomId":...,"type":...,"ts":...,"seq":...}` using
  `DEVICE_HMAC_SECRET`. Comparison uses `timingSafeEqual`
  (`modules/hardware/hardware.service.ts`, `hardware/docs/contract.md`).
- `ts` and `seq` are mandatory for signed events. Replays are deduped by
  `roomCode:seq:type` via a unique `DedupeKey`; a replay is `200` with
  `duplicate: true`, not an error.
- MQTT topics are `waitless/rooms/{room}/occupancy` and `.../heartbeat`. The
  gateway checks that the payload `roomId` matches the topic segment, forces
  heartbeat type from the topic, and drops unsigned or malformed messages with
  a warning (`integrations/mqtt.ts`). The gateway itself connects with
  `MQTT_USERNAME` / `MQTT_PASSWORD`.
- The local broker disables **anonymous access** and authenticates devices with
  a `password_file`; an `acl_file` gives each device only its own room. The
  write rule is `pattern write waitless/rooms/%u/occupancy` (the `%u` username
  is the room code), with a matching heartbeat rule. Do not re-enable anonymous
  access, even for local development.
- The bundled `hardware/simulator/publish.mjs` is a **signed** simulator: it
  builds the canonical five-key payload, HMACs it with `DEVICE_HMAC_SECRET`, and
  connects using per-device credentials (`DEVICE_MQTT_USERNAME` /
  `DEVICE_MQTT_PASSWORD`, or `--username` / `--password`; legacy room-code
  `MQTT_USERNAME` values are still accepted). `MQTT_USERNAME` /
  `MQTT_PASSWORD` are reserved for the API gateway subscriber. A signature
  mismatch, wrong credentials, or an ACL denial results in the event being
  logged and dropped. The staff-only
  `POST /hardware/simulate` remains the simplest demo fallback because it signs
  internally. Full recipe: [`hardware/docs/contract.md`](../hardware/docs/contract.md)
  (pointer: `docs/hardware/contract.md`).
- Sensors are advisory: they never identify a patient or create a
  consultation. `VACANT` only suggests an end time; `HARDWARE_AUTO_COMPLETE`
  defaults to `false` and staff confirmation remains authoritative.
- Room health (`ONLINE`/`DEGRADED`) is visible at `GET /hardware/rooms`.

## Notifications

- In-app notifications are always available and emit `notification:new` to the
  patient/user socket room. Web push is optional and requires both VAPID keys
  and a stored subscription; delivery failures are logged and never fail the
  originating request (`modules/notifications/notification.channels.ts`).
- `SMS` and `EMAIL` adapters are inert stubs in v1. `SMS_PROVIDER=mock` does
  not send real messages.
- Notification rows use `dedupeKey` uniqueness to prevent duplicate alerts on
  retries.

## Realtime

- Socket.IO **rejects unauthenticated connections**: a valid access token must
  be supplied as `auth.token` in the handshake, otherwise the connection is
  refused with `UNAUTHORIZED` (`sockets/index.ts`). Expired/invalid tokens are
  rejected the same way.
- A valid token joins `patient:{patientId}`, `user:{userId}`, and (for
  `ADMIN|STAFF`) the staff-only `admin:queue` room.
- `queue:joinDoctor` is staff-only: `ADMIN|STAFF` may join
  `doctor:{doctorId}` rooms; patient connections are ignored. Doctor rooms carry
  queue internals, so keep this check in place. Treat all socket payloads as
  advisory UI hints; the REST API and database remain authoritative.
- Use the same `WEB_ORIGIN` allowlist for Socket.IO and HTTP, and terminate
  WebSockets through the TLS proxy.
- See `docs/api.md` for the event names and `docs/rbac.md` for the route/role
  matrix.

## Testing and CI coverage

- CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests and builds,
  plus a separate Postgres + Redis integration job that applies migrations and
  runs the API test suite. The RBAC matrix test is DB-free; concurrency and
  DB-backed integration tests need Postgres (see `docs/swap.md`).
- Browser E2E and coverage are Phase 10 tooling entry points: `pnpm test:e2e`
  (Playwright, requires a seeded DB/Redis and running `pnpm dev` servers) and
  `pnpm test:coverage` (Vitest across the workspaces). `pnpm test` runs unit and
  DB-free suites — see `docs/dev-setup.md`.
- Green CI is a regression signal, not a security audit or a production-readiness
  claim. Manual checks and the pre-production gaps below still apply.

## Secrets and operations

- One root `.env` is loaded by `with-env.mjs` and `config/env.ts`. Never commit
  it; `.env.example` contains placeholders only.
- Boot fails fast when `DATABASE_URL`, `JWT_ACCESS_SECRET`, or
  `JWT_REFRESH_SECRET` are missing/too short. Rotate JWT secrets, QR signing
  secret (`QR_SIGNING_SECRET`), device HMAC secret (`DEVICE_HMAC_SECRET`),
  per-device MQTT passwords, VAPID keys, and seed passwords separately. Rotating
  the device secret requires re-signing/reflashing devices and updating the
  simulator's `--secret`; rotating JWT refresh secret invalidates all sessions.
- `NODE_ENV=production` enables `secure` cookies and suppresses raw error
  details. Set `LOG_LEVEL` appropriately; logs are structured JSON.
- Audit rows (`AuditLog`) record appointment/queue/swap/doctor/department/
  schedule actions with actor, before/after data, and IP. Read them through
  the staff-only `GET /admin/audit`. See `docs/runbook.md`.

## Pre-production gaps

1. Enable a real OTP/phone-verification provider; the mock provider is unsafe
   for real patients (SMS/email adapters are inert stubs today — see
   `docs/api.md`).
2. Add distributed rate limiting and a reverse-proxy WAF/TLS policy.
3. Replace all `*-change-me-*`, `dev-*`, per-device MQTT passwords, and seed
   credentials in `.env` and broker files.
4. Confirm audit retention and PII handling for the CSV export and logs.
5. Expand browser E2E/coverage to all critical journeys; CI is not a production
   certification.

Socket authentication and the staff-only `queue:joinDoctor` check are in place;
MQTT no longer permits anonymous access. Quiet hours (future scope) would only
suppress outbound notifications, not booking or queue progression — changing
that policy is out of scope. Responsive/accessibility status is tracked
in `docs/accessibility.md`.
