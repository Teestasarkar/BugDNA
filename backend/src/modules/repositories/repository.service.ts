/**
 * Repository service.
 *
 * "Connecting" a repository is the moment BugDNA takes responsibility for it:
 * we mirror its metadata, pull its open pull requests so the user has something
 * to look at immediately, and start counting it in the analytics. Disconnecting
 * is deliberately non-destructive — past analyses are evidence, and deleting a
 * team's risk history because someone unticked a repository would be surprising.
 */
import { Prisma, prisma } from "../../lib/prisma";
import { scoped } from "../../lib/logger";
import { cacheDelPattern } from "../../lib/cache";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { getProvider, getUserToken, syncPullRequests } from "../github/github.service";
import { createNotification } from "../notifications/notification.service";
import { publishEvent } from "../../realtime/bus";
import { EVENT, ROOM } from "../../realtime/events";
import {
  assertRepositoryAccess,
  assertTeamAccess,
  repositoryAccessWhere,
} from "./repository.access";
import type { AuthContext } from "../../types/express";

const log = scoped("repository-service");

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export interface ConnectRepositoryInput {
  /** Either `owner`/`name`, or the GitHub numeric id. */
  owner?: string;
  name?: string;
  githubId?: string;
  /** Share the repository with a team the caller belongs to. */
  teamId?: string;
  autoAnalyze?: boolean;
}

