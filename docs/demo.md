# 60-second seeded demo

Goal: show a clinic mid-flow, move a patient through the queue, observe ETA and
notifications, try a swap, and exercise room sensors — all against local seed
data. For first-time setup see `docs/dev-setup.md`; for what the stack does and
what is still a pre-production gap see `docs/security.md`.

## 0. Prepare

From the repo root:

```bash
cp .env.example .env      # Windows: Copy-Item .env.example .env
pnpm install
pnpm infra:up
pnpm db:deploy
pnpm db:seed:demo          # documented mid-flow fixture (--demo)
pnpm dev
```

`pnpm db:seed` produces the same idempotent structural data without the
`--demo` flag; use `pnpm db:seed:demo` for the documented mid-flow walkthrough.

The seed prints a **Demo day** in `HOSPITAL_TIMEZONE` (next non-Sunday day).
Usually that is today, so the queue page's default date works. If it prints a
future day, pass `?date=<printed day>` to the queue API or choose that date in
the UI.

Open `http://localhost:5173`. API base is `http://localhost:4000/api/v1`.

## 1. Sign in (10 s)

| Person | Credential | Where |
|---|---|---|
| Admin | `admin@waitless.local` / `Admin@12345` | `/admin` staff login |
| Front desk | `frontdesk@waitless.local` / `Admin@12345` | staff login |
| Patient | `Rohan Kumar` / `9876543210` | patient sign-in (name + phone, no OTP) |
| Patient | `Ananya Desai` / `9876543211` | patient sign-in |
| Patient | `Aditya Bose` / `9876543214` | patient sign-in |

Other seeded patients: Mohammed Faiz (`9876543212`), Kavya Pillai
(`9876543213`), Fatima Sheikh (`9876543215`). Any formatting of these numbers
works — spaces, dashes, `+91`, `91`, or leading `0` are normalised.

## 2. See a live clinic (10 s)

Log in as staff and open the queue for **Dr. Anita Rao** (General Medicine,
room `OPD-1`). The documented `--demo` fixture is deliberately mid-flow: across
the demo day it has **6 `WAITING`**, **1 `IN_CONSULTATION`**, and **1 `DELAYED`**
entry, plus completed/called examples below. Dr. Rao's clinic is the main
walkthrough; Dr. Menon's clinic supplies the delayed/swap examples. The rows in
this checkout are:

| Token | Patient | Status | What it demonstrates |
|---:|---|---|---|
| 1 | Ananya Desai | `COMPLETED` | Finished visit, duration recorded |
| 2 | Mohammed Faiz | `COMPLETED` | Rolling average consultation time |
| 3 | Rohan Kumar | `IN_CONSULTATION` | Current patient, open consultation |
| 4 | Kavya Pillai | `CALLED` | Grace deadline running |
| 5 | Aditya Bose | `WAITING` | ETA and "3 patients ahead" |
| 6 | Fatima Sheikh | `WAITING` | Queue tail |

Dr. Vikram Menon (CARD, `OPD-2`) has a `DELAYED` patient, a `WAITING` patient,
a `NOTIFIED` patient, and a `BOOKED` patient — useful for showing grace and
delay transitions without disturbing Dr. Rao's flow.

The queue response also includes `currentPatient`, `stats`, and each entry's
`estimatedWaitMinutes` / `etaRange`. Missing day entries are created on first
read, so a fresh day also renders correctly.

## 3. Move the queue (15 s)

With a staff token (`STAFF_TOKEN`):

```bash
# Call the next patient (token 4 if you did not change anything)
curl -X PATCH http://localhost:4000/api/v1/queue/entries/$ENTRY_ID/call \
  -H "Authorization: Bearer $STAFF_TOKEN"

# Start the consultation, then finish it
curl -X PATCH http://localhost:4000/api/v1/queue/entries/$ENTRY_ID/start \
  -H "Authorization: Bearer $STAFF_TOKEN"
curl -X PATCH http://localhost:4000/api/v1/queue/entries/$ENTRY_ID/complete \
  -H "Authorization: Bearer $STAFF_TOKEN"
```

Watch for:

- `CALLED` sets `calledAt` and a grace deadline; after `GRACE_MINUTES` (10 by
  default) the job moves the visit to `DELAYED`.
- After another `DELAY_MINUTES`, auto-skip moves it to `SKIPPED` (recoverable).
- `start` opens a `Consultation`; `complete` records duration and recalculates
  every remaining ETA.
- Each mutation writes an `AuditLog` row and emits `queue:updated` over
  Socket.IO. Refresh the staff dashboard or watch the patient view.

Patient view: sign in as a waiting patient and press **I'm here** once
(`POST /queue/entries/:id/check-in`). It may only be used once per appointment
and interrupts the grace window.

