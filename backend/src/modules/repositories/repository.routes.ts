/**
 * Repository routes.
 *
 * Everything under here requires a session; the tenancy predicate is applied
 * inside the service layer, never here, so a new route cannot forget it.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error";
import { requireAuth, requireGithubConnection } from "../../middleware/auth";
import {
  cuidSchema,
  paginationSchema,
  shortText,
  toSkipTake,
  validate,
} from "../../middleware/validate";
import {
  connectRepository,
  disconnectRepository,
  getRepository,
  listRepositories,
  listRepositoryOptions,
  refreshRepository,
  updateRepository,
} from "./repository.service";
import { listAvailableRepositories } from "../github/github.service";

const router = Router();

router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /repositories/available — browse GitHub for repos to connect
// ---------------------------------------------------------------------------
router.get(
  "/available",
  requireGithubConnection,
  validate({
    query: paginationSchema.extend({
      search: z.string().trim().max(200).optional(),
      sort: z.enum(["created", "updated", "pushed", "full_name"]).default("pushed"),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      page: number;
      perPage: number;
      search?: string;
      sort: "created" | "updated" | "pushed" | "full_name";
    };

    const result = await listAvailableRepositories(req.user().userId, {
      page: query.page,
      perPage: query.perPage,
      sort: query.sort,
      ...(query.search ? { search: query.search } : {}),
    });

    res.json({
      data: result.items,
      meta: {
        page: result.page,
        perPage: result.perPage,
        hasNextPage: result.hasNextPage,
        cached: result.cached,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /repositories/options — lightweight list for filters and pickers
// ---------------------------------------------------------------------------
router.get(
  "/options",
  asyncHandler(async (req, res) => {
    res.json({ data: await listRepositoryOptions(req.user()) });
  }),
);

// ---------------------------------------------------------------------------
// GET /repositories — connected repositories
// ---------------------------------------------------------------------------
router.get(
  "/",
  validate({
    query: paginationSchema.extend({
      search: z.string().trim().max(200).optional(),
      teamId: cuidSchema.optional(),
      includeInactive: z.coerce.boolean().default(false),
      sort: z.enum(["recent", "risk", "name", "activity"]).default("recent"),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      page: number;
      perPage: number;
      search?: string;
      teamId?: string;
      includeInactive: boolean;
      sort: "recent" | "risk" | "name" | "activity";
    };

    const { skip, take } = toSkipTake(query);
    const result = await listRepositories(req.user(), {
      skip,
      take,
      sort: query.sort,
      includeInactive: query.includeInactive,
      ...(query.search ? { search: query.search } : {}),
      ...(query.teamId ? { teamId: query.teamId } : {}),
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
// POST /repositories — connect one
// ---------------------------------------------------------------------------
router.post(
  "/",
  requireGithubConnection,
  validate({
    body: z.object({
      owner: shortText(120),
      name: shortText(200),
      teamId: cuidSchema.optional(),
      autoAnalyze: z.boolean().default(true),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      owner: string;
      name: string;
      teamId?: string;
      autoAnalyze: boolean;
    };

    const result = await connectRepository(req.user(), body);
    res.status(201).json({ data: result });
  }),
);

// ---------------------------------------------------------------------------
// GET /repositories/:id
// ---------------------------------------------------------------------------
router.get(
  "/:id",
  validate({ params: z.object({ id: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    res.json({ data: await getRepository(req.user(), req.params.id as string) });
  }),
);

// ---------------------------------------------------------------------------
// PATCH /repositories/:id
// ---------------------------------------------------------------------------
router.patch(
  "/:id",
  validate({
    params: z.object({ id: cuidSchema }),
    body: z.object({
      autoAnalyze: z.boolean().optional(),
      teamId: cuidSchema.nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as { autoAnalyze?: boolean; teamId?: string | null };
    res.json({ data: await updateRepository(req.user(), req.params.id as string, body) });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /repositories/:id — disconnect (non-destructive)
// ---------------------------------------------------------------------------
router.delete(
  "/:id",
  validate({ params: z.object({ id: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    res.json({ data: await disconnectRepository(req.user(), req.params.id as string) });
  }),
);

// ---------------------------------------------------------------------------
// POST /repositories/:id/sync — re-pull pull requests
// ---------------------------------------------------------------------------
router.post(
  "/:id/sync",
  requireGithubConnection,
  validate({
    params: z.object({ id: cuidSchema }),
    body: z
      .object({ state: z.enum(["open", "closed", "all"]).default("open") })
      .default({ state: "open" }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as { state: "open" | "closed" | "all" };
    const result = await refreshRepository(req.user(), req.params.id as string, {
      state: body.state,
    });
    res.json({ data: result });
  }),
);

export default router;
