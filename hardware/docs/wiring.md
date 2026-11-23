# Wiring & Calibration Notes

Target board: **NXP FRDM-MCXN236**. Pin numbers below are placeholders until a
specific sensor/breakout and revision are chosen; confirm against the board
schematic before powering anything.

> ⚠️ **The FRDM-MCXN236 has no Wi-Fi/Bluetooth radio.** A network add-on is
> required: either an ESP32 (or ESP8266) module running an MQTT bridge over
> UART, or a CYW43439 / similar SPI Wi-Fi module with an SDK network stack.
> The firmware skeleton abstracts this behind `publisher_*.c` so the MCU code
> does not depend on the chosen link.

## Proposed wiring (placeholders)

| Signal | MCU pin (placeholder) | Sensor / add-on pin | Notes |
| --- | --- | --- | --- |
| Occupancy sense | `BOARD_SENSOR_GPIO` (e.g. P1_2) | OUT / INT | 3.3 V logic; use a level shifter if the sensor is 5 V. |
| Sensor VCC | 3V3 | VCC | Check current draw; mmWave modules can need 5 V. |
| Sensor GND | GND | GND | Common ground with the add-on. |
| UART TX (WiFi bridge) | `BOARD_WIFI_TX` (placeholder) | RX | 115200 baud, 8N1. |
| UART RX (WiFi bridge) | `BOARD_WIFI_RX` (placeholder) | TX | Level-shift if the module is 5 V tolerant only. |
| SPI alternative | `BOARD_WIFI_SPI_*` (placeholders) | SCK/MISO/MOSI/CS | Use instead of UART for CYW43439-style modules. |
| Debug console | OpenSDA USB | — | Serial logs during bring-up. |

### Diagram placeholders

- `[PHOTO: FRDM-MCXN236 + sensor + Wi-Fi add-on, top view]`
- `[DIAGRAM: MCU ←UART/SPI→ Wi-Fi add-on ←MQTT→ broker]`
- `[DIAGRAM: mounting height / detection cone for room OPD-1]`

## Sensor choice

- **PIR** — cheap, low power, privacy-friendly; misses a patient who sits still.
- **mmWave (24/60 GHz)** — detects presence through stillness; tune sensitivity
  to avoid detecting the neighbouring room through a thin wall.
- **ToF** — good for chair/table mounted counting; needs a clear line of sight.

Pick one sensor family per deployment and record the part number and firmware
revision in this file.

## Device credentials

Each room sensor uses a **unique MQTT username equal to its room code** (for
example `OPD-1`). The broker's `%u` ACL only permits writes to
`waitless/rooms/<room>/occupancy` and `.../heartbeat`; using another room's
username or the gateway account fails closed. Local dev passwords are
`dev-OPD-1-key`, `dev-OPD-2-key`, … and are hashed in
`infra/mosquitto/passwd`.

Provision the username/password and `DEVICE_HMAC_SECRET` on the device (or its
Wi-Fi bridge) at install time; never store them in firmware source. Keep the
monotonic `seq` in NVM so replays remain harmless across credential rotations.
To rotate, add or replace the user's hash in `infra/mosquitto/passwd`, update
the device/bridge configuration, reconnect, and confirm a heartbeat restores
the room to `ONLINE`. See [`contract.md`](contract.md) for ACL and HMAC
details.

## Calibration notes

1. Flash the skeleton with `HOST_SIM` first and verify the event sequence
   (`sensor read → debounce → publish → heartbeat`) on the console.
2. On hardware, log raw readings for 10 minutes with the room empty and 10
   minutes occupied; record the threshold and hysteresis used.
3. Set `SENSOR_DEBOUNCE_SECONDS` (server) to match the sensor's settling time —
   default 5 s; mmWave often needs 8–15 s.
4. Mount the sensor so it does not see corridor traffic; note height, angle and
   any blind spots in the diagram above.
5. Verify a monotonic `seq` survives reboot (store it in flash/NVM); the server
   dedupes on `roomCode:seq:type`.
6. Confirm HMAC signing with the simulator before fielding a device; unsigned
   MQTT messages are dropped with a warning.
7. Disconnect the device for `DEVICE_WATCHDOG_MINUTES` and confirm the room is
   shown as `DEGRADED`, then reconnect and confirm recovery to `ONLINE`.

## Room-specific records

| Room | Sensor | Threshold | Debounce | Mount notes | Validated on |
| --- | --- | --- | --- | --- | --- |
| OPD-1 | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
