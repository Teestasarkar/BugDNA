/**
 * API server entrypoint.
 *
 * Starts the HTTP server and the Socket.io layer, and shuts both down cleanly.
 *
 * Graceful shutdown matters more than it looks: on a rolling deploy this process
 * receives SIGTERM while requests are in flight. Stopping the listener first,
 * then draining, then closing the database and Redis connections, is the
 * difference between a deploy nobody notices and a handful of 502s.
 */
import http from "node:http";
import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { checkDatabase, disconnectPrisma } from "./lib/prisma";
import { checkRedis, disconnectRedis } from "./lib/redis";
import { checkMlService } from "./modules/ml/ml.client";
import { initRealtime, shutdownRealtime } from "./realtime/socket";
import { closeQueues } from "./queue/queues";
import { FEATURE_KEYS } from "./modules/analysis/features/registry";
import { FEATURE_SET_VERSION } from "./config/constants";

/** How long to let in-flight requests finish before forcing exit. */
const SHUTDOWN_GRACE_MS = 15_000;

async function main(): Promise<void> {
  // Configuration warnings are emitted here rather than in env.ts, because the
  // logger depends on the configuration being parsed first.
  for (const warning of env.startupWarnings) {
    logger.warn(warning);
  }

  const app = createApp();
  const server = http.createServer(app);

  // Socket.io shares the HTTP server, so both are reachable on one port — which
  // keeps the Nginx configuration and the firewall rules simple.
  initRealtime(server);

  // Report dependency state at boot without refusing to start. A container that
  // exits because Postgres is 200ms behind it in the startup order is a worse
  // failure mode than one that starts and reports itself unready.
  void reportDependencies();

  server.listen(env.API_PORT, () => {
    logger.info(
      {
        port: env.API_PORT,
        environment: env.NODE_ENV,
        apiPrefix: env.apiPrefix,
        appUrl: env.APP_URL,
        githubMode: env.GITHUB_MODE,
        corsOrigins: env.CORS_ORIGINS,
        featureSetVersion: FEATURE_SET_VERSION,
        featureCount: FEATURE_KEYS.length,
      },
      `BugDNA API listening on port ${env.API_PORT}`,
    );
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.fatal(
        { port: env.API_PORT },
        `Port ${env.API_PORT} is already in use. Stop the other process or set API_PORT.`,
      );
      process.exit(1);
    }
    logger.fatal({ err: error }, "server error");
    process.exit(1);
  });

  installShutdownHandlers(server);
}

async function reportDependencies(): Promise<void> {
  const [database, redis, ml] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkMlService(),
  ]);

  if (database.ok) logger.info({ latencyMs: database.latencyMs }, "postgres reachable");
  else logger.error({ error: database.error }, "postgres unreachable — requests will fail");

  if (redis.ok) logger.info({ latencyMs: redis.latencyMs }, "redis reachable");
  else logger.error({ error: redis.error }, "redis unreachable — caching and queueing degraded");

  if (ml.ok) {
    logger.info(
      { engine: ml.engine, modelVersion: ml.modelVersion, latencyMs: ml.latencyMs },
      "risk service reachable",
    );
  } else {
    logger.warn(
      { error: ml.error, url: env.ML_SERVICE_URL },
      "risk service unreachable — analyses will queue and retry until it is available",
    );
  }
}

function installShutdownHandlers(server: http.Server): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ signal }, "shutdown already in progress");
      return;
    }
    shuttingDown = true;

    logger.info({ signal }, "shutting down");

    // Hard deadline: if draining hangs (a wedged keep-alive connection, say),
    // exit anyway rather than being killed with an unclear cause.
    const forceExit = setTimeout(() => {
      logger.error("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    try {
      // 1. Stop accepting new connections, let existing requests finish.
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      logger.info("http server closed");

      // 2. Close realtime, then the shared infrastructure.
      await shutdownRealtime();
      await closeQueues();
      await Promise.allSettled([disconnectPrisma(), disconnectRedis()]);

      clearTimeout(forceExit);
      logger.info("shutdown complete");
      process.exit(0);
    } catch (e) {
      logger.error({ err: e }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // An unhandled rejection leaves the process in an unknown state. Log it with
  // full context and exit, so the orchestrator replaces the container rather
  // than leaving it serving from a corrupted state.
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled promise rejection");
    void shutdown("unhandledRejection");
  });

  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught exception");
    void shutdown("uncaughtException");
  });
}

void main();
