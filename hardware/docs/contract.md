# Hardware Contract (Waitless)

## MQTT topics
- `waitless/rooms/{roomId}/occupancy` → `{ v:1, roomId, type:"OCCUPIED"|"VACANT", ts, seq, sig }`
- `waitless/rooms/{roomId}/heartbeat` → `{ v:1, ts, rssi, fw }`

## HTTP fallback
- `POST /api/v1/hardware/events` with same payload shape (`roomId`, `type`, `ts`, `seq`, optional `payload`)

## Auth & integrity
- Device auth via MQTT broker credentials/ACL (Mosquitto config in `infra/mosquitto/`)
- Optional HMAC-SHA256 body signature field `sig` using `DEVICE_HMAC_SECRET`.
  Canonical string: `{v}.{roomId}.{type}.{ts}.{seq}` (for example
  `1.OPD-1.VACANT.1760000000000.42`). Signature is optional for simulators but
  rejected when present and invalid.

## Idempotency & processing
- Events persisted with `dedupeKey` (`roomId:seq:type`) and unique index; replays ignored
- Same-state repeats inside `SENSOR_DEBOUNCE_SECONDS` (default 5) are dropped as flapping
- Backend records events and treats occupancy as staff-assist hints (not authoritative patient identity)
- Rooms are associated to doctors through `Doctor.roomId`; an unassigned room records the event with `doctorId = null`
- `VACANT` while the room's doctor has an `IN_CONSULTATION` entry sets `result = SUGGESTED_END` and emits `hardware:occupancy`
- Auto-complete only when `HARDWARE_AUTO_COMPLETE=true` and vacancy persists `AUTO_COMPLETE_DEBOUNCE_MINUTES`

## Failure modes
- Missing/unknown room: rejected (404) by HTTP ingest; MQTT subscriber logs and skips
- Duplicate seq/replay: accepted as duplicate/no-op
- Broker/device offline: heartbeat absence can be surfaced in admin views (future enhancement)

## Simulator
- `node hardware/simulator/publish.mjs --room OPD-1 --pattern in-out` (requires `mqtt` installed at repo root/api context or run with dependencies available)
