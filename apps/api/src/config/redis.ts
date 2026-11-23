import { Redis } from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

/**
 * Shared Redis connection for health checks and BullMQ producers.
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it owns.
 */
const globalForRedis = globalThis as unknown as { redis?: Redis };

/** DB-free unit tests import the app but never issue Redis commands. */
const dbFreeTest = env.NODE_ENV === "test" && process.env.RUN_DB_TESTS !== "true";

export const redis =
  globalForRedis.redis ??
  new Redis(env.REDIS_URL, {
    lazyConnect: dbFreeTest,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: dbFreeTest ? () => null : (attempt) => Math.min(attempt * 200, 5_000),
  });

redis.on("error", (error) => logger.error({ err: error }, "redis error"));

if (env.NODE_ENV !== "production") globalForRedis.redis = redis;

/** Fresh connection options for every BullMQ Queue/Worker instance. */
export function redisConnectionOptions() {
  return {
    host: new URL(env.REDIS_URL).hostname,
    port: Number(new URL(env.REDIS_URL).port || 6379),
    username: new URL(env.REDIS_URL).username || undefined,
    password: new URL(env.REDIS_URL).password || undefined,
    db: Number(new URL(env.REDIS_URL).pathname.slice(1) || 0),
    maxRetriesPerRequest: null as null,
    enableReadyCheck: true as const,
  };
}

export async function checkRedis(): Promise<boolean> {
  try {
    // With lazyConnect in DB-free tests, connect explicitly when health is
    // actually probed instead of opening a socket during module import.
    if (redis.status === "wait") await redis.connect();
    const pong = await redis.ping();
    return pong === "PONG";
  } catch (error) {
    logger.error({ err: error }, "redis unreachable");
    return false;
  }
}
