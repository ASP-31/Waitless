import mqtt, { type MqttClient } from "mqtt";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { hardwareEventSchema } from "../modules/hardware/hardware.schema";
import { ingestHardwareEvent } from "../modules/hardware/hardware.service";
import { AppError } from "../utils/errors";

let client: MqttClient | null = null;

const TOPICS = ["waitless/rooms/+/occupancy", "waitless/rooms/+/heartbeat"] as const;

export function startMqttIntegration(): void {
  if (!env.HARDWARE_ENABLED && env.NODE_ENV === "production") return;
  if (client) return;
  try {
    client = mqtt.connect(env.MQTT_URL, {
      username: env.MQTT_USERNAME,
      password: env.MQTT_PASSWORD,
      reconnectPeriod: 5000,
    });
    client.on("connect", () => {
      logger.info({ url: env.MQTT_URL }, "mqtt connected");
      client?.subscribe([...TOPICS]);
    });
    client.on("message", (topic, payload) => {
      void (async () => {
        try {
          const parts = topic.split("/");
          const topicRoom = parts[2];
          if (!topicRoom) return;

          const raw = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
          const roomId = typeof raw.roomId === "string" && raw.roomId ? raw.roomId : topicRoom;
          if (roomId !== topicRoom) {
            logger.warn({ topic, payloadRoomId: roomId }, "mqtt room mismatch, ignoring message");
            return;
          }

          const type = topic.endsWith("/heartbeat") ? "HEARTBEAT" : raw.type;
          const parsed = hardwareEventSchema.safeParse({
            v: raw.v,
            roomId,
            type,
            ts: raw.ts,
            seq: raw.seq,
            sig: raw.sig,
            payload: raw,
          });
          if (!parsed.success) {
            logger.warn({ topic, issues: parsed.error.issues }, "malformed mqtt event, ignoring");
            return;
          }
          // Signature verification, dedupe and lastSeenAt updates all live in ingest.
          await ingestHardwareEvent(parsed.data);
        } catch (error) {
          if (error instanceof AppError && error.status === 401) {
            logger.warn({ topic, reason: error.message }, "ignoring unsigned mqtt event");
            return;
          }
          logger.warn({ err: error, topic }, "failed to process mqtt message");
        }
      })();
    });
    client.on("error", (err) => logger.warn({ err }, "mqtt error"));
  } catch (err) {
    logger.warn({ err }, "mqtt integration not started");
  }
}

export async function stopMqttIntegration(): Promise<void> {
  if (!client) return;
  await new Promise<void>((resolve) => client?.end(false, {}, () => resolve()));
  client = null;
}
