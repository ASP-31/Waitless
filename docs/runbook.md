# Runbook

For day-one setup see `docs/dev-setup.md`; this file covers operating a running
Waitless stack, verifying health, recovering from common failures, and backup
basics.

## Components

| Component | Default | Purpose |
|---|---|---|
| API | `http://localhost:4000/api/v1` | Express + Socket.IO, BullMQ producers/workers |
| Web | `http://localhost:5173` | Vite dev server; proxies `/api` and `/socket.io` to the API |
| PostgreSQL 16 | `localhost:5432` | Prisma data, audit log, queue state |
| Redis 7 | `localhost:6379` | BullMQ jobs, idempotency records, rate-limit counters |
| Mosquitto | `localhost:1883` (WS `9001`) | Optional device telemetry (anonymous access disabled) |

Device topic, HMAC, and per-device credential details live in the canonical
[`hardware/docs/contract.md`](../hardware/docs/contract.md); `docs/hardware/contract.md`
is a pointer. See `docs/security.md` for the broker ACL model.

## Daily start / stop

```bash
pnpm infra:up          # docker compose up -d
pnpm db:ping           # {"db":"up","redis":"up"}
pnpm db:deploy         # apply pending migrations
pnpm dev               # API + web (turbo)
```

Stop with `pnpm infra:down` (keeps Docker volumes) or `Ctrl+C` in the dev
process. `pnpm infra:logs` and `pnpm infra:status` are the usual diagnostics.

## Health checks

| Check | Expectation |
|---|---|
| `GET /api/v1/health` | 200 `{ status: "ok", service, version, environment, uptimeSeconds, timestamp }` |
| `GET /api/v1/health/ready` | 200 `{ status: "ready", checks: { db: "up", redis: "up" } }`; 503 if either is down |
| `pnpm db:ping` | JSON with both `db` and `redis` `up`; exits 1 otherwise |
| `GET /api/v1/admin/jobs` (staff token) | All queues `available: true`; failed counts visible |
| `GET /api/v1/analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD` | 200 with totals |

Use `/health/ready` as the deploy/readiness gate; a live HTTP process with a
dead dependency is not ready. Health endpoints are exempt from rate limits and
access logging.

## Database operations

Scripts live in the API package and load the single root `.env` through
`apps/api/scripts/with-env.mjs`. Do not invoke `prisma` directly from
`apps/api` or the client will read the wrong `.env`.

```bash
pnpm db:generate                    # regenerate Prisma client after schema edits
pnpm db:migrate --name add_something # dev: create + apply migration
pnpm db:deploy                      # CI/prod: apply pending migrations only
pnpm db:reset                       # LOCAL ONLY: drop, migrate, seed
pnpm db:studio                      # inspect data
```

Rules:

- Never edit an applied migration. Add a new one.
- `migrate dev` may offer to reset when a change is destructive; if you need to
  keep demo data, generate SQL with `prisma migrate diff` instead.
- `pnpm db:seed` is safe to rerun: structural rows are upserted, while
  `[seed]`-tagged demo appointments are deleted and recreated for the printed
  demo day. See `docs/demo.md`.
- The enum drift test (`apps/api/test/enum-drift.test.ts`) fails when
  `schema.prisma` and `packages/shared/src/enums.ts` diverge.

## Backup and restore

Use the same credentials as `DATABASE_URL`; never paste secrets into shell
history. Examples (POSIX shell):

```bash
pg_dump "$DATABASE_URL" --format=custom --file=waitless-$(date +%F).backup
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" waitless-YYYY-MM-DD.backup
```

PowerShell:

```powershell
pg_dump $env:DATABASE_URL --format=custom --file=waitless-backup.dump
pg_restore --clean --if-exists --no-owner --dbname=$env:DATABASE_URL waitless-backup.dump
```

Before a restore: stop the API/workers, take a fresh dump, verify the target
database, then apply migrations if the dump predates the current schema. After
restoring, restart the API so workers and repeating jobs are registered again.

Redis is not part of the Postgres backup. It holds BullMQ jobs, idempotency
records, and rate-limit counters; losing it is recoverable but disruptive (see
below).

## Redis flush implications

`FLUSHDB` or losing the Redis container **does not delete database rows**, but
it does lose:

