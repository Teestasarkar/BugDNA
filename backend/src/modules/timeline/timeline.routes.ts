/**
 * Timeline and deployment routes.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error";
import { requireAuth, requireGithubConnection } from "../../middleware/auth";
import {
  cuidSchema,
  daysSchema,
  paginationSchema,
  shortText,
  toSkipTake,
  validate,
} from "../../middleware/validate";
import {
  getTimeline,
  listDeployments,
  recordDeployment,
  reportDeploymentOutcome,
  syncDeployments,
} from "./timeline.service";

const router = Router();

router.use(requireAuth);

const environmentSchema = z.enum(["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"]);
const eventTypeSchema = z.enum(["DEPLOYMENT", "PULL_REQUEST_MERGED", "ANALYSIS"]);

/** Repeated query params arrive as arrays; a single one as a scalar. */
const multi = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .union([schema, z.array(schema)])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));

// ---------------------------------------------------------------------------
// GET /timeline
// ---------------------------------------------------------------------------
router.get(
  "/",
  validate({
    query: z.object({
      repositoryId: cuidSchema.optional(),
      days: daysSchema,
      environment: multi(environmentSchema),
      type: multi(eventTypeSchema),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      repositoryId?: string;
      days: number;
      environment?: Array<"PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT">;
      type?: Array<"DEPLOYMENT" | "PULL_REQUEST_MERGED" | "ANALYSIS">;
      limit: number;
    };

    res.json({
      data: await getTimeline(req.user(), {
        days: query.days,
        limit: query.limit,
        ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
        ...(query.environment ? { environments: query.environment } : {}),
        ...(query.type ? { types: query.type } : {}),
      }),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /timeline/deployments
// ---------------------------------------------------------------------------
router.get(
  "/deployments",
  validate({
    query: paginationSchema.extend({ repositoryId: cuidSchema.optional() }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      page: number;
      perPage: number;
      repositoryId?: string;
    };
    const { skip, take } = toSkipTake(query);

    const result = await listDeployments(req.user(), {
      skip,
      take,
      ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
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
// POST /timeline/deployments — record one manually
// ---------------------------------------------------------------------------
router.post(
  "/deployments",
  validate({
    body: z.object({
      repositoryId: cuidSchema,
      sha: z.string().trim().min(7).max(40),
      environment: environmentSchema.default("PRODUCTION"),
      status: z
        .enum(["PENDING", "IN_PROGRESS", "SUCCESS", "FAILURE", "ROLLED_BACK", "CANCELLED"])
        .default("SUCCESS"),
      ref: shortText(200).optional(),
      description: shortText(1000).optional(),
      startedAt: z.coerce.date().optional(),
      finishedAt: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as Parameters<typeof recordDeployment>[1];
    res.status(201).json({ data: await recordDeployment(req.user(), body) });
  }),
);

// ---------------------------------------------------------------------------
// POST /timeline/deployments/:id/outcome — report an incident (ground truth)
// ---------------------------------------------------------------------------
router.post(
  "/deployments/:id/outcome",
  validate({
    params: z.object({ id: cuidSchema }),
    body: z.object({
      causedIncident: z.boolean(),
      incidentSummary: shortText(2000).optional(),
      incidentSeverity: z.enum(["SEV1", "SEV2", "SEV3", "SEV4"]).optional(),
      status: z.enum(["SUCCESS", "FAILURE", "ROLLED_BACK"]).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as Parameters<typeof reportDeploymentOutcome>[2];
    res.json({
      data: await reportDeploymentOutcome(req.user(), req.params.id as string, body),
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /timeline/deployments/sync — pull from the GitHub Deployments API
// ---------------------------------------------------------------------------
router.post(
  "/deployments/sync",
  requireGithubConnection,
  validate({ body: z.object({ repositoryId: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    const { repositoryId } = req.body as { repositoryId: string };
    res.json({ data: await syncDeployments(req.user(), repositoryId) });
  }),
);

export default router;
