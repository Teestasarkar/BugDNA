/**
 * Teams.
 *
 * Small module, but it is what makes BugDNA usable by a startup engineering team
 * rather than one developer: a team is the unit that shares repositories, and
 * team membership is the second half of the tenancy predicate.
 *
 * Service logic is inline here because each operation is a handful of lines and
 * splitting it across two files would obscure rather than clarify.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../middleware/error";
import { requireAuth, requireTeamRole } from "../../middleware/auth";
import { cuidSchema, shortText, validate } from "../../middleware/validate";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { assertTeamAccess } from "../repositories/repository.access";
import { createNotification } from "../notifications/notification.service";
import { invalidateAuthCache } from "../auth/session.service";
import { cacheDelPattern } from "../../lib/cache";
import { scoped } from "../../lib/logger";

const log = scoped("teams");
const router = Router();

router.use(requireAuth);

/** URL-safe slug from a team name, with a short random suffix on collision. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "team";
}

// ---------------------------------------------------------------------------
// GET /teams — teams the caller belongs to
// ---------------------------------------------------------------------------
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const auth = req.user();

    const memberships = await prisma.teamMember.findMany({
      where: { userId: auth.userId },
      orderBy: { joinedAt: "asc" },
      select: {
        role: true,
        joinedAt: true,
        team: {
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            avatarUrl: true,
            createdAt: true,
            owner: { select: { githubLogin: true, avatarUrl: true } },
            _count: { select: { members: true, repositories: true } },
          },
        },
      },
    });

    res.json({
      data: memberships.map((m) => ({
        ...m.team,
        createdAt: m.team.createdAt.toISOString(),
        role: m.role,
        joinedAt: m.joinedAt.toISOString(),
        counts: {
          members: m.team._count.members,
          repositories: m.team._count.repositories,
        },
      })),
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /teams — create
// ---------------------------------------------------------------------------
router.post(
  "/",
  validate({
    body: z.object({
      name: shortText(80),
      description: shortText(500).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const auth = req.user();
    const body = req.body as { name: string; description?: string };

    // Slugs are globally unique; append a suffix rather than rejecting a
    // perfectly reasonable team name someone else happens to share.
    const base = slugify(body.name);
    let slug = base;
    for (let attempt = 0; attempt < 5; attempt++) {
      const taken = await prisma.team.findUnique({ where: { slug }, select: { id: true } });
      if (!taken) break;
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    }

    const team = await prisma.team.create({
      data: {
        name: body.name,
        slug,
        description: body.description ?? null,
        ownerId: auth.userId,
        // The creator is a member with the OWNER role, so membership queries do
        // not need a special case for ownership.
        members: { create: { userId: auth.userId, role: "OWNER" } },
      },
      select: { id: true, name: true, slug: true, description: true, createdAt: true },
    });

    // The caller's cached auth context no longer lists their teams correctly.
    await invalidateAuthCache(auth.sessionId);

    log.info({ teamId: team.id, slug, by: auth.githubLogin }, "team created");
    res.status(201).json({ data: { ...team, createdAt: team.createdAt.toISOString() } });
  }),
);

// ---------------------------------------------------------------------------
// GET /teams/:teamId
// ---------------------------------------------------------------------------
router.get(
  "/:teamId",
  validate({ params: z.object({ teamId: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    const auth = req.user();
    const teamId = req.params.teamId as string;

    const membership = await assertTeamAccess(auth, teamId);

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        avatarUrl: true,
        createdAt: true,
        owner: { select: { id: true, githubLogin: true, avatarUrl: true, name: true } },
        members: {
          orderBy: { joinedAt: "asc" },
          select: {
            role: true,
            joinedAt: true,
            user: {
              select: {
                id: true,
                githubLogin: true,
                name: true,
                avatarUrl: true,
                lastSeenAt: true,
              },
            },
          },
        },
        repositories: {
          where: { isActive: true },
          orderBy: { fullName: "asc" },
          select: {
            id: true,
            fullName: true,
            language: true,
            private: true,
            _count: { select: { pullRequests: true, analyses: true } },
          },
        },
      },
    });

    if (!team) throw notFound("Team");

    res.json({
      data: {
        ...team,
        createdAt: team.createdAt.toISOString(),
        viewerRole: membership.role,
        members: team.members.map((m) => ({
          ...m.user,
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
          lastSeenAt: m.user.lastSeenAt?.toISOString() ?? null,
        })),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// PATCH /teams/:teamId
// ---------------------------------------------------------------------------
router.patch(
  "/:teamId",
  validate({
    params: z.object({ teamId: cuidSchema }),
    body: z.object({
      name: shortText(80).optional(),
      description: shortText(500).nullable().optional(),
    }),
  }),
  requireTeamRole("OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const body = req.body as { name?: string; description?: string | null };

    const team = await prisma.team.update({
      where: { id: req.params.teamId as string },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      },
      select: { id: true, name: true, slug: true, description: true },
    });

    await cacheDelPattern(`cache:analytics:team:${team.id}:*`);
    res.json({ data: team });
  }),
);

// ---------------------------------------------------------------------------
// POST /teams/:teamId/members — add by GitHub login
// ---------------------------------------------------------------------------
// The invitee must already have a BugDNA account. Inviting a stranger by email
// would mean sending mail, which this deployment has no transport for — so the
// error says exactly that rather than silently doing nothing.
router.post(
  "/:teamId/members",
  validate({
    params: z.object({ teamId: cuidSchema }),
    body: z.object({
      githubLogin: shortText(120),
      role: z.enum(["ADMIN", "MEMBER", "VIEWER"]).default("MEMBER"),
    }),
  }),
  requireTeamRole("OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const auth = req.user();
    const teamId = req.params.teamId as string;
    const body = req.body as { githubLogin: string; role: "ADMIN" | "MEMBER" | "VIEWER" };

    const invitee = await prisma.user.findUnique({
      where: { githubLogin: body.githubLogin },
      select: { id: true, githubLogin: true, name: true, avatarUrl: true },
    });

    if (!invitee) {
      throw badRequest(
        `${body.githubLogin} has not signed in to BugDNA yet. ` +
          `Ask them to sign in with GitHub first, then add them to the team.`,
      );
    }

    const existing = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: invitee.id } },
      select: { id: true },
    });

    if (existing) throw conflict(`${invitee.githubLogin} is already a member of this team.`);

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });

    await prisma.teamMember.create({
      data: { teamId, userId: invitee.id, role: body.role },
    });

    await createNotification({
      userId: invitee.id,
      type: "TEAM_MEMBER_ADDED",
      severity: "INFO",
      title: `You were added to ${team?.name ?? "a team"}`,
      body: `${auth.githubLogin} added you as ${body.role.toLowerCase()}.`,
      href: `/teams/${teamId}`,
    });

    await cacheDelPattern(`cache:analytics:team:${teamId}:*`);

    log.info(
      { teamId, added: invitee.githubLogin, role: body.role, by: auth.githubLogin },
      "team member added",
    );

    res.status(201).json({ data: { ...invitee, role: body.role } });
  }),
);

// ---------------------------------------------------------------------------
// PATCH /teams/:teamId/members/:userId — change role
// ---------------------------------------------------------------------------
router.patch(
  "/:teamId/members/:userId",
  validate({
    params: z.object({ teamId: cuidSchema, userId: cuidSchema }),
    body: z.object({ role: z.enum(["ADMIN", "MEMBER", "VIEWER"]) }),
  }),
  requireTeamRole("OWNER"),
  asyncHandler(async (req, res) => {
    const teamId = req.params.teamId as string;
    const userId = req.params.userId as string;
    const { role } = req.body as { role: "ADMIN" | "MEMBER" | "VIEWER" };

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { ownerId: true },
    });

    // The owner's own role is structural, not editable — demoting themselves
    // would leave the team with nobody able to administer it.
    if (team?.ownerId === userId) {
      throw badRequest(
        "The team owner's role cannot be changed. Transfer ownership first.",
      );
    }

    const updated = await prisma.teamMember.updateMany({
      where: { teamId, userId },
      data: { role },
    });

    if (updated.count === 0) throw notFound("Team member");

    res.json({ data: { userId, role } });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /teams/:teamId/members/:userId
// ---------------------------------------------------------------------------
router.delete(
  "/:teamId/members/:userId",
  validate({ params: z.object({ teamId: cuidSchema, userId: cuidSchema }) }),
  requireTeamRole("OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const teamId = req.params.teamId as string;
    const userId = req.params.userId as string;

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { ownerId: true },
    });

    if (team?.ownerId === userId) {
      throw badRequest("The team owner cannot be removed. Transfer ownership first.");
    }

    const removed = await prisma.teamMember.deleteMany({ where: { teamId, userId } });
    if (removed.count === 0) throw notFound("Team member");

    await cacheDelPattern(`cache:analytics:team:${teamId}:*`);
    res.json({ data: { removed: true } });
  }),
);

// ---------------------------------------------------------------------------
// POST /teams/:teamId/leave
// ---------------------------------------------------------------------------
router.post(
  "/:teamId/leave",
  validate({ params: z.object({ teamId: cuidSchema }) }),
  asyncHandler(async (req, res) => {
    const auth = req.user();
    const teamId = req.params.teamId as string;

    await assertTeamAccess(auth, teamId);

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { ownerId: true },
    });

    if (team?.ownerId === auth.userId) {
      throw badRequest(
        "You own this team. Transfer ownership or delete the team instead of leaving.",
      );
    }

    await prisma.teamMember.deleteMany({ where: { teamId, userId: auth.userId } });
    await invalidateAuthCache(auth.sessionId);

    res.json({ data: { left: true } });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /teams/:teamId
// ---------------------------------------------------------------------------
// Repositories shared with the team are unlinked (`teamId` becomes null by the
// schema's `onDelete: SetNull`) rather than deleted — they still belong to the
// user who connected them.
router.delete(
  "/:teamId",
  validate({ params: z.object({ teamId: cuidSchema }) }),
  requireTeamRole("OWNER"),
  asyncHandler(async (req, res) => {
    const teamId = req.params.teamId as string;

    const repositoriesUnlinked = await prisma.repository.count({ where: { teamId } });
    await prisma.team.delete({ where: { id: teamId } });

    await invalidateAuthCache(req.user().sessionId);
    await cacheDelPattern(`cache:analytics:team:${teamId}:*`);

    res.json({ data: { deleted: true, repositoriesUnlinked } });
  }),
);

export default router;
