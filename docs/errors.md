# Errors

Every deliberate API failure uses one envelope:

```json
{
  "error": {
    "code": "SLOT_TAKEN",
    "message": "This slot was just taken",
    "details": { "field": "slotStart" },
    "requestId": "01J..."
  }
}
```

`code` is the stable machine-readable contract defined by `ERROR_CODES` in
`packages/shared/src/errors.ts`. Clients must branch on `code`, never on
`message`. `details` is optional and shape varies by error; `requestId`
mirrors the `x-request-id` response header.

Source of truth: `packages/shared/src/errors.ts` (`ERROR_CODES`,
`ERROR_STATUS`) and `apps/api/src/middleware/error-handler.ts`.

## Code catalogue

### Generic

| Code | HTTP | When | Client handling |
|---|---:|---|---|
| `BAD_REQUEST` | 400 | Malformed request, unsupported date range, invalid idempotency header, bad room/sign-in input | Fix the request; do not retry unchanged |
| `VALIDATION_FAILED` | 422 | Zod schema rejected `body`, `query`, or `params` | Show field errors from `details` |
| `UNAUTHORIZED` | 401 | Missing/invalid bearer token, bad refresh cookie, bad device signature | Refresh once, then re-authenticate; device events need a valid HMAC |
| `FORBIDDEN` | 403 | Valid identity, wrong role or failed ownership check | Do not retry; hide/disable the action |
| `NOT_FOUND` | 404 | Unknown route or resource | Check IDs; treat as terminal |
| `CONFLICT` | 409 | Generic optimistic-concurrency or uniqueness conflict | Refetch state and explain the change to the user |
| `RATE_LIMITED` | 429 | In-memory rate-limit ceiling hit | Back off; honour `Retry-After` / `RateLimit-*` headers |
| `INTERNAL` | 500 | Unhandled error | Log `requestId`; retry with exponential backoff only for idempotent reads |
| `NOT_IMPLEMENTED` | 501 | Explicit stub, e.g. SMS OTP provider | Treat as unavailable feature |

### Auth and identity

| Code | HTTP | When | Client handling |
|---|---:|---|---|
| `INVALID_CREDENTIALS` | 401 | Staff login with unknown/disabled-staff identifier or wrong password | Generic "invalid credentials" message; do not reveal which field was wrong |
| `TOKEN_EXPIRED` | 401 | Refresh token expired/revoked | Clear session and send the user to sign-in |
| `TOKEN_INVALID` | 401 | Refresh token malformed, unknown hash, or user mismatch | Clear session and re-authenticate |
| `ACCOUNT_DISABLED` | 403 | Staff account `isActive=false` | Show a support message; no retry |
| `INVALID_PHONE` | 422 | Phone normalisation rejected the value (`details.field = "phone"`) | Ask for a valid 10-digit Indian mobile number |

### Booking

| Code | HTTP | When | Client handling |
|---|---:|---|---|
| `SLOT_TAKEN` | 409 | Doctor/slot uniqueness conflict | Reload availability and pick another slot |
| `SLOT_PAST` | 422 | Slot is in the past in hospital-local time | Reload availability |
| `SLOT_NOT_IN_SCHEDULE` | 422 | No active schedule window covers the slot | Reload availability |
| `DOCTOR_UNAVAILABLE` | 409 | Doctor inactive, on leave, or room unavailable | Offer another doctor/day |
| `BOOKING_HORIZON_EXCEEDED` | 422 | Date beyond `SCHEDULE_HORIZON_DAYS` | Restrict date picker |

### Queue

| Code | HTTP | When | Client handling |
|---|---:|---|---|
| `INVALID_TRANSITION` | 409 | `assertTransition` rejected an action | Refetch the queue; the patient's state changed |
| `NOT_IN_QUEUE` | 404 | Queue entry missing for the requested action | Refetch the queue |
| `ALREADY_CALLED` | 409 | Duplicate call for an active entry | Refresh rather than re-calling |
| `GRACE_EXPIRED` | 409 | Call grace window already closed | Offer "arrive"/requeue flow |
| `QUEUE_EMPTY` | 404 | No eligible next patient | Show an empty-state message |

### Swaps

| Code | HTTP | When | Client handling |
|---|---:|---|---|
| `SWAP_NOT_ELIGIBLE` | 409 | Status, doctor/day, or cutoff rule failed | Refresh eligibility list |
| `SWAP_ALREADY_PENDING` | 409 | One of the appointments already has a pending request | Show the existing request; disable submit |
| `SWAP_EXPIRED` | 410 | `expiresAt` passed before response | Reload and propose again |
| `SWAP_SELF` | 422 | Declared for a self-swap (same requester and target appointment) | The service currently rejects self-swaps with generic `400 BAD_REQUEST` (`SWAP_SELF` is declared but unused); see `docs/swap.md` (`SW-20`) |

### Hardware

| Code | HTTP | When | Client handling |
|---|---:|---|---|
| `DUPLICATE_EVENT` | 200 | **Special case:** replay of a signed event | Not currently returned as an error body; the hardware router returns `200` with `{ data: { event: null, duplicate: true } }` |
| `INVALID_SIGNATURE` | 401 | Declared in the shared catalogue for signature failures | Current service raises `UNAUTHORIZED` instead; handle by code `UNAUTHORIZED` for device events |
| `ROOM_NOT_FOUND` | 404 | Declared for unknown room codes | Current service raises `NOT_FOUND`; resolve the room code first |
| `ROOM_DEGRADED` | 503 | Declared for unavailable room hardware | Not emitted by the current routers; room health is surfaced in `GET /hardware/rooms` |

> The four hardware codes above are part of the shared taxonomy, but the
> implemented device endpoint maps signature/room failures to the generic
> `UNAUTHORIZED`/`NOT_FOUND` codes. Treat the table's "current behaviour"
> notes as authoritative until the device router is changed.

## Automatic mappings

| Source | Mapping |
|---|---|
| `AppError` | Uses its own `code` and `ERROR_STATUS[code]`; `details` passed through unchanged |
| Zod `safeParse` failure | `VALIDATION_FAILED` (422) with `details: [{ path, message, code }, ...]` |
| Prisma `P2002` | `CONFLICT` (409), `details.fields` from `meta.target` |
| Prisma `P2025` | `NOT_FOUND` (404) |
| Prisma `P2003` | `CONFLICT` (409), `details.field` from `meta.field_name` |
| Unmatched error | `INTERNAL` (500); in development only, `details.message` includes the raw message |
| Unknown route | `NOT_FOUND` (404) with the method and original URL in `message` |

## Retry guidance

| Status | Safe to retry? | Suggested behaviour |
|---:|---|---|
| 400 / 422 / 403 | No | Fix input or permissions first |
| 401 | Once | Use the refresh cookie, retry once, then sign out |
| 404 / 410 | No | Terminal for that resource/version |
| 409 | After refetch | Re-read state; conflicts are business-rule signals |
| 429 | Yes, after delay | Exponential backoff with jitter |
| 500 / 503 | Carefully | Retry reads; never blindly retry non-idempotent writes without an `Idempotency-Key` |

`POST /appointments` and `POST /swaps` require an `Idempotency-Key`, so a
network timeout can be safely retried with the **same** key and body. Reusing a
key with a different body returns `CONFLICT`. See `docs/api.md` and
`docs/swap.md`.

Always include `requestId` in support reports; API logs are correlated by the
same `x-request-id` value.
