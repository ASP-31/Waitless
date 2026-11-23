## Scope

<!-- What changed and why? Link the issue/phase where relevant. -->

## Phase checks

- [ ] Change is limited to Phase 1–10 scope (implementation, docs, or tests).
- [ ] Phase 11 work (RAG chatbot, multi-tenancy, OTP/SMS, other future ideas) is **untouched**.
- [ ] No unrelated refactors, generated files, secrets, or `.env` changes are included.

## Tests

<!-- Check what you actually ran; delete or explain anything not run. -->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm test:e2e` (if UI/flow changed; needs the environment below)
- [ ] `pnpm test:coverage`

## DB / E2E environment

- [ ] Used Postgres 16 + Redis 7 (`pnpm infra:up`), applied `pnpm db:deploy`, and seeded with `pnpm db:seed:demo` when queue/UI data was involved.
- [ ] E2E was run with a seeded database and running `pnpm dev` servers (API `:4000`, web `:5173`).
- [ ] If Docker was unavailable, note below which DB-backed/E2E checks could not run and how they will be verified.

<!-- Environment notes / skipped checks: -->

## Screenshots and demo

- [ ] UI changes include before/after screenshots or a short recording (reference paths under `docs/assets/`).
- [ ] Updated `docs/demo.md` if the 60-second walkthrough changed.
- [ ] Verified keyboard access, mobile layout, and no new reduced-motion regressions; see `docs/accessibility.md`.

<!-- Screenshot paths / demo notes: -->

## Additional context

<!-- Cross-links to docs/api.md, docs/security.md, docs/hardware/contract.md pointer, etc. -->
