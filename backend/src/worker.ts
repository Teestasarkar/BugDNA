/**
 * Worker entrypoint.
 *
 * A separate process from the API, for three reasons that all matter in
 * production:
 *
 *  - **Isolation.** A wedged analysis or an OOM in the pipeline cannot take the
 *    API down with it.
 *  - **Independent scaling.** Analysis throughput is bounded by GitHub rate
 *    limits and ML inference, not by HTTP traffic. Those scale differently.
 *  - **Deploy safety.** The worker drains in-flight jobs on SIGTERM without
 *    holding open HTTP connections.
 *
 * It shares the same codebase and configuration as the API, and reaches
 * connected browsers by publishing onto the Redis event bus (see realtime/bus.ts)
 * rather than holding sockets of its own.
 */
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { checkDatabase, disconnectPrisma } from "./lib/prisma";
import { checkRedis, disconnectRedis } from "./lib/redis";
import { checkMlService } from "./modules/ml/ml.client";
import { startAnalysisWorker, stopAnalysisWorker } from "./queue/processors/analysis.processor";
import { closeQueues, initQueueEvents } from "./queue/queues";
import { computeDailySnapshots } from "./modules/analytics/analytics.service";
import { pruneExpiredSessions } from "./modules/auth/session.service";

const SHUTDOWN_GRACE_MS = 45_000; // longer than the API: jobs must drain

/** Scheduled maintenance interval. */
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000; // hourly

async function main(): Promise<void> {
  for (const warning of env.startupWarnings) logger.warn(warning);

  // The worker cannot function without Postgres or Redis, and failing fast with
  // a clear message beats consuming jobs it cannot complete.
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);

  if (!database.ok) {
    logger.fatal({ error: database.error }, "cannot start worker: postgres unreachable");
    process.exit(1);
  }
  if (!redis.ok) {
    logger.fatal({ error: redis.error }, "cannot start worker: redis unreachable");
    process.exit(1);
  }

  const ml = await checkMlService();
  if (!ml.ok) {
    // Not fatal: jobs will retry with backoff, which is the correct behaviour
    // when the model service is merely slow to start.
    logger.warn(
      { error: ml.error, url: env.ML_SERVICE_URL },
      "risk service unreachable at startup; jobs will retry until it responds",
    );
  } else {
    logger.info({ engine: ml.engine, modelVersion: ml.modelVersion }, "risk service reachable");
  }

  const worker = startAnalysisWorker();
  initQueueEvents();

  const maintenance = startMaintenanceLoop();

  logger.info(
    {
      queue: env.ANALYSIS_QUEUE_NAME,
      concurrency: env.ANALYSIS_CONCURRENCY,
      attempts: env.ANALYSIS_JOB_ATTEMPTS,
      timeoutMs: env.ANALYSIS_TIMEOUT_MS,
    },
    "BugDNA analysis worker ready",
  );

  installShutdownHandlers(maintenance);

  // Keep a reference so the worker is not garbage collected.
  void worker;
}

/**
 * Periodic maintenance.
 *
 * Runs in the worker rather than as a separate cron container: these tasks are
 * idempotent, cheap, and keeping them here means one fewer moving part to deploy.
 * With multiple workers they would each run — harmless, because both operations
 * are upserts or deletes of already-expired rows.
 */
function startMaintenanceLoop(): NodeJS.Timeout {
  const run = async (): Promise<void> => {
    try {
      const snapshots = await computeDailySnapshots();
      // Yesterday too, so a late-arriving analysis is reflected in its own day.
      await computeDailySnapshots(new Date(Date.now() - 86_400_000));
      const sessions = await pruneExpiredSessions();

      if (snapshots > 0 || sessions > 0) {
        logger.info({ snapshots, prunedSessions: sessions }, "maintenance completed");
      }
    } catch (e) {
      logger.error({ err: e }, "maintenance run failed");
    }
  };

  // Delay the first run so it does not compete with startup.
  const timer = setTimeout(() => {
    void run();
  }, 30_000);
  timer.unref();

  const interval = setInterval(() => {
    void run();
  }, MAINTENANCE_INTERVAL_MS);

  return interval;
}

function installShutdownHandlers(maintenance: NodeJS.Timeout): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "worker shutting down; waiting for in-flight jobs");

    const forceExit = setTimeout(() => {
      logger.error("worker shutdown timed out; forcing exit");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    try {
      clearInterval(maintenance);

      // `close()` stops taking new jobs and waits for active ones, so an
      // analysis mid-flight completes rather than being abandoned and retried.
      await stopAnalysisWorker();
      await closeQueues();
      await Promise.allSettled([disconnectPrisma(), disconnectRedis()]);

      clearTimeout(forceExit);
      logger.info("worker shutdown complete");
      process.exit(0);
    } catch (e) {
      logger.error({ err: e }, "error during worker shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled promise rejection in worker");
    void shutdown("unhandledRejection");
  });

  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught exception in worker");
    void shutdown("uncaughtException");
  });
}

void main();
