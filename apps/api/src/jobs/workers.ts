import { Worker, type Job } from "bullmq";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { prisma } from "../config/prisma";
import { redisConnectionOptions } from "../config/redis";
import { processVacancy, deviceWatchdog } from "../modules/hardware/hardware.service";
import { dispatchNotification } from "../modules/notifications/notification.service";
import {
  autoSkip,
  closeStaleConsultations,
  expireGrace,
  prepareTomorrowQueues,
} from "../modules/queue/queue.service";
import { expirePendingSwaps, expireSwap } from "../modules/swaps/swap.service";
import { enqueue, getQueue, jobIds, QUEUE_NAMES } from "./schedulers";

let workers: Worker[] = [];

type JobData = Record<string, unknown> & { entryId?: string; swapId?: string; notificationId?: string; roomId?: string };

function attachLogging(worker: Worker, name: string) {
  worker.on("completed", (job: Job) => logger.debug({ queue: name, jobId: job.id, name: job.name }, "job completed"));
  worker.on("failed", (job: Job | undefined, error: Error) => {
    // Dead-letter logging: the job stays in Redis and is visible in /admin/jobs.
    logger.error({ queue: name, jobId: job?.id, name: job?.name, err: error }, "job failed (dead-letter)");
  });
  worker.on("error", (error: Error) => logger.error({ queue: name, err: error }, "worker error"));
}

async function registerRepeatingJobs() {
  // BullMQ v6 uses job schedulers instead of the old `repeat` job option.
  const maintenance = getQueue(QUEUE_NAMES.maintenance);
  await maintenance.upsertJobScheduler(
    "nightly-maintenance",
    { pattern: "0 2 * * *", tz: env.HOSPITAL_TIMEZONE },
    { name: "nightly", data: {}, opts: { attempts: 3 } },
  );
  await maintenance.upsertJobScheduler(
    "device-watchdog",
    { every: 60_000 },
    { name: "watchdog", data: {}, opts: { attempts: 3 } },
  );
}

/** Redis is an ephemeral job store: rebuild delayed notifications from the DB on boot. */
async function rebuildScheduledNotifications(): Promise<void> {
  const rows = await prisma.notification.findMany({
    where: { status: "SCHEDULED", scheduledFor: { gt: new Date() } },
    select: { id: true, scheduledFor: true },
  });
  for (const row of rows) {
    if (!row.scheduledFor) continue;
    await enqueue(QUEUE_NAMES.notifications, jobIds.dispatch(row.id), { notificationId: row.id }, { runAt: row.scheduledFor });
  }
  if (rows.length) logger.info({ count: rows.length }, "scheduled notifications rebuilt from database");
}

export async function startWorkers(): Promise<void> {
  if (workers.length) return;
  const connection = redisConnectionOptions();
  const opts = { connection, concurrency: 5 };

  const queueWorker = new Worker<JobData>(QUEUE_NAMES.queue, async (job) => {
    // Producer uses the deterministic job id as the job name (grace:<entryId>).
    if (job.name.startsWith("grace:") && job.data.entryId) return expireGrace(job.data.entryId);
    if (job.name.startsWith("autoskip:") && job.data.entryId) return autoSkip(job.data.entryId);
    logger.warn({ name: job.name }, "unknown queue job");
  }, opts);

  const notificationWorker = new Worker<JobData>(QUEUE_NAMES.notifications, async (job) => {
    if ((job.name.startsWith("dispatch:") || job.name.startsWith("ready30:")) && job.data.notificationId) {
      return dispatchNotification(job.data.notificationId);
    }
    logger.warn({ name: job.name }, "unknown notification job");
  }, opts);

  const swapWorker = new Worker<JobData>(QUEUE_NAMES.swaps, async (job) => {
    if (job.data.swapId) return expireSwap(job.data.swapId);
    logger.warn({ name: job.name }, "unknown swap job");
  }, opts);

  const hardwareWorker = new Worker<JobData>(QUEUE_NAMES.hardware, async (job) => {
    if (job.data.roomId) return processVacancy(job.data.roomId);
    logger.warn({ name: job.name }, "unknown hardware job");
  }, opts);

  const maintenanceWorker = new Worker<JobData>(QUEUE_NAMES.maintenance, async (job) => {
    if (job.name === "nightly") {
      const prepared = await prepareTomorrowQueues();
      const expired = await expirePendingSwaps();
      const closed = await closeStaleConsultations();
      return { prepared, expired, closed };
    }
    if (job.name === "watchdog") return deviceWatchdog();
    if (job.name === "stale-consultations") return closeStaleConsultations();
    logger.warn({ name: job.name }, "unknown maintenance job");
  }, opts);

  workers = [queueWorker, notificationWorker, swapWorker, hardwareWorker, maintenanceWorker];
  workers.forEach((worker, index) =>
    attachLogging(worker, [QUEUE_NAMES.queue, QUEUE_NAMES.notifications, QUEUE_NAMES.swaps, QUEUE_NAMES.hardware, QUEUE_NAMES.maintenance][index]!),
  );
  await registerRepeatingJobs();
  await rebuildScheduledNotifications();
  logger.info({ workers: workers.length }, "background workers started");
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
  workers = [];
}
