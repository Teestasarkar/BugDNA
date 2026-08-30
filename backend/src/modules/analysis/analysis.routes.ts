/**
 * Analysis routes.
 *
 * `POST /analyses` returns **202 Accepted** with an analysis id, not a result:
 * the work is queued and the client follows it over Socket.io (or by polling
 * `/analyses/:id/status` where websockets are unavailable). That asynchronous
 * contract is what keeps a request from hanging for the length of a GitHub fetch
 * plus an inference call.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error";
import { requireAuth, requireGithubConnection } from "../../middleware/auth";
import { analysisLimiter } from "../../middleware/rateLimit";
import {
  cuidSchema,
  paginationSchema,
  shortText,
  toSkipTake,
  validate,
} from "../../middleware/validate";
import {
  cancelAnalysis,
  compareAnalyses,
  getAnalysisDetail,
  getAnalysisStatus,
  getMergeReadiness,
  listAnalyses,
  recordMergeDecision,
  requestAnalysis,
  retryAnalysis,
} from "./analysis.service";
import { getModelInfo } from "../ml/ml.client";
import { FEATURE_SPECS } from "./features/registry";
import { FEATURE_SET_VERSION, RISK_BANDS } from "../../config/constants";

const router = Router();

router.use(requireAuth);

const riskLevelSchema = z.enum(["LOW", "MODERATE", "HIGH", "CRITICAL"]);
const statusSchema = z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]);

// ---------------------------------------------------------------------------
// POST /analyses — request an analysis (async)
// ---------------------------------------------------------------------------
router.post(
  "/",
  analysisLimiter,
  requireGithubConnection,
  validate({
    body: z.object({
      pullRequestId: cuidSchema,
      /** Re-analyse even if this commit already has a completed result. */
      force: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as { pullRequestId: string; force: boolean };

    const result = await requestAnalysis(req.user(), body.pullRequestId, {
      force: body.force,
    });

    // 200 when an existing result was returned, 202 when work was queued — so a
    // client can tell "here is your answer" from "come back for it".
    res.status(result.reused && result.status === "COMPLETED" ? 200 : 202).json({
      data: result,
      meta: {
        realtime: {
          room: `analysis:${result.analysisId}`,
          subscribeEvent: "subscribe:analysis",
        },
        statusUrl: `/api/v1/analyses/${result.analysisId}/status`,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /analyses — history across everything the caller can see
// ---------------------------------------------------------------------------
router.get(
  "/",
  validate({
    query: paginationSchema.extend({
      repositoryId: cuidSchema.optional(),
      pullRequestId: cuidSchema.optional(),
      authorLogin: z.string().trim().max(120).optional(),
      riskLevel: z
        .union([riskLevelSchema, z.array(riskLevelSchema)])
        .optional()
        .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
      status: z
        .union([statusSchema, z.array(statusSchema)])
        .optional()
        .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
      days: z.coerce.number().int().min(1).max(365).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      page: number;
      perPage: number;
      repositoryId?: string;
      pullRequestId?: string;
      authorLogin?: string;
      riskLevel?: Array<"LOW" | "MODERATE" | "HIGH" | "CRITICAL">;
      status?: Array<"QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED">;
      days?: number;
    };

    const { skip, take } = toSkipTake(query);

    const result = await listAnalyses(req.user(), {
      skip,
      take,
      ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
      ...(query.pullRequestId ? { pullRequestId: query.pullRequestId } : {}),
      ...(query.authorLogin ? { authorLogin: query.authorLogin } : {}),
      ...(query.riskLevel ? { riskLevels: query.riskLevel } : {}),
      ...(query.status ? { statuses: query.status } : {}),
      ...(query.days ? { since: new Date(Date.now() - query.days * 86_400_000) } : {}),
    });

    res.json({
      data: result.items,
      meta: {
        page: query.page,
        perPage: query.perPage,
        total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / query.perPage)),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /analyses/features — the feature registry, for the UI's methodology view
// ---------------------------------------------------------------------------
// Public within the app: it documents what BugDNA measures, which is exactly the
// thing a sceptical reviewer should be able to inspect.
router.get(
  "/features",
  asyncHandler(async (_req, res) => {
    const model = await getModelInfo();
    res.json({
      data: {
        featureSetVersion: FEATURE_SET_VERSION,
        riskBands: RISK_BANDS,
        features: FEATURE_SPECS.map((spec) => ({
          key: spec.key,
          label: spec.label,
          description: spec.description,
          category: spec.category,
          type: spec.type,
          unit: spec.unit ?? null,
          expectedDirection: spec.expectedDirection,
          requiresHistory: spec.requiresHistory ?? false,
        })),
        model,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /analyses/compare?base=&compare=
// ---------------------------------------------------------------------------
router.get(
  "/compare",
  validate({ query: z.object({ base: cuidSchema, compare: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    const { base, compare } = req.query as unknown as { base: string; compare: string };
    res.json({ data: await compareAnalyses(req.user(), base, compare) });
  }),
);

// ---------------------------------------------------------------------------
// GET /analyses/:id
// ---------------------------------------------------------------------------
router.get(
  "/:id",
  validate({ params: z.object({ id: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    res.json({ data: await getAnalysisDetail(req.user(), req.params.id as string) });
  }),
);

// ---------------------------------------------------------------------------
// GET /analyses/:id/status — polling fallback for the realtime stream
// ---------------------------------------------------------------------------
router.get(
  "/:id/status",
  validate({ params: z.object({ id: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    const status = await getAnalysisStatus(req.user(), req.params.id as string);
    // Short-lived cache: this is polled, and a stale second is harmless.
    res.setHeader("cache-control", "private, max-age=1");
    res.json({ data: status });
  }),
);

// ---------------------------------------------------------------------------
// GET /analyses/:id/merge-readiness
// ---------------------------------------------------------------------------
router.get(
  "/:id/merge-readiness",
  validate({ params: z.object({ id: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    res.json({ data: await getMergeReadiness(req.user(), req.params.id as string) });
  }),
);

// ---------------------------------------------------------------------------
// POST /analyses/:id/retry
// ---------------------------------------------------------------------------
router.post(
  "/:id/retry",
  analysisLimiter,
  requireGithubConnection,
  validate({ params: z.object({ id: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    const result = await retryAnalysis(req.user(), req.params.id as string);
    res.status(202).json({ data: result });
  }),
);

// ---------------------------------------------------------------------------
// POST /analyses/:id/cancel
// ---------------------------------------------------------------------------
router.post(
  "/:id/cancel",
  validate({ params: z.object({ id: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    await cancelAnalysis(req.user(), req.params.id as string);
    res.json({ data: { cancelled: true } });
  }),
);

// ---------------------------------------------------------------------------
// POST /analyses/:id/decision — record the merge decision
// ---------------------------------------------------------------------------
router.post(
  "/:id/decision",
  validate({
    params: z.object({ id: cuidSchema }),
    body: z.object({
      decision: z.enum([
        "APPROVED_MERGE",
        "BLOCKED",
        "DEFERRED",
        "OVERRIDDEN",
        "CLOSED_WITHOUT_MERGE",
      ]),
      reason: shortText(2000).optional(),
      addressedRecommendationIds: z.array(cuidSchema).max(50).default([]),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      decision:
        | "APPROVED_MERGE"
        | "BLOCKED"
        | "DEFERRED"
        | "OVERRIDDEN"
        | "CLOSED_WITHOUT_MERGE";
      reason?: string;
      addressedRecommendationIds: string[];
    };

    const result = await recordMergeDecision(req.user(), req.params.id as string, body);
    res.status(201).json({ data: result });
  }),
);

export default router;
