/**
 * Job queues.
 *
 * BullMQ over Redis. The API process only ever *enqueues*; the worker process
 * consumes. That split is what keeps a 40-second analysis out of an HTTP
 * request, and it means the two can be scaled independently — several workers
 * behind one API, or vice versa.
 *
 * Redis holds the queue, but every job's meaningful state is mirrored in
 * Postgres (the `Analysis` row). If Redis were lost, in-flight jobs would be
 * lost with it, but nothing would be corrupted: those analyses stay visible as
 * RUNNING and can be re-queued from the UI. That is the trade being made, and
 * it is why Redis is never the source of truth.
 */
import { Queue, QueueEvents, type JobsOptions } from "bullmq";
import { queueRedis } from "../lib/redis";
import { env } from "../config/env";
import { scoped } from "../lib/logger";
import type { AnalysisJobData } from "../modules/analysis/analysis.pipeline";

const log = scoped("queue");

export const ANALYSIS_QUEUE = env.ANALYSIS_QUEUE_NAME;

/**
 * Connection and key namespace, shared by every BullMQ construction site.
 *
 * A Queue, a Worker and a QueueEvents pointed at the same name but a different
 * prefix are three objects reading three different sets of Redis keys, and they
 * fail silently: the API enqueues, the worker sits idle, and nothing logs an
 * error. Exporting one object instead of two loose values is what stops that
 * from being possible — the Worker in analysis.processor.ts spreads this too.
 */
export const queueBaseOptions = {
  connection: queueRedis,
  prefix: env.QUEUE_PREFIX,
} as const;

/** Default job policy. Overridable per enqueue. */
export const defaultJobOptions: JobsOptions = {
  attempts: env.ANALYSIS_JOB_ATTEMPTS,
  backoff: { type: "exponential", delay: env.ANALYSIS_JOB_BACKOFF_MS },
  // Keep a bounded history: enough to debug recent failures, not enough to grow
  // Redis without limit.
  removeOnComplete: { age: 24 * 3600, count: 500 },
  removeOnFail: { age: 7 * 24 * 3600, count: 500 },
};

let analysisQueue: Queue<AnalysisJobData> | undefined;

export function getAnalysisQueue(): Queue<AnalysisJobData> {
  if (!analysisQueue) {
    analysisQueue = new Queue<AnalysisJobData>(ANALYSIS_QUEUE, {
      ...queueBaseOptions,
      defaultJobOptions,
    });
    analysisQueue.on("error", (e) => log.error({ err: e }, "analysis queue error"));
  }
  return analysisQueue;
}

export interface EnqueueResult {
  jobId: string;
  /** Position is informational; BullMQ does not guarantee strict ordering. */
  queuedAt: string;
}

/**
 * Enqueue an analysis.
 *
 * The job id is the analysis id, which makes enqueueing idempotent: a
 * double-clicked button cannot create two jobs for the same analysis row.
 */
export async function enqueueAnalysis(data: AnalysisJobData): Promise<EnqueueResult> {
  const queue = getAnalysisQueue();

  const job = await queue.add("analyze-pull-request", data, {
    jobId: data.analysisId,
    // Cap total runtime so a wedged job cannot occupy a worker slot forever.
    // BullMQ does not kill the promise, but it stops waiting on the lock.
  });

  log.info(
    {
      jobId: job.id,
      analysisId: data.analysisId,
      repositoryId: data.repositoryId,
      pullRequest: data.pullRequestNumber,
    },
    "analysis enqueued",
  );

  return { jobId: String(job.id), queuedAt: new Date().toISOString() };
}

/** Queue depth, surfaced on the system health endpoint. */
export async function getQueueStats(): Promise<{
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}> {
  const queue = getAnalysisQueue();
  const counts = await queue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "failed",
    "completed",
  );
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    completed: counts.completed ?? 0,
  };
}

/** Best-effort readiness check for the queue backend. */
export async function checkQueue(): Promise<{ ok: boolean; error?: string; stats?: unknown }> {
  try {
    const stats = await getQueueStats();
    return { ok: true, stats };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Remove a job for an analysis that is being cancelled or re-queued.
 * A missing job is a success — it may already have completed.
 */
export async function removeAnalysisJob(analysisId: string): Promise<void> {
  try {
    const job = await getAnalysisQueue().getJob(analysisId);
    await job?.remove();
  } catch (e) {
    log.warn({ err: e, analysisId }, "failed to remove analysis job");
  }
}

let queueEvents: QueueEvents | undefined;

/** Queue-level observability, started by the worker process. */
export function initQueueEvents(): QueueEvents {
  if (queueEvents) return queueEvents;

  queueEvents = new QueueEvents(ANALYSIS_QUEUE, {
    ...queueBaseOptions,
    // QueueEvents blocks on Redis, so it needs its own connection.
    connection: queueRedis.duplicate(),
  });

  queueEvents.on("stalled", ({ jobId }) =>
    log.warn({ jobId }, "job stalled; it will be retried by another worker"),
  );
  queueEvents.on("failed", ({ jobId, failedReason }) =>
    log.warn({ jobId, failedReason }, "job failed"),
  );
  queueEvents.on("error", (e) => log.error({ err: e }, "queue events error"));

  return queueEvents;
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([analysisQueue?.close(), queueEvents?.close()]);
  analysisQueue = undefined;
  queueEvents = undefined;
  log.info("queues closed");
}
