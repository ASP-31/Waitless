#!/usr/bin/env node
/**
 * Waitless hardware simulator.
 *
 * Publishes HMAC-signed OCCUPIED / VACANT / HEARTBEAT events over MQTT (or the
 * HTTP fallback) using the same canonical body as the API and the firmware.
 *
 * MQTT uses per-room device credentials: the username must equal the room code
 * (e.g. OPD-1) so the broker's `%u` ACL permits only that room's topics. The
 * API's MQTT_USERNAME/MQTT_PASSWORD are gateway-only by default; the simulator
 * also accepts room-code values from them for older scripts.
 */
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** pnpm keeps `mqtt` under apps/api; also work when run from the repo root. */
function loadMqtt() {
  try {
    return require("mqtt");
  } catch {
    try {
      return require("../../apps/api/node_modules/mqtt");
    } catch {
      throw new Error("mqtt package not found; run pnpm install or use --http for the HTTP fallback");
    }
  }
}

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const get = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

if (has("--help") || has("-h")) {
  console.log(`Usage: node hardware/simulator/publish.mjs [options]
  --room CODE       Room code (default OPD-1)
  --pattern NAME    in-out | occupied | vacant | heartbeat (default in-out)
  --url URL         MQTT broker URL (default MQTT_URL or mqtt://localhost:1883)
  --http URL        API base URL, e.g. http://localhost:4000/api/v1 (HTTP fallback)
  --secret SECRET   HMAC secret (default DEVICE_HMAC_SECRET or dev default)
  --username USER   MQTT username (default DEVICE_MQTT_USERNAME, room-code MQTT_USERNAME, or room code)
  --password PASS   MQTT password (default DEVICE_MQTT_PASSWORD, paired MQTT_PASSWORD, or dev-OPD-N-key)

MQTT_USERNAME/MQTT_PASSWORD are gateway credentials unless the username is a room code.`);
  process.exit(0);
}

const room = get("--room", process.env.ROOM_CODE || "OPD-1");
const pattern = get("--pattern", "in-out");
const mqttUrl = get("--url", process.env.MQTT_URL || "mqtt://localhost:1883");
const httpBase = get("--http", "").replace(/\/$/, "");
const secret = get("--secret", process.env.DEVICE_HMAC_SECRET || "dev-device-secret-change-me");
const legacyDeviceUsername = /^OPD-\d+$/.test(process.env.MQTT_USERNAME ?? "")
  ? process.env.MQTT_USERNAME
  : undefined;
const username = get(
  "--username",
  process.env.DEVICE_MQTT_USERNAME || legacyDeviceUsername || room,
);
const password = get(
  "--password",
  process.env.DEVICE_MQTT_PASSWORD ||
    (legacyDeviceUsername ? process.env.MQTT_PASSWORD : undefined) ||
    `dev-${room}-key`,
);
const patterns = ["in-out", "occupied", "vacant", "heartbeat"];

if (!patterns.includes(pattern)) {
  console.error(`Unknown pattern "${pattern}". Choose one of: ${patterns.join(", ")}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let seq = Date.now();

function buildEvent(type) {
  const event = { v: 1, roomId: room, type, ts: Date.now(), seq: ++seq };
  // Exact recipe: only these five keys, in this order, no whitespace.
  const canonical = JSON.stringify({
    v: event.v,
    roomId: event.roomId,
    type: event.type,
    ts: event.ts,
    seq: event.seq,
  });
  const sig = createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
  return { ...event, sig };
}

let client = null;
const sent = [];

async function send(type) {
  const body = buildEvent(type);
  const topic = `waitless/rooms/${room}/${type === "HEARTBEAT" ? "heartbeat" : "occupancy"}`;
  if (httpBase) {
    const response = await fetch(`${httpBase}/hardware/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    console.log("posted", `${httpBase}/hardware/events`, response.status, text);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } else if (client) {
    await new Promise((resolve, reject) => {
      client.publish(topic, JSON.stringify(body), { qos: 0 }, (error) => (error ? reject(error) : resolve()));
    });
    console.log("published", topic, JSON.stringify(body));
  }
  sent.push({ type, seq: body.seq, sig: body.sig });
}

async function main() {
  if (!httpBase) {
    const mqtt = loadMqtt();
    client = mqtt.connect(mqttUrl, { username, password, reconnectPeriod: 1000 });
    client.on("error", (error) => console.error("mqtt error", error.message));
    await once(client, "connect");
    console.log("connected", mqttUrl);
  }

  await send("HEARTBEAT");
  if (pattern === "in-out" || pattern === "occupied") {
    await sleep(500);
    await send("OCCUPIED");
  }
  if (pattern === "in-out" || pattern === "vacant") {
    await sleep(pattern === "in-out" ? 5000 : 500);
    await send("VACANT");
  }
  if (pattern === "heartbeat") {
    await sleep(2000);
    await send("HEARTBEAT");
    await sleep(2000);
    await send("HEARTBEAT");
  }

  console.log("done", JSON.stringify(sent));
}

main()
  .catch((error) => {
    console.error("simulator error", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (client) {
      await new Promise((resolve) => client.end(false, {}, resolve));
      client = null;
    }
  });
