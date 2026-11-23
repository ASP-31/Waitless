# Firmware Skeleton (NXP FRDM-MCXN236)

Publishes room occupancy and heartbeat events to Waitless over MQTT. The code
is intentionally small: **sensor read → debounce → MQTT publish → heartbeat**,
with a dependency-free host simulation mode for demos and tests.

## Files

| File | Purpose |
| --- | --- |
| `hardware.h` | Configuration, platform/sensor/publisher interfaces. |
| `platform.c` | Millisecond clock (virtual in `HOST_SIM`, MCU stub otherwise). |
| `sensor.c` | Occupancy sample source (scripted in `HOST_SIM`, GPIO stub on MCU). |
| `publisher.c` | Canonical JSON body, signature stub, MQTT publish hook. |
| `main.c` | Debounce state machine, heartbeat timer, CLI parsing. |
| `Makefile` | `make host`, `make run`, `make embedded`, `make clean`. |

## Host simulation (no board, no dependencies)

```bash
cd hardware/firmware
make host
./build/waitless-host-sim --room OPD-1 --script 1,1,0,0,1
# or: make run
```

With Strawberry/MSYS2 GCC on Windows the same build works without `make`:

```powershell
gcc -std=c11 -Wall -Wextra -Werror -DHOST_SIM -o build/waitless-host-sim.exe main.c platform.c sensor.c publisher.c
.\build\waitless-host-sim.exe --room OPD-1 --script occupied,occupied,vacant
```

Each script value advances a virtual 5-second tick, so the default 5-second
debounce is visible: duplicate samples are suppressed and only real state
changes are published. Output is one JSON line per publish, for example:

```json
{"topic":"waitless/rooms/OPD-1/occupancy","payload":{"v":1,"roomId":"OPD-1","type":"OCCUPIED","ts":5000,"seq":1},"sig":"000..."}
```

Host builds print a placeholder signature. Use
`hardware/simulator/publish.mjs` to exercise the signed end-to-end path.

## Real board

The FRDM-MCXN236 has **no radio**; attach an ESP32-class UART bridge or a
CYW43439-class SPI Wi-Fi module. See `../docs/wiring.md` for pin placeholders
and calibration notes.

- **MCUXpresso SDK / IDE** — create a C project from these sources, replace the
  `sensor_read()` stub with `GPIO_PinRead()`, map `publisher_*` to your MQTT
  client (lwIP/MQTT or the UART bridge protocol), and map `platform_now_ms()`
  to a board timer.
- **Zephyr RTOS** — wrap the directory as a Zephyr app (`CMakeLists.txt`,
  `prj.conf`), use `gpio_pin_get_dt()` for the sensor, `k_uptime_get()` for the
  clock and the Zephyr MQTT socket API for publishing.
- `make embedded` prints the porting checklist; the actual link step is
  SDK-specific and therefore not part of the host Makefile.

### Signing on device

1. Build with `-DWAITLESS_HMAC_MBEDTLS` and link mbedTLS (available in both
   MCUXpresso and Zephyr), or implement `sign_body()` with a secure element.
2. Provision `DEVICE_HMAC_SECRET` at manufacture time — do **not** ship the
   default from `publisher.c`.
3. Signature recipe is in `../docs/contract.md`: HMAC-SHA256 over the canonical
   JSON body `{v,roomId,type,ts,seq}` in that exact key order.
4. Persist the monotonic `seq` in flash/NVM so it survives reboots; server
   dedupe uses `roomCode:seq:type`.
5. Configure the MQTT client with a per-device username equal to the room code
   (for example `OPD-1`) and that room's password. The broker ACL uses `%u` to
   allow only that room's `occupancy`/`heartbeat` writes; the API gateway account
   cannot publish. MQTT credentials are distinct from `DEVICE_HMAC_SECRET`, and
   neither belongs in source control. Rotation steps are in
   [`../docs/wiring.md`](../docs/wiring.md).

## Behaviour

- Heartbeat published on boot and every 30 s (configurable via
  `WAITLESS_HEARTBEAT_MS`); the backend tolerates the standard 5-minute
  watchdog window.
- Occupancy changes are debounced for 5 s (`WAITLESS_DEFAULT_DEBOUNCE_MS`,
  matching `SENSOR_DEBOUNCE_SECONDS` on the server).
- The backend treats occupancy as advisory: no consultation is ever created or
  completed automatically unless `HARDWARE_AUTO_COMPLETE=true` and the vacancy
  persists past the server-side delay.