## 4. Show a slot swap (15 s)

Use the seeded Dr. Vikram Menon clinic: **Ananya Desai** (`BOOKED`, 09:45) and
**Aditya Bose** (`WAITING`, 09:15) are on the same doctor/day and are eligible.
Sign in as each patient in turn to get `ANANYA_TOKEN` and `ADITYA_TOKEN`.

1. As Ananya, discover masked candidates:

   ```bash
   curl -X POST http://localhost:4000/api/v1/swaps/eligible \
     -H "Authorization: Bearer $ANANYA_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"appointmentId":"<ANANYA_APPOINTMENT_ID>"}'
   ```

   The list contains token numbers, slot times and initials only — never full
   names or phone numbers.

2. Create the request with a fresh idempotency key:

   ```bash
   curl -X POST http://localhost:4000/api/v1/swaps \
     -H "Authorization: Bearer $ANANYA_TOKEN" \
     -H 'Content-Type: application/json' \
     -H 'Idempotency-Key: demo-swap-ananya-aditya-1' \
     -d '{"requesterAppointmentId":"<ANANYA_APPOINTMENT_ID>","targetAppointmentId":"<ADITYA_APPOINTMENT_ID>","message":"Demo swap"}'
   ```

3. As Aditya, respond:

   ```bash
   curl -X PATCH http://localhost:4000/api/v1/swaps/$SWAP_ID/respond \
     -H "Authorization: Bearer $ADITYA_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"action":"ACCEPT"}'
   ```

Acceptance exchanges slot start/end, token numbers, and queue positions in one
transaction, then notifies both patients. The seed also creates a pending demo
swap that spans two doctors; it is for list/UI display only and cannot be
accepted under the same-doctor rule. Cancel it or use the pair above for a
working acceptance. See `docs/swap.md`.

## 5. Show room sensors (10 s)

Bedside hardware is advisory. The simplest local demo is the staff-only
simulator endpoint, which produces a correctly signed event internally:

```bash
curl -X POST http://localhost:4000/api/v1/hardware/simulate \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"roomId":"OPD-1","type":"OCCUPIED"}'

curl -X POST http://localhost:4000/api/v1/hardware/simulate \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"roomId":"OPD-1","type":"VACANT"}'
```

With an open consultation the first event associates with that visit; the
second sets `suggestedEndAt`, emits `hardware:occupancy`, and prompts staff.
Nothing is completed automatically unless `HARDWARE_AUTO_COMPLETE=true`.
`GET /hardware/rooms` shows `ONLINE`/`DEGRADED` status.

For an end-to-end device path, use the bundled **signed, credentialed MQTT
simulator** (canonical contract: [`hardware/docs/contract.md`](../hardware/docs/contract.md)).
It HMAC-signs each canonical event with `DEVICE_HMAC_SECRET` and connects with
per-device MQTT credentials. The local broker disables anonymous access and uses
a `password_file` + `acl_file`; writes are restricted to the device's own room
with `pattern write waitless/rooms/%u/occupancy`, so the MQTT username must match
the room code.

```bash
# Device defaults: DEVICE_MQTT_USERNAME / DEVICE_MQTT_PASSWORD / DEVICE_HMAC_SECRET
node hardware/simulator/publish.mjs --room OPD-1 --pattern in-out \
  --url mqtt://localhost:1883 --username OPD-1 --password '<device-password>'
```

`--pattern` accepts `in-out`, `occupied`, `vacant`, or `heartbeat`.
`--http http://localhost:4000/api/v1` posts the same signed body to the HTTP
fallback.
A signature mismatch, wrong credentials, or an ACL denial means the gateway
logs and drops the message — use the staff-only `/hardware/simulate` shortcut
above as the simplest fallback. See also the pointer at
`docs/hardware/contract.md`.

## 6. Quiet hours (future scope)

Quiet hours are **not implemented in Phase 1–10**. If they are added in future
scope, they should only suppress **outbound notifications** (for
example, in-app/Web Push alert timing). They must not block booking, check-in,
or queue progression (`CALLED` → `IN_CONSULTATION` → `COMPLETED`, grace/auto-skip
timers, and ETAs continue as normal). Changing that policy is out of scope for
v1; do not treat quiet hours as a booking or queue gate.

## 7. Wrap up

- Check `GET /admin/audit` (staff) for the actions you performed.
- Check `GET /notifications` as a patient for booking, queue, and swap alerts.
- Re-run `pnpm db:seed:demo` any time to restore the fixture; it replaces only
  the `[seed]`-tagged demo rows.

If the data looks wrong, `pnpm db:reset` drops, migrates, and reseeds the local
database — never run it against shared data.
