/**
 * System and health endpoints.
 *
 * Three deliberately different endpoints, because load balancers, humans and
 * orchestrators want different answers:
 *
 *  - `GET /health`  — liveness. Is this process up? Never touches a dependency,
 *    so a database blip does not cause Nginx or an ELB to pull a healthy
 *    container out of rotation.
 *  - `GET /ready`   — readiness. Are the dependencies this process needs actually
 *    reachable? Returns 503 when not, which is what a deploy gate should check.
 *  - `GET /status`  — the operator's view: versions, queue depth, model info.
 *    Requires a session.
 */
import { Router } from "express";
import { asyncHandler } from "../../middleware/error";
import { optionalAuth, requireAuth } from "../../middleware/auth";
import { env } from "../../config/env";
import { checkDatabase } from "../../lib/prisma";
import { checkRedis } from "../../lib/redis";
import { checkMlService, getModelInfo } from "../ml/ml.client";
import { checkQueue, getQueueStats } from "../../queue/queues";
import { FEATURE_KEYS } from "../analysis/features/registry";
import { FEATURE_SET_VERSION, RISK_BANDS } from "../../config/constants";
import { getProvider } from "../github/github.service";

const router = Router();

const startedAt = Date.now();

/** Version reported to clients. Set by CI from the git SHA. */
const VERSION = process.env.APP_VERSION ?? "dev";

// ---------------------------------------------------------------------------
// GET /health — liveness
// ---------------------------------------------------------------------------
router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "bugdna-api",
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /ready — readiness
// ---------------------------------------------------------------------------
router.get(
  "/ready",
  asyncHandler(async (_req, res) => {
    const [database, redis, ml, queue] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkMlService(),
      checkQueue(),
    ]);

    // Postgres and Redis are required: without them the API cannot serve or
    // enqueue. The ML service is not — the app is fully usable for browsing and
    // reading past analyses while it is down, so it is reported as degraded
    // rather than failing readiness and taking the whole deployment offline.
    const critical = database.ok && redis.ok;
    const degraded = !ml.ok || !queue.ok;

    res.status(critical ? 200 : 503).json({
      status: critical ? (degraded ? "degraded" : "ok") : "unavailable",
      version: VERSION,
      checks: {
        database,
        redis,
        queue,
        mlService: { ...ml, required: false },
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /status — operator view
// ---------------------------------------------------------------------------
router.get(
  "/status",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const [database, redis, ml, queueStats, model] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkMlService(),
      getQueueStats().catch(() => null),
      getModelInfo(),
    ]);

    res.json({
      data: {
        service: "bugdna-api",
        version: VERSION,
        environment: env.NODE_ENV,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        github: {
          mode: getProvider().mode,
          configured: env.githubConfigured,
          apiBase: env.GITHUB_API_BASE,
        },
        analysis: {
          featureSetVersion: FEATURE_SET_VERSION,
          featureCount: FEATURE_KEYS.length,
          riskBands: RISK_BANDS,
          concurrency: env.ANALYSIS_CONCURRENCY,
          maxAttempts: env.ANALYSIS_JOB_ATTEMPTS,
          timeoutMs: env.ANALYSIS_TIMEOUT_MS,
          highRiskThreshold: env.HIGH_RISK_NOTIFY_THRESHOLD,
        },
        model,
        dependencies: { database, redis, mlService: ml },
        queue: queueStats,
        timestamp: new Date().toISOString(),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /config — what the frontend needs to know about this deployment
// ---------------------------------------------------------------------------
// Unauthenticated: it contains no secrets, and the sign-in page needs it before
// a session exists (to know whether to offer GitHub, demo, or explain that
// neither is configured).
router.get(
  "/config",
  optionalAuth,
  asyncHandler(async (req, res) => {
    res.json({
      data: {
        appName: "BugDNA",
        version: VERSION,
        environment: env.NODE_ENV,
        auth: {
          githubEnabled: env.GITHUB_MODE === "mock" || env.githubConfigured,
          githubMode: env.GITHUB_MODE,
          demoLoginEnabled: env.ENABLE_DEMO_LOGIN,
          signInUrl: `${env.apiPrefix}/auth/github`,
        },
        risk: { bands: RISK_BANDS, highRiskThreshold: env.HIGH_RISK_NOTIFY_THRESHOLD },
        realtime: { path: "/socket.io" },
        authenticated: Boolean(req.auth),
      },
    });
  }),
);

export default router;
