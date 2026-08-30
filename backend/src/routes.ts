/**
 * API router.
 *
 * Every module's router mounted under a single versioned prefix, so the whole
 * public surface of the API is visible in one file.
 */
import { Router } from "express";
import authRoutes from "./modules/auth/auth.routes";
import repositoryRoutes from "./modules/repositories/repository.routes";
import pullRoutes from "./modules/pulls/pull.routes";
import analysisRoutes from "./modules/analysis/analysis.routes";
import analyticsRoutes from "./modules/analytics/analytics.routes";
import teamRoutes from "./modules/teams/team.routes";
import notificationRoutes from "./modules/notifications/notification.routes";
import searchRoutes from "./modules/search/search.routes";
import timelineRoutes from "./modules/timeline/timeline.routes";
import systemRoutes from "./modules/system/system.routes";

const router = Router();

// --- unauthenticated ---------------------------------------------------------
// Health, readiness and deployment config. Mounted first so a failing dependency
// elsewhere cannot make the health check unreachable.
router.use("/system", systemRoutes);

// --- authentication ----------------------------------------------------------
router.use("/auth", authRoutes);

// --- product -----------------------------------------------------------------
// Each of these applies `requireAuth` in its own router, so a route added to any
// of them is authenticated by default rather than by remembering to say so.
router.use("/repositories", repositoryRoutes);
router.use("/pulls", pullRoutes);
router.use("/analyses", analysisRoutes);
router.use("/analytics", analyticsRoutes);
router.use("/teams", teamRoutes);
router.use("/notifications", notificationRoutes);
router.use("/search", searchRoutes);
router.use("/timeline", timelineRoutes);

/** Index: the route map, useful when exploring the API by hand. */
router.get("/", (_req, res) => {
  res.json({
    data: {
      name: "BugDNA API",
      version: "v1",
      endpoints: {
        system: ["/system/health", "/system/ready", "/system/status", "/system/config"],
        auth: [
          "/auth/github",
          "/auth/github/callback",
          "/auth/demo",
          "/auth/me",
          "/auth/session",
          "/auth/logout",
        ],
        repositories: [
          "/repositories",
          "/repositories/available",
          "/repositories/:id",
          "/repositories/:id/sync",
        ],
        pulls: ["/pulls", "/pulls/:id", "/pulls/:id/diff", "/pulls/:id/analyses"],
        analyses: [
          "/analyses",
          "/analyses/:id",
          "/analyses/:id/status",
          "/analyses/:id/merge-readiness",
          "/analyses/:id/decision",
          "/analyses/:id/retry",
          "/analyses/compare",
          "/analyses/features",
        ],
        analytics: [
          "/analytics/overview",
          "/analytics/repositories/:id",
          "/analytics/teams/:teamId",
        ],
        teams: ["/teams", "/teams/:teamId", "/teams/:teamId/members"],
        notifications: ["/notifications", "/notifications/unread-count"],
        search: ["/search?q="],
        timeline: ["/timeline", "/timeline/deployments"],
      },
      realtime: { path: "/socket.io", transports: ["websocket", "polling"] },
      documentation: "https://github.com/Teestasarkar/BugDNA/blob/main/docs/API.md",
    },
  });
});

export default router;
