# Appointment swaps

Two patients can exchange same-day, same-doctor appointments without staff
involvement. Swap execution is atomic and both sides are notified at every
step.

## Rules

| Rule | Enforcement |
|---|---|
| Same doctor and service day | `createSwapRequest` rejects mismatches |
| Both appointments in `BOOKED`, `WAITING` or `NOTIFIED` | checked on create and again inside the accept transaction |
| Not your own appointment | target patient must differ from requester |
| One pending swap per appointment | partial unique indexes `SwapRequest_pending_requester_unique` / `..._target_unique` plus an explicit count |
| Requester consent | creating the request is consent step 1 |
| Target consent | `PATCH /swaps/:id/respond { action: "ACCEPT" }` is step 2 |
| Cutoff | earlier slot must be at least `SWAP_CUTOFF_MINUTES` (default 60) away |
| Expiry | `SWAP_EXPIRY_MINUTES` (default 10); scheduler marks `EXPIRED` and notifies both |
| Slot rebooking | active-slot uniqueness is a partial index so cancelled rows free the slot |

## Execution

Accepting runs in one `prisma.$transaction`:

1. Re-read the swap with `PENDING` status and re-check eligibility/expiry.
2. Move both appointments to temporary unique slot/token values because the
   active unique indexes make a direct A↔B swap collide.
3. Write each appointment's final slot and token from the other row.
4. Recompute queue positions/ETAs for the doctor/day (order follows slot time).
5. Mark the swap `ACCEPTED`, append an audit row and notify both patients.

Rejecting, cancelling and expiry are terminal states. A pending swap never
changes either appointment until acceptance.

## API

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/swaps` | PATIENT | Create a request |
| `GET` | `/api/v1/swaps?role=incoming\|outgoing\|all` | any | List own/oversight swaps |
| `POST` | `/api/v1/swaps/eligible` | PATIENT | Same-doctor candidates (token, slot, initials only); filtered by the swap cutoff |
| `PATCH` | `/api/v1/swaps/:id/respond` | PATIENT target | `ACCEPT` or `REJECT` |
| `PATCH` | `/api/v1/swaps/:id/cancel` | requester/staff | Withdraw a pending request |

## UI

- `MyAppointments.tsx` → **Swap slot** → eligible list → send request.
- `SwapRequests.tsx` → incoming (accept/reject), sent (cancel), history.
- `Swaps.tsx` (admin) → oversight and forced cancellation.
