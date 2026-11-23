# Developer setup

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | `>=22.12.0` | `node --version` |
| pnpm | `10.20.0` | Managed by Corepack (`packageManager` field) |
| Docker + Compose | current | Provides PostgreSQL 16, Redis 7, Mosquitto |
| Git | current | Repo checkout |

Enable Corepack once:

```bash
corepack enable
corepack prepare pnpm@10.20.0 --activate
```

## First run

PowerShell (Windows):

```powershell
cd C:\Waitless
Copy-Item .env.example .env
corepack enable
pnpm install --frozen-lockfile
pnpm infra:up
pnpm db:generate
pnpm db:deploy
pnpm db:seed
pnpm dev
```

POSIX (macOS/Linux):

```bash
cd /path/to/Waitless
cp .env.example .env
corepack enable
pnpm install --frozen-lockfile
pnpm infra:up
pnpm db:generate
pnpm db:deploy
pnpm db:seed
pnpm dev
```

`pnpm dev` runs both workspaces via Turbo:

- API: <http://localhost:4000/api/v1> (health at `/health`, `/health/ready`)
- Web: <http://localhost:5173> (Vite proxies `/api` and `/socket.io` to 4000)

Infra ports: Postgres `5432`, Redis `6379`, MQTT `1883`, MQTT-over-WebSocket
`9001`. Use `pnpm infra:status` and `pnpm infra:logs` to inspect containers.

## Environment

There is exactly one `.env` at the repository root. `apps/api/scripts/with-env.mjs`
loads it for every `db:*` script, and `config/env.ts` also checks the API's
working directory and the root when the server starts. Do not duplicate `.env`
into `apps/api`.

Minimum required values (see `.env.example` for the full annotated list):

```dotenv
NODE_ENV=development
DATABASE_URL=postgresql://waitless:waitless@localhost:5432/waitless?schema=public
REDIS_URL=redis://localhost:6379
JWT_ACCESS_SECRET=<at least 16 chars, unique>
JWT_REFRESH_SECRET=<at least 16 chars, different from access>
WEB_ORIGIN=http://localhost:5173
HOSPITAL_TIMEZONE=Asia/Kolkata
```

Useful overrides:

