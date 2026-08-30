/**
 * Pull request service.
 *
 * Reads the mirrored PR data, each row annotated with its latest analysis so the
 * PR list can show a risk badge without a second round trip. This is the screen
 * a developer lands on most often, so the query shape matters.
 */
import { Prisma, prisma } from "../../lib/prisma";
import { notFound } from "../../lib/errors";
import { env } from "../../config/env";
import { ingestPullRequestDiff } from "../github/github.service";
import {
  assertPullRequestAccess,
  assertRepositoryAccess,
  repositoryAccessWhere,
} from "../repositories/repository.access";
import type { AuthContext } from "../../types/express";

export interface ListPullRequestsFilters {
  repositoryId?: string;
  state?: "OPEN" | "CLOSED" | "MERGED" | "ALL";
  authorLogin?: string;
  search?: string;
  /** Only PRs whose latest analysis is at one of these levels. */
  riskLevels?: Array<"LOW" | "MODERATE" | "HIGH" | "CRITICAL">;
  /** Only PRs that have never been analysed. */
  unanalysedOnly?: boolean;
  skip?: number;
  take?: number;
  sort?: "updated" | "created" | "risk" | "size";
}

/**
 * List pull requests with their latest analysis attached.
 *
 * The latest analysis is fetched with `distinct` on `pullRequestId` rather than a
 * correlated subquery per row, so cost stays flat as the page grows.
 */
export async function listPullRequests(
  auth: AuthContext,
  filters: ListPullRequestsFilters = {},
) {
  if (filters.repositoryId) {
    await assertRepositoryAccess(auth, filters.repositoryId);
  }

  // AND-composed: both the tenancy predicate and `search` contribute an `OR`.
  const where: Prisma.PullRequestWhereInput = {
    AND: [
      { repository: repositoryAccessWhere(auth) },
      ...(filters.repositoryId ? [{ repositoryId: filters.repositoryId }] : []),
      ...(filters.state && filters.state !== "ALL" ? [{ state: filters.state }] : []),
      ...(filters.authorLogin ? [{ authorLogin: filters.authorLogin }] : []),
      ...(filters.search
        ? [
            {
              OR: [
                { title: { contains: filters.search, mode: "insensitive" as const } },
                { headRef: { contains: filters.search, mode: "insensitive" as const } },
                { authorLogin: { contains: filters.search, mode: "insensitive" as const } },
              ],
            },
          ]
        : []),
      ...(filters.unanalysedOnly ? [{ analyses: { none: {} } }] : []),
      ...(filters.riskLevels?.length
        ? [
            {
              analyses: {
                some: {
                  status: "COMPLETED" as const,
                  riskLevel: { in: filters.riskLevels as never },
                },
              },
            },
          ]
        : []),
    ],
  };

  const orderBy: Prisma.PullRequestOrderByWithRelationInput =
    filters.sort === "created"
      ? { githubCreatedAt: "desc" }
      : filters.sort === "size"
        ? { changedFiles: "desc" }
        : { githubUpdatedAt: "desc" };

  const [pullRequests, total] = await Promise.all([
    prisma.pullRequest.findMany({
      where,
      orderBy,
      skip: filters.skip ?? 0,
      take: filters.take ?? 20,
      select: {
        id: true,
        number: true,
        title: true,
        state: true,
        draft: true,
        authorLogin: true,
        authorAvatarUrl: true,
        baseRef: true,
        headRef: true,
        headSha: true,
        additions: true,
        deletions: true,
        changedFiles: true,
        commits: true,
        comments: true,
        reviewComments: true,
        labels: true,
        htmlUrl: true,
        mergeable: true,
        githubCreatedAt: true,
        githubUpdatedAt: true,
        mergedAt: true,
        closedAt: true,
        repository: {
          select: { id: true, fullName: true, language: true, private: true },
        },
        _count: { select: { analyses: true, files: true } },
      },
    }),
    prisma.pullRequest.count({ where }),
  ]);

  const latestByPr = await loadLatestAnalyses(pullRequests.map((pr) => pr.id));

  const items = pullRequests.map((pr) => ({
    ...pr,
    githubCreatedAt: pr.githubCreatedAt.toISOString(),
    githubUpdatedAt: pr.githubUpdatedAt.toISOString(),
    mergedAt: pr.mergedAt?.toISOString() ?? null,
    closedAt: pr.closedAt?.toISOString() ?? null,
    counts: { analyses: pr._count.analyses, files: pr._count.files },
    latestAnalysis: latestByPr.get(pr.id) ?? null,
  }));

  // Risk sorting has to happen after the analyses are attached, since the score
  // lives on a different table. Applied to the page rather than the whole set,
  // which is a deliberate limitation documented in docs/API.md.
  if (filters.sort === "risk") {
    items.sort((a, b) => (b.latestAnalysis?.riskScore ?? -1) - (a.latestAnalysis?.riskScore ?? -1));
  }

  return { items, total };
}

