# Hardware simulator

`publish.mjs` sends the same signed event body as the firmware over MQTT or the
HTTP fallback. See [`../docs/contract.md`](../docs/contract.md) for the exact
signature recipe and processing rules.

```bash
# Local broker (default device credentials for OPD-1)
node hardware/simulator/publish.mjs --room OPD-1 --pattern in-out

# Heartbeat-only, explicit credentials
node hardware/simulator/publish.mjs --room OPD-2 --pattern heartbeat \
  --username OPD-2 --password dev-OPD-2-key

# HTTP fallback instead of MQTT
node hardware/simulator/publish.mjs --room OPD-1 --pattern occupied \
  --http http://localhost:4000/api/v1
```

Patterns are `in-out`, `occupied`, `vacant`, and `heartbeat`. Set
`DEVICE_HMAC_SECRET` to match the API; the checked-in dev default is
`dev-device-secret-change-me`.

## MQTT credentials

The local broker disables anonymous access. Each device connects with a
username equal to its room code (`OPD-1`…`OPD-8`); the `acl_file` uses `%u` to
restrict writes to that room's `occupancy` and `heartbeat` topics. Development
passwords are `dev-OPD-1-key`, `dev-OPD-2-key`, … and are stored as PBKDF2
hashes in `infra/mosquitto/passwd`. Override them with `DEVICE_MQTT_USERNAME`
and `DEVICE_MQTT_PASSWORD` or `--username`/`--password`.

`MQTT_USERNAME` and `MQTT_PASSWORD` in `.env` are for the **API gateway**
(`waitless-gateway` / `waitless-gateway-dev` locally), which only subscribes to
`waitless/rooms/#`. Do not use the gateway account for device publishes; its
ACL intentionally denies writes. Older scripts that put a room code in
`MQTT_USERNAME` are still supported, but `DEVICE_MQTT_USERNAME` /
`DEVICE_MQTT_PASSWORD` are preferred.