| Variable group | Purpose |
|---|---|
| `PORT`, `API_BASE_URL`, `WEB_ORIGIN`, `LOG_LEVEL` | API networking and logs; `WEB_ORIGIN` accepts comma-separated origins |
| `TEST_DATABASE_URL` | Optional separate database for DB-backed API integration tests |
| `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `QR_SIGNING_SECRET` | Session and QR behaviour |
| `SEED_ADMIN_*` | Seeded staff identity/password |
| `GRACE_MINUTES`, `DELAY_MINUTES`, `AUTO_SKIP_ENABLED`, `SKIP_POLICY` | Queue timing policy |
| `SWAP_CUTOFF_MINUTES`, `SWAP_EXPIRY_MINUTES`, `READY_ALERT_MINUTES` | Swap and reminder windows |
| `SCHEDULE_HORIZON_DAYS`, `DEFAULT_CONSULT_MINUTES` | Booking/ETA defaults |
| `MQTT_*`, `DEVICE_HMAC_SECRET`, `HARDWARE_*`, `SENSOR_DEBOUNCE_SECONDS` | Optional device integration |
| `VAPID_*`, `FCM_*`, `SMS_PROVIDER` | Optional push/SMS adapters |

Boot fails fast with a list of invalid variables instead of starting with a
half-configured server. Never commit `.env`; rotate any value copied from
`.env.example` before sharing a deployment. See `docs/security.md`.

## Common commands

```bash
pnpm install                 # install workspace dependencies
pnpm dev                     # API + web in watch mode
pnpm build                   # production builds
pnpm lint                    # ESLint across workspaces
pnpm typecheck               # tsc --noEmit across workspaces
pnpm test                    # all package test scripts
pnpm test:coverage           # Vitest coverage across workspaces
pnpm test:e2e                # Playwright browser E2E (seeded DB + running dev servers)
pnpm format                  # Prettier write
pnpm format:check            # Prettier check
```

Package-scoped tests used during documentation work:

```bash
pnpm --filter @waitless/shared test   # pure unit tests (ETA, state machine, time, slots)
pnpm --filter @waitless/api test      # phone, enum drift, RBAC matrix; no DB required
```

The API test script runs through `with-env.mjs` so `.env` is available, but the
DB-free unit tests do not open a database. DB-backed concurrency tests require
Postgres and are documented in `docs/swap.md`.

## Database scripts

```bash
pnpm db:generate                     # Prisma client after schema edits
pnpm db:migrate --name add_something  # dev migration + client
pnpm db:deploy                       # apply pending migrations in CI/prod
pnpm db:push                         # quick prototype sync (no migration file)
pnpm db:seed                         # idempotent demo fixture
pnpm db:seed:demo                    # same seed with --demo flag
pnpm db:reset                        # LOCAL ONLY: drop/migrate/seed
pnpm db:studio                       # Prisma Studio
pnpm db:ping                         # check Postgres + Redis
```

Because Prisma only finds `.env` in its own working directory, always use the
root scripts rather than calling `prisma` from `apps/api`. The Prisma schema is
`apps/api/prisma/schema.prisma`; enums are mirrored in
`packages/shared/src/enums.ts` and checked by `apps/api/test/enum-drift.test.ts`.

## Repository layout

| Path | Contents |
|---|---|
| `apps/api/src/modules/` | Auth, patients, departments, doctors, appointments, queue, QR, swaps, notifications, hardware, analytics, admin |
| `apps/api/src/jobs/` | BullMQ queues, workers, repeating maintenance jobs |
| `apps/api/prisma/` | Schema, migrations, seed |
| `apps/api/test/` | API unit tests |
| `apps/web/src/` | Patient, staff/admin, and shared UI |
| `packages/shared/src/` | Enums, ETA, state machine, time/day helpers, errors |
| `docs/` | API, errors, security, runbook, demo, RBAC, state machine, DB, swap, accessibility docs; `docs/hardware/contract.md` points to the canonical contract |
| `hardware/` | Canonical device contract (`hardware/docs/contract.md`), wiring notes, signed simulator, firmware skeleton |

## Quality gates

CI (`.github/workflows/ci.yml`) runs:

1. `pnpm install --frozen-lockfile`
2. `cp .env.example .env`
3. `pnpm --filter @waitless/api db:generate`
4. `turbo run lint typecheck test build`

A separate integration job starts Postgres and Redis, deploys migrations, and
runs the API tests. Run the equivalent locally before opening a PR:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

Browser E2E and coverage are the Phase 10 tooling entry points: `pnpm test:e2e`
(Playwright; needs Postgres, Redis, a seeded database, and running `pnpm dev`
servers) and `pnpm test:coverage` (Vitest across the workspaces, with HTML and
JSON summaries). `pnpm test` runs unit and DB-free suites; CI's current gates are
the guaranteed baseline. See `docs/security.md`.

## First-run troubleshooting

| Problem | Fix |
|---|---|
| `corepack: command not found` | Install Node 22+ with Corepack included, or install pnpm 10.20.0 globally |
| `pnpm install` fails on lockfile | Use `pnpm install --frozen-lockfile`; if you changed deps intentionally, update the lockfile and commit it |
| `db:deploy` cannot connect | `pnpm infra:up`, then `pnpm db:ping`; check `DATABASE_URL` |
| Prisma client out of date | `pnpm db:generate` |
| Empty queue on first login | `pnpm db:seed`; verify the printed demo day and pass `?date=` if needed |
| Web can't reach API | Ensure API is on 4000 and Vite on 5173; check `WEB_ORIGIN` and proxy config |
| MQTT simulator events ignored | Wrong/missing per-device credentials, an ACL denial, or an HMAC secret mismatch — pass `--username`/`--password` (or set `MQTT_*`) and the matching `DEVICE_HMAC_SECRET`; the simplest fallback is `POST /hardware/simulate`. See `hardware/docs/contract.md` |

After setup, follow `docs/demo.md` for a guided walkthrough and `docs/runbook.md`
for health checks and recovery.
