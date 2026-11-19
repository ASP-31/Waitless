# Waitless

Smart hospital appointment, queue and notification platform.

> Status: v1 complete. See `waitless-implementation-plan.md` for the roadmap, phase status and change log.

## Stack

| Layer | Tech |
| --- | --- |
| Web | React 19, Vite, TypeScript, Tailwind v4, shadcn/ui |
| API | Node 22, Express 5, TypeScript |
| Data | PostgreSQL 16, Prisma 6 |
| Realtime | Socket.IO |
| Jobs | Redis 7, BullMQ-compatible scheduler |
| Hardware | MQTT (Mosquitto), NXP FRDM-MCXN236 |

## Prerequisites

- Node.js 22.12+ (`node -v`)
- pnpm 10 (`npm i -g pnpm@10`)
- Docker Desktop (for Postgres, Redis, Mosquitto)

## Quick start

```bash
pnpm install
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
pnpm infra:up                 # postgres + redis + mosquitto
pnpm db:migrate               # create schema
pnpm db:seed                  # demo hospital data
pnpm dev                      # api :4000, web :5173
```

Verify:

- API health — <http://localhost:4000/api/v1/health>
- Web app — <http://localhost:5173>

Seeded staff accounts:

- Admin — `admin@waitless.local` / `Admin@12345`
- Front desk — `frontdesk@waitless.local` / `Admin@12345`

## Repository layout

```
apps/api        Express + Prisma backend
apps/web        React frontend
packages/shared Shared enums, zod schemas, pure domain logic
hardware        NXP firmware notes, simulator, wiring docs
docs            ADRs, API/RBAC/state-machine/runbook docs
infra           Docker service configuration
```

## Common commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run API + web with hot reload |
| `pnpm build` | Build both apps |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | Quality gates |
| `pnpm db:migrate` | Create/apply a dev migration |
| `pnpm db:seed` | Seed demo data |
| `pnpm db:reset` | Drop, migrate, seed |
| `pnpm db:studio` | Prisma Studio |
| `pnpm infra:down` | Stop containers (keeps volumes) |

## What is implemented

- Staff credential auth (Argon2id, rotating refresh cookie, rate limits) and patient name + mobile sessions.
- Department, doctor, room and weekly schedule management with availability generation.
- Remote/QR booking, walk-ins, per-doctor daily tokens and cancellation/reschedule.
- Queue call/start/complete/skip/requeue, ETA recalculation and a database-driven grace/delay/auto-skip scheduler.
- Socket.IO queue/appointment/notification updates and an in-app notification centre.
- Appointment swaps with same-day/same-doctor rules, expiry, consent and atomic exchange.
- MQTT + HTTP hardware ingest with room association hints and an admin hardware view.
- Admin analytics, CSV export and audit log visibility.
- Hardware simulator: `node hardware/simulator/publish.mjs --room OPD-1 --pattern in-out`.

## Troubleshooting

- **`docker` engine not running** — start Docker Desktop and wait for the whale icon.
- **Port already in use** — set `POSTGRES_PORT` / `REDIS_PORT` in `.env` and update `DATABASE_URL` / `REDIS_URL`.
- **Prisma client missing** — run `pnpm db:generate`.
- **pnpm blocks build scripts** — packages are allow-listed in `pnpm-workspace.yaml` under `onlyBuiltDependencies`.
- **Migration drift after pulling** — run `pnpm db:migrate`; the slot uniqueness index is a partial index created by migration SQL.
