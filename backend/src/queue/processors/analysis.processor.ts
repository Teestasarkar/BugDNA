/**
 * Analysis worker.
 *
 * Thin by design: BullMQ concerns (concurrency, attempts, locks, timeouts) live
 * here, and everything about *what an analysis is* lives in the pipeline. That
 * separation means the pipeline is directly testable without a Redis instance.
 */
import { Worker, type Job } from "bullmq";
import { env } from "../../config/env";
import { scoped } from "../../lib/logger";
import { ANALYSIS_QUEUE, queueBaseOptions } from "../queues";
import { runAnalysis, type AnalysisJobData } from "../../modules/analysis/analysis.pipeline";

const log = scoped("worker");

let worker: Worker<AnalysisJobData> | undefined;

/**
 * Guard against a job outliving its usefulness.
 *
 * BullMQ cannot cancel a running promise, so the timeout is enforced here by
 * racing the pipeline. The loser is abandoned rather than killed — acceptable
 * because every stage is either idempotent or writes only its own analysis row.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, jobId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Analysis exceeded the ${Math.round(ms / 1000)}s time limit and was abandoned (job ${jobId}).`,
        ),
      );
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function startAnalysisWorker(): Worker<AnalysisJobData> {
  if (worker) return worker;

  worker = new Worker<AnalysisJobData>(
    ANALYSIS_QUEUE,
    async (job: Job<AnalysisJobData>) => {
      const attempt = job.attemptsMade + 1;
      const maxAttempts = job.opts.attempts ?? env.ANALYSIS_JOB_ATTEMPTS;

      log.info(
        {
          jobId: job.id,
          analysisId: job.data.analysisId,
          attempt,
          maxAttempts,
        },
        "processing analysis",
      );

      return withTimeout(
        runAnalysis(job.data, { attempt, maxAttempts }),
        env.ANALYSIS_TIMEOUT_MS,
        String(job.id),
      );
    },
    {
      ...queueBaseOptions,
      concurrency: env.ANALYSIS_CONCURRENCY,
      // Renew the lock well inside the job timeout so a long-but-healthy
      // analysis is not declared stalled and duplicated.
      lockDuration: Math.max(30_000, Math.floor(env.ANALYSIS_TIMEOUT_MS / 2)),
      // Bound throughput so a burst of queued analyses cannot exhaust the
      // GitHub rate limit or overwhelm the ML service.
      limiter: { max: Math.max(4, env.ANALYSIS_CONCURRENCY * 2), duration: 1_000 },
    },
  );

  worker.on("completed", (job, result) => {
    log.info(
      { jobId: job.id, analysisId: job.data.analysisId, result },
      "job completed",
    );
  });

  worker.on("failed", (job, error) => {
    log.error(
      {
        jobId: job?.id,
        analysisId: job?.data.analysisId,
        attempt: (job?.attemptsMade ?? 0) + 1,
        err: error.message,
      },
      "job failed",
    );
  });

  worker.on("error", (error) => log.error({ err: error }, "worker error"));

  log.info(
    { queue: ANALYSIS_QUEUE, concurrency: env.ANALYSIS_CONCURRENCY },
    "analysis worker started",
  );

  return worker;
}

export async function stopAnalysisWorker(): Promise<void> {
  if (!worker) return;
  // `close()` waits for in-flight jobs, so a deploy does not abandon work.
  await worker.close();
  worker = undefined;
  log.info("analysis worker stopped");
}
