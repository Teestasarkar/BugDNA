/**
 * Pull request routes.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error";
import { requireAuth, requireGithubConnection } from "../../middleware/auth";
import {
  cuidSchema,
  paginationSchema,
  toSkipTake,
  validate,
} from "../../middleware/validate";
import {
  getPullRequest,
  getPullRequestDiff,
  listPullRequestAuthors,
  listPullRequests,
} from "./pull.service";
import { listAnalysesForPullRequest } from "../analysis/analysis.service";

const router = Router();

router.use(requireAuth);

const riskLevelSchema = z.enum(["LOW", "MODERATE", "HIGH", "CRITICAL"]);

// ---------------------------------------------------------------------------
// GET /pulls
// ---------------------------------------------------------------------------
router.get(
  "/",
  validate({
    query: paginationSchema.extend({
      repositoryId: cuidSchema.optional(),
      state: z.enum(["OPEN", "CLOSED", "MERGED", "ALL"]).default("OPEN"),
      authorLogin: z.string().trim().max(120).optional(),
      search: z.string().trim().max(200).optional(),
      // Repeated query params arrive as an array; a single one as a string.
      riskLevel: z
        .union([riskLevelSchema, z.array(riskLevelSchema)])
        .optional()
        .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
      unanalysedOnly: z.coerce.boolean().default(false),
      sort: z.enum(["updated", "created", "risk", "size"]).default("updated"),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      page: number;
      perPage: number;
      repositoryId?: string;
      state: "OPEN" | "CLOSED" | "MERGED" | "ALL";
      authorLogin?: string;
      search?: string;
      riskLevel?: Array<"LOW" | "MODERATE" | "HIGH" | "CRITICAL">;
      unanalysedOnly: boolean;
      sort: "updated" | "created" | "risk" | "size";
    };

    const { skip, take } = toSkipTake(query);

    const result = await listPullRequests(req.user(), {
      skip,
      take,
      state: query.state,
      sort: query.sort,
      unanalysedOnly: query.unanalysedOnly,
      ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
      ...(query.authorLogin ? { authorLogin: query.authorLogin } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.riskLevel ? { riskLevels: query.riskLevel } : {}),
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
// GET /pulls/authors — filter options
// ---------------------------------------------------------------------------
router.get(
  "/authors",
  validate({ query: z.object({ repositoryId: cuidSchema.optional() }) }),
  asyncHandler(async (req, res) => {
    const { repositoryId } = req.query as { repositoryId?: string };
    res.json({ data: await listPullRequestAuthors(req.user(), repositoryId) });
  }),
);

// ---------------------------------------------------------------------------
// GET /pulls/:id
// ---------------------------------------------------------------------------
router.get(
  "/:id",
  validate({ params: z.object({ id: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    res.json({ data: await getPullRequest(req.user(), req.params.id as string) });
  }),
);

// ---------------------------------------------------------------------------
// GET /pulls/:id/diff — fetches from GitHub on first access
// ---------------------------------------------------------------------------
router.get(
  "/:id/diff",
  requireGithubConnection,
  validate({
    params: z.object({ id: cuidSchema }),
    query: z.object({ refresh: z.coerce.boolean().default(false) }),
  }),
  asyncHandler(async (req, res) => {
    const { refresh } = req.query as unknown as { refresh: boolean };
    res.json({
      data: await getPullRequestDiff(req.user(), req.params.id as string, { refresh }),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /pulls/:id/analyses — history, for comparison over time
// ---------------------------------------------------------------------------
router.get(
  "/:id/analyses",
  validate({ params: z.object({ id: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    res.json({
      data: await listAnalysesForPullRequest(req.user(), req.params.id as string),
    });
  }),
);

export default router;