export interface LatestAnalysisSummary {
  id: string;
  status: string;
  stage: string | null;
  progress: number;
  riskScore: number | null;
  riskLevel: string | null;
  scoredBy: string;
  degraded: boolean;
  headSha: string;
  createdAt: string;
  completedAt: string | null;
  /** False when the PR has moved on since this analysis ran. */
  isCurrent: boolean;
  topFactors: Array<{ key: string; label: string; contribution: number }>;
}

/** Latest analysis per pull request, in one query. */
async function loadLatestAnalyses(
  pullRequestIds: string[],
): Promise<Map<string, LatestAnalysisSummary>> {
  const result = new Map<string, LatestAnalysisSummary>();
  if (pullRequestIds.length === 0) return result;

  const analyses = await prisma.analysis.findMany({
    where: { pullRequestId: { in: pullRequestIds } },
    orderBy: [{ pullRequestId: "asc" }, { createdAt: "desc" }],
    distinct: ["pullRequestId"],
    select: {
      id: true,
      pullRequestId: true,
      status: true,
      stage: true,
      progress: true,
      riskScore: true,
      riskLevel: true,
      scoredBy: true,
      degraded: true,
      headSha: true,
      createdAt: true,
      completedAt: true,
      pullRequest: { select: { headSha: true } },
      riskFactors: {
        where: { direction: "INCREASES_RISK" },
        orderBy: { rank: "asc" },
        take: 3,
        select: { key: true, label: true, contribution: true },
      },
    },
  });

  for (const analysis of analyses) {
    result.set(analysis.pullRequestId, {
      id: analysis.id,
      status: analysis.status,
      stage: analysis.stage,
      progress: analysis.progress,
      riskScore: analysis.riskScore,
      riskLevel: analysis.riskLevel,
      scoredBy: analysis.scoredBy,
      degraded: analysis.degraded,
      headSha: analysis.headSha,
      createdAt: analysis.createdAt.toISOString(),
      completedAt: analysis.completedAt?.toISOString() ?? null,
      // Stale analyses are marked rather than hidden: knowing "this score is for
      // an older commit" is more useful than showing nothing.
      isCurrent: analysis.headSha === analysis.pullRequest.headSha,
      topFactors: analysis.riskFactors,
    });
  }

  return result;
}

/** Pull request detail, including every analysis run against it. */
export async function getPullRequest(auth: AuthContext, pullRequestId: string) {
  const pr = await prisma.pullRequest.findFirst({
    where: { id: pullRequestId, repository: repositoryAccessWhere(auth) },
    select: {
      id: true,
      number: true,
      title: true,
      body: true,
      state: true,
      draft: true,
      locked: true,
      authorLogin: true,
      authorAvatarUrl: true,
      baseRef: true,
      baseSha: true,
      headRef: true,
      headSha: true,
      additions: true,
      deletions: true,
      changedFiles: true,
      commits: true,
      comments: true,
      reviewComments: true,
      labels: true,
      htmlUrl: true,
      mergeable: true,
      mergeableState: true,
      githubCreatedAt: true,
      githubUpdatedAt: true,
      mergedAt: true,
      closedAt: true,
      lastSyncedAt: true,
      repository: {
        select: {
          id: true,
          fullName: true,
          owner: true,
          name: true,
          language: true,
          private: true,
          defaultBranch: true,
          htmlUrl: true,
        },
      },
      files: {
        orderBy: { changes: "desc" },
        select: {
          id: true,
          filename: true,
          previousFilename: true,
          status: true,
          additions: true,
          deletions: true,
          changes: true,
          patchTruncated: true,
          blobUrl: true,
          language: true,
          module: true,
          isTest: true,
          isConfig: true,
          isDependencyManifest: true,
          isMigration: true,
          isInfra: true,
          isDocs: true,
          isGenerated: true,
          touchesPublicApi: true,
        },
      },
      analyses: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          stage: true,
          progress: true,
          riskScore: true,
          riskLevel: true,
          scoredBy: true,
          degraded: true,
          headSha: true,
          summary: true,
          createdAt: true,
          completedAt: true,
          durationMs: true,
          errorCode: true,
          errorMessage: true,
        },
      },
    },
  });

  if (!pr) throw notFound("Pull request");

  const latest = pr.analyses[0] ?? null;

  return {
    ...pr,
    githubCreatedAt: pr.githubCreatedAt.toISOString(),
    githubUpdatedAt: pr.githubUpdatedAt.toISOString(),
    mergedAt: pr.mergedAt?.toISOString() ?? null,
    closedAt: pr.closedAt?.toISOString() ?? null,
    lastSyncedAt: pr.lastSyncedAt.toISOString(),
    /** True when the diff has been ingested and features can be extracted. */
    diffAvailable: pr.files.length > 0,
    latestAnalysisIsCurrent: latest ? latest.headSha === pr.headSha : false,
  };
}

