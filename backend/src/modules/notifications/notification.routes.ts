/**
 * Notification routes.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error";
import { requireAuth } from "../../middleware/auth";
import { cuidSchema, paginationSchema, toSkipTake, validate } from "../../middleware/validate";
import {
  dismiss,
  getUnreadCount,
  listNotifications,
  markAllRead,
  markRead,
  type NotificationType,
} from "./notification.service";
import { notFound } from "../../lib/errors";

const router = Router();

router.use(requireAuth);

const typeSchema = z.enum([
  "ANALYSIS_QUEUED",
  "ANALYSIS_COMPLETED",
  "ANALYSIS_FAILED",
  "HIGH_RISK_PR",
  "MERGE_DECISION_RECORDED",
  "DEPLOYMENT_RECORDED",
  "DEPLOYMENT_FAILED",
  "REPOSITORY_CONNECTED",
  "REPOSITORY_SYNC_FAILED",
  "TEAM_MEMBER_ADDED",
  "SYSTEM",
]);

// ---------------------------------------------------------------------------
// GET /notifications
// ---------------------------------------------------------------------------
router.get(
  "/",
  validate({
    query: paginationSchema.extend({
      unreadOnly: z.coerce.boolean().default(false),
      type: z
        .union([typeSchema, z.array(typeSchema)])
        .optional()
        .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      page: number;
      perPage: number;
      unreadOnly: boolean;
      type?: NotificationType[];
    };

    const { skip, take } = toSkipTake(query);

    const result = await listNotifications(req.user().userId, {
      skip,
      take,
      unreadOnly: query.unreadOnly,
      ...(query.type ? { types: query.type } : {}),
    });

    res.json({
      data: result.items,
      meta: {
        page: query.page,
        perPage: query.perPage,
        total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / query.perPage)),
        unreadCount: result.unreadCount,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /notifications/unread-count — polled by the bell badge
// ---------------------------------------------------------------------------
router.get(
  "/unread-count",
  asyncHandler(async (req, res) => {
    res.json({ data: { unreadCount: await getUnreadCount(req.user().userId) } });
  }),
);

// ---------------------------------------------------------------------------
// POST /notifications/read
// ---------------------------------------------------------------------------
router.post(
  "/read",
  validate({ body: z.object({ ids: z.array(cuidSchema).min(1).max(200) }) }),
  asyncHandler(async (req, res) => {
    const { ids } = req.body as { ids: string[] };
    const count = await markRead(req.user().userId, ids);
    res.json({
      data: { marked: count, unreadCount: await getUnreadCount(req.user().userId) },
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /notifications/read-all
// ---------------------------------------------------------------------------
router.post(
  "/read-all",
  asyncHandler(async (req, res) => {
    const count = await markAllRead(req.user().userId);
    res.json({ data: { marked: count, unreadCount: 0 } });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /notifications/:id — dismiss
// ---------------------------------------------------------------------------
router.delete(
  "/:id",
  validate({ params: z.object({ id: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    const ok = await dismiss(req.user().userId, req.params.id as string);
    if (!ok) throw notFound("Notification");
    res.json({
      data: { dismissed: true, unreadCount: await getUnreadCount(req.user().userId) },
    });
  }),
);

export default router;
