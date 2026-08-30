/**
 * Analytics routes.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error";
import { requireAuth } from "../../middleware/auth";
import { cuidSchema, daysSchema, validate } from "../../middleware/validate";
import {
  getDashboardOverview,
  getRepositoryHealth,
  getRepositorySnapshots,
  getTeamDashboard,
} from "./analytics.service";

const router = Router();

router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /analytics/overview — the dashboard
// ---------------------------------------------------------------------------
router.get(
  "/overview",
  validate({ query: z.object({ days: daysSchema }) }),
  asyncHandler(async (req, res) => {
    const { days } = req.query as unknown as { days: number };
    res.json({ data: await getDashboardOverview(req.user(), days) });
  }),
);

// ---------------------------------------------------------------------------
// GET /analytics/repositories/:id — repository health
// ---------------------------------------------------------------------------
router.get(
  "/repositories/:id",
  validate({
    params: z.object({ id: cuidSchema }),
    query: z.object({ days: daysSchema }),
  }),
  asyncHandler(async (req, res) => {
    const { days } = req.query as unknown as { days: number };
    res.json({
      data: await getRepositoryHealth(req.user(), req.params.id as string, days),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /analytics/repositories/:id/snapshots — long-range trend
// ---------------------------------------------------------------------------
router.get(
  "/repositories/:id/snapshots",
  validate({
    params: z.object({ id: cuidSchema }),
    query: z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }),
  }),
  asyncHandler(async (req, res) => {
    const { days } = req.query as unknown as { days: number };
    res.json({
      data: await getRepositorySnapshots(req.user(), req.params.id as string, days),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /analytics/teams/:teamId — team dashboard
// ---------------------------------------------------------------------------
router.get(
  "/teams/:teamId",
  validate({
    params: z.object({ teamId: cuidSchema }),
    query: z.object({ days: daysSchema }),
  }),
  asyncHandler(async (req, res) => {
    const { days } = req.query as unknown as { days: number };
    res.json({
      data: await getTeamDashboard(req.user(), req.params.teamId as string, days),
    });
  }),
);

export default router;