/**
 * The diff, with per-file patches.
 *
 * Split from `getPullRequest` because patches are large and the PR header should
 * render before the diff has downloaded.
 */
export async function getPullRequestDiff(
  auth: AuthContext,
  pullRequestId: string,
  options: { refresh?: boolean } = {},
) {
  await assertPullRequestAccess(auth, pullRequestId);

  const pr = await prisma.pullRequest.findUnique({
    where: { id: pullRequestId },
    select: { id: true, number: true, headSha: true, repositoryId: true },
  });

  if (!pr) throw notFound("Pull request");

  const existingCount = await prisma.changedFile.count({ where: { pullRequestId } });

  // Fetch on demand when the diff has never been ingested, or the caller asked
  // for a refresh. Analyses trigger this too, but a user may open the diff view
  // before running one.
  if (existingCount === 0 || options.refresh) {
    await ingestPullRequestDiff(auth.userId, pr.repositoryId, pr.number);
  }

  const files = await prisma.changedFile.findMany({
    where: { pullRequestId },
    orderBy: [{ changes: "desc" }],
    select: {
      id: true,
      filename: true,
      previousFilename: true,
      status: true,
      additions: true,
      deletions: true,
      changes: true,
      patch: true,
      patchTruncated: true,
      blobUrl: true,
      extension: true,
      language: true,
      module: true,
      isTest: true,
      isConfig: true,
      isDependencyManifest: true,
      isMigration: true,
      isInfra: true,
      isDocs: true,
      isGenerated: true,
      touchesPublicApi: true,
    },
  });

  // Module rollup drives the "blast radius" panel in the diff view.
  const moduleMap = new Map<string, { churn: number; files: number }>();
  for (const file of files) {
    const key = file.module ?? "(root)";
    const entry = moduleMap.get(key) ?? { churn: 0, files: 0 };
    entry.churn += file.additions + file.deletions;
    entry.files += 1;
    moduleMap.set(key, entry);
  }

  return {
    pullRequestId,
    headSha: pr.headSha,
    files,
    totals: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      truncatedPatches: files.filter((file) => file.patchTruncated).length,
    },
    modules: [...moduleMap.entries()]
      .map(([module, value]) => ({ module, ...value }))
      .sort((a, b) => b.churn - a.churn),
    maxPatchBytes: env.GITHUB_MAX_PATCH_BYTES,
  };
}

/** Distinct authors, for the PR list's author filter. */
export async function listPullRequestAuthors(auth: AuthContext, repositoryId?: string) {
  if (repositoryId) await assertRepositoryAccess(auth, repositoryId);

  const rows = await prisma.pullRequest.groupBy({
    by: ["authorLogin"],
    where: {
      repository: repositoryAccessWhere(auth),
      ...(repositoryId ? { repositoryId } : {}),
    },
    _count: { _all: true },
    orderBy: { _count: { authorLogin: "desc" } },
    take: 50,
  });

  return rows.map((row) => ({ login: row.authorLogin, pullRequests: row._count._all }));
}
