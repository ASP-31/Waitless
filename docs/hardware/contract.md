# Hardware contract — pointer

The plan refers to `docs/hardware/contract.md`, but the **canonical hardware
contract is [`hardware/docs/contract.md`](../../hardware/docs/contract.md)**,
next to the simulator and firmware it describes. This file exists only so the
documented path resolves; it intentionally does not duplicate the contract.

Use the canonical document for:

- MQTT topics (`waitless/rooms/{room}/occupancy` and `.../heartbeat`) and the
  HTTP fallback `POST /api/v1/hardware/events`.
- The exact HMAC-SHA256 canonical payload (`v`, `roomId`, `type`, `ts`, `seq`),
  signature rules, dedupe/debounce, and advisory-only processing semantics.
- Device onboarding: anonymous MQTT access is disabled; the broker uses a
  `password_file` + `acl_file` and per-device credentials with
  `pattern write waitless/rooms/%u/occupancy`. The bundled
  `hardware/simulator/publish.mjs` signs events with `DEVICE_HMAC_SECRET` and
  connects with those credentials; `/hardware/simulate` is the staff-only
  fallback.

Related docs: `docs/demo.md` (60-second walkthrough), `docs/security.md`
(device/MQTT security), `docs/api.md` (endpoint reference), `docs/runbook.md`
(operations).
