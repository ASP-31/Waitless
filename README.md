# Waitless

Smart hospital appointment, queue and notification platform.

> **Status:** Phases 1–10 are implemented. Phase 11 (RAG chatbot, multi-tenancy, OTP/SMS, and other future ideas) is explicitly out of scope for v1 and intentionally untouched. See `waitless-implementation-plan.md` for the roadmap and acceptance criteria.

## Stack

| Layer | Tech |
| --- | --- |
| Web | React 19, Vite, TypeScript, Tailwind v4, shadcn-style components |
| API | Node 22, Express 5, TypeScript |
| Data | PostgreSQL 16, Prisma 6 |
| Realtime | Socket.IO |
| Jobs / cache | Redis 7, BullMQ |
| Notifications | In-app, browser Push (Web Push/VAPID); SMS/email are inert stubs |
| Hardware | MQTT (Mosquitto), HTTP fallback, NXP FRDM-MCXN236 firmware skeleton + simulator |

## Prerequisites

- Node.js 22.12+ (`node -v`)
- pnpm 10 via Corepack (`corepack enable pnpm`); if Corepack cannot write to the global Node folder, add `C:\Waitless\.pnpm-shim` to `PATH`
- Docker Desktop (for Postgres, Redis, Mosquitto)

## Quick start

```bash
pnpm install
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
pnpm infra:up                 # postgres + redis + mosquitto
pnpm db:generate              # generate Prisma Client
pnpm db:migrate               # apply migrations
pnpm db:seed:demo             # demo hospital data (mid-flow queue)
pnpm dev                      # api :4000, web :5173
```

`pnpm db:seed` runs the same idempotent fixture without the `--demo` flag; use
`pnpm db:seed:demo` for the documented mid-flow walkthrough below.

Verify:

- API health — <http://localhost:4000/api/v1/health>
- Web app — <http://localhost:5173>
- Demo admin login — `admin@waitless.local` / `Admin@12345` (override with `SEED_ADMIN_*`)

## Screenshots and 60-second demo

For the full guided walkthrough — sign in, move a patient through the queue,
show a swap, and exercise room sensors — see [docs/demo.md](docs/demo.md).

Reference screenshots (captures may not be checked in yet; paths are under
`docs/assets/` so they can be dropped in without changing links):

| Screen | Asset |
| --- | --- |
| Staff queue management | `docs/assets/admin-queue.png` |
| Patient queue status | `docs/assets/patient-queue-status.png` |
| Slot-swap request | `docs/assets/swap-request.png` |
| Room / wall display | `docs/assets/room-view.png` |

![Staff queue management](docs/assets/admin-queue.png)
![Patient queue status](docs/assets/patient-queue-status.png)

## Repository layout

```text
apps/api        Express + Prisma backend, BullMQ workers, Socket.IO
apps/web        React frontend (admin + patient flows)
packages/shared Shared enums, zod schemas, state machine, ETA/time helpers
hardware        NXP firmware skeleton, simulator, wiring/contract docs (canonical contract: hardware/docs/contract.md)
docs            API reference, security, RBAC, runbook, demo script, accessibility audit, hardware contract pointer
infra           Docker service configuration
```

## Common commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run API + web with hot reload |
| `pnpm build` | Build both apps |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | Quality gates (unit + DB-free tests) |
| `pnpm test:e2e` | Playwright browser E2E suite (needs running API/web, Postgres and Redis) |
| `pnpm test:coverage` | Vitest coverage run for workspace packages |
| `pnpm db:generate` | Regenerate Prisma Client after schema edits |
| `pnpm db:migrate` | Create/apply a dev migration |
| `pnpm db:deploy` | Apply checked-in migrations (CI/production) |
| `pnpm db:seed` / `pnpm db:seed:demo` | Seed demo data |
| `pnpm db:reset` | Drop, migrate, seed |
| `pnpm db:studio` | Prisma Studio |
| `pnpm infra:up` / `pnpm infra:down` | Start/stop local containers |

`pnpm test:e2e` (Playwright) and `pnpm test:coverage` (Vitest) are the Phase 10
browser-E2E and coverage entry points. They need a seeded Postgres/Redis stack
and, for E2E, running `pnpm dev` servers (API `:4000`, web `:5173`). `pnpm test`
runs unit and DB-free suites; see `docs/dev-setup.md` for package-scoped commands
and CI coverage details.

## API notes

- Base path: `/api/v1`; all responses use `{ "data": ... }` or `{ "error": { code, message, details? } }`.
- Send `Idempotency-Key` on `POST /appointments` and `POST /swaps` to make client retries safe.
- `GET /admin/jobs` gives read-only BullMQ visibility; failed retries remain as dead letters in Redis.
- Full endpoint contracts are in `docs/api.md`; error codes in `docs/errors.md`.
- Room sensor topics, HMAC signing, and the credentialed MQTT simulator are specified in the canonical [`hardware/docs/contract.md`](hardware/docs/contract.md), with a pointer at `docs/hardware/contract.md`.
- Responsive/accessibility status is tracked in `docs/accessibility.md`.

## Troubleshooting

- **Docker engine not running** — start Docker Desktop and wait for the whale icon.
- **Port already in use** — set `POSTGRES_PORT` / `REDIS_PORT` in `.env` and update `DATABASE_URL` / `REDIS_URL`.
- **Prisma client missing** — run `pnpm db:generate`.
- **pnpm blocks build scripts** — packages are allow-listed in `pnpm-workspace.yaml` under `onlyBuiltDependencies`.
- **No local Docker** — unit tests and lint/typecheck/build still run; DB-backed integration/E2E require Postgres and Redis.