- pending grace, auto-skip, swap-expiry, notification-dispatch, and hardware
  vacancy jobs;
- idempotency replay records (a retried create could no longer be deduped);
- rate-limit counters and ETA-notification lock keys;
- registered repeating jobs until the API restarts.

`DELAY_MINUTES`/`GRACE_MINUTES` deadlines are stored on `QueueEntry`, and the
nightly maintenance job still expires stale swaps and closes stale
consultations, but there is no general grace-deadline replay. Flush only during
a quiet period, then restart the API so `startWorkers()` re-registers the
`nightly` and `device-watchdog` repeatables. Verify with `/admin/jobs` and spot
check the queue screen.

## Background jobs

Workers start with the API (`server.ts`) and are not startup-critical: Redis
failures are logged and retried by BullMQ while HTTP health still serves.
Queues from `jobs/schedulers.ts`:

| Queue | Work |
|---|---|
| `waitless-notifications` | Dispatch scheduled in-app/web-push rows |
| `waitless-queue` | Grace expiry → `DELAYED`; auto-skip after delay → `SKIPPED` |
| `waitless-swaps` | Expire unanswered swap requests |
| `waitless-hardware` | Delayed vacancy re-check and optional auto-complete |
| `waitless-maintenance` | Nightly 02:00 hospital-local prep, stale cleanup; device watchdog every minute |

Failed jobs stay in Redis and are logged as dead letters; inspect them at
`GET /admin/jobs` (no payloads or stack traces are returned). Jobs use 3
attempts with exponential backoff.

## Common failures

| Symptom | Likely cause | Action |
|---|---|---|
| `Invalid environment configuration` on boot | Missing/short secrets or bad `.env` | Copy `.env.example`, fill required values, restart |
| `/health/ready` 503 with `db: down` | Postgres not up or wrong `DATABASE_URL` | `docker compose logs postgres`, `pnpm db:ping` |
| `/health/ready` 503 with `redis: down` | Redis not up | `docker compose logs redis`, `pnpm db:ping` |
| Prisma "client out of date" | Schema changed without generation | `pnpm db:generate` |
| Port 4000/5173 in use | Another dev process | Stop it or change `PORT` / Vite port |
| `429 RATE_LIMITED` | In-memory ceiling hit | Back off; check proxy IP config (`trust proxy=1`) |
| `409 INVALID_TRANSITION` on queue action | State changed under the operator | Refetch `GET /queue/:doctorId` |
| `409 CONFLICT` from idempotency key | Same key reused with different body/token | Generate a fresh key for a different request |
| Swap accept fails at cutoff/expiry | Slot within `SWAP_CUTOFF_MINUTES` or request past `SWAP_EXPIRY_MINUTES` | Recheck `docs/swap.md`; create a new request |
| Device events ignored | Missing HMAC/`ts`/`seq`, room mismatch, wrong/missing per-device MQTT credentials or ACL denial | Check `hardware/docs/contract.md`; verify simulator `--username`/`--password` and `DEVICE_HMAC_SECRET`, or use `/hardware/simulate` |
| Rooms stuck `DEGRADED` | No heartbeat for `DEVICE_WATCHDOG_MINUTES` | Restore device/MQTT; a heartbeat sets `ONLINE` |
| Web push never arrives | VAPID keys unset or no subscription | `GET /notifications/preferences`; set VAPID env vars |
| Realtime looks stale | Expired/missing socket token or missed room join | Reconnect with a valid `auth.token`; staff-only `queue:joinDoctor` is required for doctor rooms. Refetch REST state; see `docs/security.md` |

## Graceful shutdown

The API handles `SIGINT` and `SIGTERM`: it stops accepting connections, closes
Socket.IO, workers, queues, MQTT, Prisma, and Redis in that order. Anything
still open after 10 seconds is force-exited so container restarts do not hang.
Use `SIGTERM` from the orchestrator; avoid `kill -9` except as a last resort
because in-flight jobs may need BullMQ retries.

Incident logs are JSON via Pino. Search by `requestId` (also returned as
`x-request-id`) to follow one request across the API. For web push, device, and
job errors, warnings/errors are logged with the queue, topic, room, or job ID.