export async function connectRepository(
  auth: AuthContext,
  input: ConnectRepositoryInput,
): Promise<{ repositoryId: string; fullName: string; pullRequestsSynced: number }> {
  if (!input.owner || !input.name) {
    throw badRequest("Both `owner` and `name` are required to connect a repository.");
  }

  if (input.teamId) {
    // Refuses rather than silently dropping the team: a user who intended to
    // share a repository should be told it did not happen.
    await assertTeamAccess(auth, input.teamId);
  }

  const token = await getUserToken(auth.userId);
  const provider = getProvider();

  // Fetch from GitHub first: this both validates access and gives us the
  // metadata to mirror. If the user cannot read it, we never create a row.
  const ghRepo = await provider.getRepository(token, input.owner, input.name);

  if (ghRepo.archived || ghRepo.disabled) {
    throw badRequest(
      `${ghRepo.full_name} is archived on GitHub, so no new pull requests can be analysed.`,
    );
  }

  // The diff endpoints need pull access; connecting without it would create a
  // repository whose every analysis fails.
  if (ghRepo.permissions && !ghRepo.permissions.pull) {
    throw badRequest(
      `Your GitHub authorization cannot read the contents of ${ghRepo.full_name}. ` +
        `Reconnect GitHub and grant the "repo" scope.`,
    );
  }

  const existing = await prisma.repository.findUnique({
    where: { ownerUserId_githubId: { ownerUserId: auth.userId, githubId: BigInt(ghRepo.id) } },
    select: { id: true, isActive: true },
  });

  if (existing?.isActive) {
    throw conflict(`${ghRepo.full_name} is already connected.`);
  }

  const data = {
    githubId: BigInt(ghRepo.id),
    owner: ghRepo.owner.login,
    name: ghRepo.name,
    fullName: ghRepo.full_name,
    private: ghRepo.private,
    description: ghRepo.description?.slice(0, 2000) ?? null,
    defaultBranch: ghRepo.default_branch,
    language: ghRepo.language,
    htmlUrl: ghRepo.html_url,
    homepage: ghRepo.homepage,
    stars: ghRepo.stargazers_count,
    forks: ghRepo.forks_count,
    openIssues: ghRepo.open_issues_count,
    sizeKb: ghRepo.size,
    teamId: input.teamId ?? null,
    autoAnalyze: input.autoAnalyze ?? true,
    isActive: true,
    syncError: null,
    githubCreatedAt: ghRepo.created_at ? new Date(ghRepo.created_at) : null,
    githubPushedAt: ghRepo.pushed_at ? new Date(ghRepo.pushed_at) : null,
  };

  // Reconnecting a previously disconnected repository reuses the row, so its
  // analysis history reattaches instead of being orphaned.
  const repository = existing
    ? await prisma.repository.update({
        where: { id: existing.id },
        data: { ...data, connectedAt: new Date() },
        select: { id: true, fullName: true },
      })
    : await prisma.repository.create({
        data: { ...data, ownerUserId: auth.userId },
        select: { id: true, fullName: true },
      });

  // Pull the open PRs now so the repository is not empty when the user arrives.
  // A sync failure must not undo the connection — it is recorded and retryable.
  let pullRequestsSynced = 0;
  try {
    const result = await syncPullRequests(auth.userId, repository.id, { state: "open" });
    pullRequestsSynced = result.synced;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn({ err: message, repositoryId: repository.id }, "initial PR sync failed");
    await prisma.repository.update({
      where: { id: repository.id },
      data: { syncError: message.slice(0, 1000) },
    });
  }

  await cacheDelPattern(`cache:gh:repos:${auth.userId}:*`);
  await cacheDelPattern("cache:dashboard:*");

  await createNotification({
    userId: auth.userId,
    type: "REPOSITORY_CONNECTED",
    severity: "SUCCESS",
    title: `Connected ${repository.fullName}`,
    body:
      pullRequestsSynced > 0
        ? `${pullRequestsSynced} open pull request${pullRequestsSynced === 1 ? "" : "s"} found and ready to analyse.`
        : "No open pull requests found yet.",
    href: `/repositories/${repository.id}`,
    repositoryId: repository.id,
  });

  log.info(
    { repositoryId: repository.id, fullName: repository.fullName, pullRequestsSynced },
    "repository connected",
  );

  return { repositoryId: repository.id, fullName: repository.fullName, pullRequestsSynced };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ListRepositoriesFilters {
  search?: string;
  teamId?: string;
  includeInactive?: boolean;
  skip?: number;
  take?: number;
  sort?: "recent" | "risk" | "name" | "activity";
}

/**
 * Connected repositories, each with the rollup the list view shows.
 *
 * The per-repository aggregates are computed in two grouped queries rather than
 * per row, so the list stays a fixed number of round trips regardless of how
 * many repositories a user has connected.
 */
export async function listRepositories(auth: AuthContext, filters: ListRepositoriesFilters = {}) {
  // Composed with an explicit AND rather than object spread. The tenancy
  // predicate is itself an `OR`, and a search filter contributes another — as a
  // single flat object the second `OR` key would silently replace the first,
  // widening every query past the tenancy boundary. AND-ing the clauses makes
  // that mistake unrepresentable.
  const where: Prisma.RepositoryWhereInput = {
    AND: [
      repositoryAccessWhere(auth),
      ...(filters.includeInactive ? [] : [{ isActive: true }]),
      ...(filters.teamId ? [{ teamId: filters.teamId }] : []),
      ...(filters.search
        ? [
            {
              OR: [
                { fullName: { contains: filters.search, mode: "insensitive" as const } },
                { description: { contains: filters.search, mode: "insensitive" as const } },
              ],
            },
          ]
        : []),
    ],
  };

  const orderBy =
    filters.sort === "name"
      ? ({ fullName: "asc" } as const)
      : filters.sort === "activity"
        ? ({ githubPushedAt: "desc" } as const)
        : ({ connectedAt: "desc" } as const);

  const [repositories, total] = await Promise.all([
    prisma.repository.findMany({
      where,
      orderBy,
      skip: filters.skip ?? 0,
      take: filters.take ?? 20,
      select: {
        id: true,
        owner: true,
        name: true,
        fullName: true,
        private: true,
        description: true,
        language: true,
        defaultBranch: true,
        htmlUrl: true,
        stars: true,
        isActive: true,
        autoAnalyze: true,
        connectedAt: true,
        lastSyncedAt: true,
        syncError: true,
        githubPushedAt: true,
        team: { select: { id: true, name: true, slug: true } },
        _count: { select: { pullRequests: true, analyses: true, deployments: true } },
      },
    }),
    prisma.repository.count({ where }),
  ]);

  const repositoryIds = repositories.map((r) => r.id);
  const stats = await loadRepositoryRollups(repositoryIds);

  return {
    items: repositories.map((repository) => ({
      ...repository,
      connectedAt: repository.connectedAt.toISOString(),
      lastSyncedAt: repository.lastSyncedAt?.toISOString() ?? null,
      githubPushedAt: repository.githubPushedAt?.toISOString() ?? null,
      counts: {
        pullRequests: repository._count.pullRequests,
        analyses: repository._count.analyses,
        deployments: repository._count.deployments,
      },
      stats: stats.get(repository.id) ?? emptyRollup(),
    })),
    total,
  };
}

export interface RepositoryRollup {
  openPullRequests: number;
  analysedPullRequests: number;
  avgRiskScore: number | null;
  highRiskOpen: number;
  lastAnalysisAt: string | null;
  latestRiskLevel: string | null;
}

const emptyRollup = (): RepositoryRollup => ({
  openPullRequests: 0,
  analysedPullRequests: 0,
  avgRiskScore: null,
  highRiskOpen: 0,
  lastAnalysisAt: null,
  latestRiskLevel: null,
});

/** Grouped aggregates for a set of repositories, in a fixed number of queries. */
async function loadRepositoryRollups(
  repositoryIds: string[],
): Promise<Map<string, RepositoryRollup>> {
  const result = new Map<string, RepositoryRollup>();
  if (repositoryIds.length === 0) return result;

  const [openPrs, riskAgg, latestAnalyses, highRisk] = await Promise.all([
    prisma.pullRequest.groupBy({
      by: ["repositoryId"],
      where: { repositoryId: { in: repositoryIds }, state: "OPEN" },
      _count: { _all: true },
    }),
    prisma.analysis.groupBy({
      by: ["repositoryId"],
      where: { repositoryId: { in: repositoryIds }, status: "COMPLETED" },
      _avg: { riskScore: true },
      _count: { _all: true },
      _max: { completedAt: true },
    }),
    prisma.analysis.findMany({
      where: { repositoryId: { in: repositoryIds }, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      distinct: ["repositoryId"],
      select: { repositoryId: true, riskLevel: true, completedAt: true },
    }),
    prisma.analysis.groupBy({
      by: ["repositoryId"],
      where: {
        repositoryId: { in: repositoryIds },
        status: "COMPLETED",
        riskLevel: { in: ["HIGH", "CRITICAL"] },
        pullRequest: { state: "OPEN" },
      },
      _count: { _all: true },
    }),
  ]);

  for (const id of repositoryIds) result.set(id, emptyRollup());

  for (const row of openPrs) {
    const entry = result.get(row.repositoryId);
    if (entry) entry.openPullRequests = row._count._all;
  }

  for (const row of riskAgg) {
    const entry = result.get(row.repositoryId);
    if (!entry) continue;
    entry.analysedPullRequests = row._count._all;
    entry.avgRiskScore =
      row._avg.riskScore !== null ? Math.round(row._avg.riskScore * 10) / 10 : null;
    entry.lastAnalysisAt = row._max.completedAt?.toISOString() ?? null;
  }

  for (const row of latestAnalyses) {
    const entry = result.get(row.repositoryId);
    if (entry) entry.latestRiskLevel = row.riskLevel;
  }

  for (const row of highRisk) {
    const entry = result.get(row.repositoryId);
    if (entry) entry.highRiskOpen = row._count._all;
  }

  return result;
}

/** Repository detail for the repository page header. */
export async function getRepository(auth: AuthContext, repositoryId: string) {
  const repository = await prisma.repository.findFirst({
    where: { id: repositoryId, ...repositoryAccessWhere(auth) },
    select: {
      id: true,
      githubId: true,
      owner: true,
      name: true,
      fullName: true,
      private: true,
      description: true,
      defaultBranch: true,
      language: true,
      htmlUrl: true,
      homepage: true,
      stars: true,
      forks: true,
      openIssues: true,
      isActive: true,
      autoAnalyze: true,
      connectedAt: true,
      lastSyncedAt: true,
      syncError: true,
      githubCreatedAt: true,
      githubPushedAt: true,
      ownerUser: { select: { githubLogin: true, avatarUrl: true } },
      team: { select: { id: true, name: true, slug: true } },
      _count: { select: { pullRequests: true, analyses: true, deployments: true } },
    },
  });

  if (!repository) throw notFound("Repository");

  const stats = await loadRepositoryRollups([repository.id]);

  return {
    ...repository,
    connectedAt: repository.connectedAt.toISOString(),
    lastSyncedAt: repository.lastSyncedAt?.toISOString() ?? null,
    githubCreatedAt: repository.githubCreatedAt?.toISOString() ?? null,
    githubPushedAt: repository.githubPushedAt?.toISOString() ?? null,
    counts: {
      pullRequests: repository._count.pullRequests,
      analyses: repository._count.analyses,
      deployments: repository._count.deployments,
    },
    stats: stats.get(repository.id) ?? emptyRollup(),
  };
}

// ---------------------------------------------------------------------------
// Mutate
// ---------------------------------------------------------------------------

export async function updateRepository(
  auth: AuthContext,
  repositoryId: string,
  input: { autoAnalyze?: boolean; teamId?: string | null },
) {
  await assertRepositoryAccess(auth, repositoryId);

  if (input.teamId) await assertTeamAccess(auth, input.teamId);

  await prisma.repository.update({
    where: { id: repositoryId },
    data: {
      ...(input.autoAnalyze !== undefined ? { autoAnalyze: input.autoAnalyze } : {}),
      ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
    },
  });

  await cacheDelPattern("cache:dashboard:*");
  return getRepository(auth, repositoryId);
}

/**
 * Disconnect without deleting.
 *
 * Marks the repository inactive so it stops appearing in the working set and no
 * longer syncs, while its pull requests, analyses and deployment history remain
 * queryable. Reconnecting restores it intact.
 */
export async function disconnectRepository(
  auth: AuthContext,
  repositoryId: string,
): Promise<{ disconnected: true; analysesRetained: number }> {
  await assertRepositoryAccess(auth, repositoryId);

  const analysesRetained = await prisma.analysis.count({ where: { repositoryId } });

  await prisma.repository.update({
    where: { id: repositoryId },
    data: { isActive: false, autoAnalyze: false },
  });

  await cacheDelPattern(`cache:analytics:repo:${repositoryId}:*`);
  await cacheDelPattern("cache:dashboard:*");

  log.info({ repositoryId, analysesRetained }, "repository disconnected");
  return { disconnected: true, analysesRetained };
}

/** Re-pull pull requests from GitHub on demand. */
export async function refreshRepository(
  auth: AuthContext,
  repositoryId: string,
  options: { state?: "open" | "closed" | "all" } = {},
) {
  const repository = await assertRepositoryAccess(auth, repositoryId);

  try {
    const result = await syncPullRequests(auth.userId, repositoryId, {
      state: options.state ?? "open",
      perPage: 50,
    });

    await publishEvent({
      name: EVENT.repositorySynced,
      rooms: [ROOM.repository(repositoryId), ROOM.user(auth.userId)],
      payload: {
        repositoryId,
        fullName: repository.fullName,
        pullRequestsSynced: result.synced,
        syncedAt: new Date().toISOString(),
      },
    });

    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);

    await prisma.repository.update({
      where: { id: repositoryId },
      data: { syncError: message.slice(0, 1000) },
    });

    await publishEvent({
      name: EVENT.repositorySyncFailed,
      rooms: [ROOM.repository(repositoryId), ROOM.user(auth.userId)],
      payload: {
        repositoryId,
        fullName: repository.fullName,
        errorCode: "REPOSITORY_SYNC_FAILED",
        errorMessage: message,
        retryable: true,
      },
    });

    throw e;
  }
}

/** Repositories the dashboard needs, without the full rollup. */
export async function listRepositoryOptions(auth: AuthContext) {
  return prisma.repository.findMany({
    where: { ...repositoryAccessWhere(auth), isActive: true },
    orderBy: { fullName: "asc" },
    select: { id: true, fullName: true, language: true, private: true },
    take: 200,
  });
}
