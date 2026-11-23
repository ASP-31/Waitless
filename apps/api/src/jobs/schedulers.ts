import { Queue, type JobsOptions } from "bullmq";
import { env } from "../config/env";
import { redisConnectionOptions } from "../config/redis";

/** Queue names are stable strings so jobs survive deploys with the same Redis. */
export const QUEUE_NAMES = {
  notifications: "waitless-notifications",
  queue: "waitless-queue",
  swaps: "waitless-swaps",
  maintenance: "waitless-maintenance",
  hardware: "waitless-hardware",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: redisConnectionOptions(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 },
      },
    });
    queues.set(name, queue);
  }
  return queue;
}

/** Adds (or replaces) a job with a deterministic id. Never schedules in the past. */
export async function enqueue<T extends Record<string, unknown>>(
  name: QueueName,
  jobId: string,
  data: T,
  options: JobsOptions & { runAt?: Date } = {},
): Promise<string | null> {
  const { runAt, ...jobOptions } = options;
  if (runAt && runAt.getTime() <= Date.now()) {
    // Clock-skew / ETA drift guard: a stale reminder is worse than no reminder.
    return null;
  }
  const job = await getQueue(name).add(jobId, data, {
    jobId,
    delay: runAt ? Math.max(0, runAt.getTime() - Date.now()) : undefined,
    ...jobOptions,
  });
  return job.id ?? null;
}

export async function cancelJob(name: QueueName, jobId: string): Promise<void> {
  const job = await getQueue(name).getJob(jobId);
  if (job) await job.remove();
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}

export const jobIds = {
  grace: (entryId: string) => `grace:${entryId}`,
  autoSkip: (entryId: string) => `autoskip:${entryId}`,
  ready30: (appointmentId: string) => `ready30:${appointmentId}`,
  swapExpiry: (swapId: string) => `swap-expiry:${swapId}`,
  vacancy: (roomId: string) => `vacancy:${roomId}`,
  dispatch: (notificationId: string) => `dispatch:${notificationId}`,
};

export const jobsEnabled = () => env.NODE_ENV !== "test" || env.REDIS_URL !== "";
