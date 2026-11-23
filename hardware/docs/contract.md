# Hardware Contract (Waitless)

Room sensors are **advisory**: they never identify a patient and never start or
complete a consultation on their own. Staff remain authoritative.

## Topics and payloads

| Topic | Direction | Payload | Notes |
| --- | --- | --- | --- |
| `waitless/rooms/{roomId}/occupancy` | device → server | `{ v:1, roomId, type:"OCCUPIED"\|"VACANT", ts, seq, sig, ... }` | `roomId` is the `Room.code` (e.g. `OPD-1`) and must match the topic segment. |
| `waitless/rooms/{roomId}/heartbeat` | device → server | `{ v:1, roomId, type:"HEARTBEAT", ts, seq, sig, rssi?, fw? }` | Topic forces type `HEARTBEAT`; refreshes `Room.lastSeenAt`. |
| `POST /api/v1/hardware/events` | device → server | Same JSON body as a topic payload | Public HTTP fallback; returns `{ data: { event, duplicate } }`. |

`ts` is epoch milliseconds (number) or an ISO-8601 string. `seq` is a
monotonically increasing per-device counter (number or string). Both are
**required for signed events**. Extra keys (e.g. `rssi`, `fw`) are kept in
`HardwareEvent.payload` but are not signed.

## HMAC signature (exact recipe)

The `sig` field is lowercase hex HMAC-SHA256, keyed by `DEVICE_HMAC_SECRET`.
The signed message is the UTF-8 bytes of `JSON.stringify` of an object with
exactly these five keys, **in this order** (no whitespace, no extra fields):

```
{ "v": 1, "roomId": "OPD-1", "type": "OCCUPIED", "ts": 1760000000000, "seq": 42 }
```

Serialized (this exact string is signed):

```
{"v":1,"roomId":"OPD-1","type":"OCCUPIED","ts":1760000000000,"seq":42}
```

Rules:

1. `v` defaults to `1` when absent; send `1` explicitly from devices.
2. `roomId`, `type`, `ts`, `seq` are used **exactly as received** — a numeric
   `ts` is a JSON number, a string `ts` is a JSON string. Never reformat them.
3. Keys are emitted in the order `v`, `roomId`, `type`, `ts`, `seq`.
4. `sig = HMAC_SHA256(DEVICE_HMAC_SECRET, message).digest("hex")`.
5. Server compares with `timingSafeEqual`; missing, malformed or mismatched
   signatures return **401** (`UNAUTHORIZED`). The MQTT gateway logs and drops
   such messages.

Node example (also used by `hardware/simulator/publish.mjs`):

```js
import { createHmac } from "node:crypto";
const body = { v: 1, roomId, type, ts, seq };
const sig = createHmac("sha256", secret)
  .update(JSON.stringify(body), "utf8")
  .digest("hex");
```

## Broker authentication and ACLs

The local Mosquitto broker disables anonymous access (`allow_anonymous false`)
and uses `infra/mosquitto/passwd` plus `infra/mosquitto/acl.conf`.

| Account | Username | Local dev password | Permissions |
| --- | --- | --- | --- |
| API gateway | `waitless-gateway` | `waitless-gateway-dev` | Subscribe to `waitless/rooms/#` and `$SYS/#` (healthcheck); no publishes. |
| Room device | room code, e.g. `OPD-1` | `dev-OPD-1-key` (similarly `dev-OPD-2-key`, …) | Publish only `waitless/rooms/%u/occupancy` and `waitless/rooms/%u/heartbeat`. |

`%u` expands to the MQTT username, so a device's username **must** equal its
`Room.code`. The ACL grants no reads to devices and no access to another
room's topics. MQTT credentials are separate from `DEVICE_HMAC_SECRET`: a
valid login does not bypass HMAC verification, and a valid signature does not
bypass the broker ACL.

The checked-in passwords are development-only PBKDF2-SHA512 hashes (20,000
iterations). For shared deployments, generate new hashes with `mosquitto_passwd`
(or the same `$7$` format), update `acl.conf` if room codes/usernames change,
and rotate the gateway secret in both `.env` and the broker password file.
Never reuse these values in production.

## Processing rules

| Topic / situation | Rule |
| --- | --- |
| New event | Persisted with `processedAt` set; HTTP 201. |
| Replay | `dedupeKey = "${roomCode}:${seq}:${type}"` is unique — replay returns 200 with `duplicate:true` and no side effects. |
| Retry | Devices retry with the **same** `seq` and `sig` after a timeout; duplicates are harmless. A new state needs a new `seq`. |
| Occupancy flicker | Any `OCCUPIED`/`VACANT` within `SENSOR_DEBOUNCE_SECONDS` of the previous occupancy event is logged as `result:"DEBOUNCED"` and has no queue effect. |
| `OCCUPIED`, consultation open | Link to the room's doctor and today's `IN_CONSULTATION` entry: `result:"ASSOCIATED"`, emit socket `hardware:occupancy`. |
| `OCCUPIED`, nobody in consultation | `result:"UNSCHEDULED_OCCUPANCY"` + staff alert via `notifyStaff`. **Never** auto-create a consultation. |
| `VACANT`, consultation open | Set `Consultation.suggestedEndAt`; emit socket `hardware:occupancy`; prompt staff (when auto-complete is off); enqueue vacancy check after `AUTO_COMPLETE_DEBOUNCE_MINUTES`. |
| Vacancy job | Re-reads the latest **occupancy** event (heartbeats are ignored) and the consultation. With `HARDWARE_AUTO_COMPLETE=true` and both still open, call `completeConsultation(entryId, null, "SENSOR")`. Otherwise staff confirmation wins. |
| Heartbeat | Refresh `Room.lastSeenAt`, restore `status:"ONLINE"`. |
| Missing heartbeat | Watchdog marks inactive devices' rooms `DEGRADED` after `DEVICE_WATCHDOG_MINUTES` (surfaced by `GET /hardware/rooms`). |

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Bad/missing signature or missing `ts`/`seq` | HTTP 401; MQTT message logged and ignored. |
| Bad MQTT credentials or ACL denial | Connection refused/disconnected or publish denied; no event reaches the gateway. |
| Unknown room code | HTTP 404; MQTT message logged and skipped. |
| Malformed JSON / wrong type | Validation error (HTTP 400 / MQTT skipped). |
| Broker offline | Device keeps a local `seq`, queues publishes, sends heartbeats on reconnect; room shows `DEGRADED` while silent. |
| Redis/job scheduler unavailable | Event and `suggestedEndAt` are still stored; scheduling failure is logged, staff prompt remains. |
| Sensor false positive | Debounce + staff confirmation; `HARDWARE_AUTO_COMPLETE` defaults to `false`. |

## Local simulator

```bash
# Device credentials default to room code + dev-OPD-N-key.
node hardware/simulator/publish.mjs --room OPD-1 --pattern in-out --url mqtt://localhost:1883

# Explicit credentials / secret
DEVICE_HMAC_SECRET=dev-device-secret-change-me node hardware/simulator/publish.mjs \
  --room OPD-1 --pattern heartbeat --username OPD-1 --password dev-OPD-1-key
```

Patterns: `in-out` (heartbeat → OCCUPIED → VACANT), `occupied`, `vacant`,
`heartbeat`. `--http http://localhost:4000/api/v1` posts the same signed body
to the HTTP fallback instead of MQTT. The simulator prefers
`DEVICE_MQTT_USERNAME` / `DEVICE_MQTT_PASSWORD`; `MQTT_USERNAME` /
`MQTT_PASSWORD` are gateway credentials by default and are only interpreted as
device credentials when the username is a room code (legacy compatibility).
