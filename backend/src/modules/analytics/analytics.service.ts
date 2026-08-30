/**
 * Analytics.
 *
 * Three views, all built from the same primitives:
 *
 *  - **dashboard overview** — everything the caller can see, one screen
 *  - **repository health** — one repository over time
 *  - **team dashboard** — a team's repositories, authors and recurring patterns
 *
 * Two deliberate choices:
 *
 *  1. **Time series are bucketed in application code**, not SQL. The windows are
 *     bounded (≤365 days) and the row counts modest, so this avoids
 *     database-specific date functions and keeps the bucketing logic testable and
 *     identical across all three views.
 *
 *  2. **The health score is a stated formula, not a model.** It is a product
 *     heuristic, documented inline and in docs/ML_MODEL.md, and labelled as such
 *     in the UI. Presenting a weighted average as if it were a learned quantity
 *     would be the same dishonesty the explanation layer exists to avoid.
 */
import { prisma } from "../../lib/prisma";
import { cached, cacheDelPattern } from "../../lib/cache";
import { env } from "../../config/env";
import { CACHE_KEYS } from "../../config/constants";
import { scoped } from "../../lib/logger";
import {
  accessibleRepositoryIds,
  assertRepositoryAccess,
  assertTeamAccess,
} from "../repositories/repository.access";
import type { AuthContext } from "../../types/express";

const log = scoped("analytics");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** UTC midnight for a date — the canonical bucket key. */
function bucketKey(date: Date): string {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
}

/** Every day in the window, so a chart has no gaps where nothing happened. */
function emptyBuckets(days: number): string[] {
  const today = Date.now();
  return Array.from({ length: days }, (_, i) =>
    bucketKey(new Date(today - (days - 1 - i) * DAY_MS)),
  );
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? null;
}

const average = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

const round1 = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 10) / 10;

export interface RiskDistribution {
  LOW: number;
  MODERATE: number;
  HIGH: number;
  CRITICAL: number;
}

const emptyDistribution = (): RiskDistribution => ({
  LOW: 0,
  MODERATE: 0,
  HIGH: 0,
  CRITICAL: 0,
});

interface AnalysisRow {
  createdAt: Date;
  riskScore: number | null;
  riskLevel: string | null;
}

/** Per-day series of analysis volume and average score. */
function buildTrend(rows: AnalysisRow[], days: number) {
  const buckets = new Map<string, { scores: number[]; distribution: RiskDistribution }>();
  for (const key of emptyBuckets(days)) {
    buckets.set(key, { scores: [], distribution: emptyDistribution() });
  }

  for (const row of rows) {
    const key = bucketKey(row.createdAt);
    const bucket = buckets.get(key);
    if (!bucket) continue; // outside the window
    if (row.riskScore !== null) bucket.scores.push(row.riskScore);
    if (row.riskLevel && row.riskLevel in bucket.distribution) {
      bucket.distribution[row.riskLevel as keyof RiskDistribution] += 1;
    }
  }

  return [...buckets.entries()].map(([date, bucket]) => ({
    date,
    analyses: bucket.scores.length,
    avgRiskScore: round1(average(bucket.scores)),
    maxRiskScore: bucket.scores.length ? Math.max(...bucket.scores) : null,
    ...bucket.distribution,
  }));
}

/** Most frequently occurring risk factors across a set of analyses. */
async function topRiskFactors(analysisIds: string[], limit = 8) {
  if (analysisIds.length === 0) return [];

  const rows = await prisma.riskFactor.groupBy({
    by: ["key"],
    where: { analysisId: { in: analysisIds }, direction: "INCREASES_RISK" },
    _count: { _all: true },
    _avg: { contribution: true },
    orderBy: { _count: { key: "desc" } },
    take: limit,
  });

  // One extra query to recover the human labels without joining per row.
  const labels = await prisma.riskFactor.findMany({
    where: { key: { in: rows.map((r) => r.key) }, analysisId: { in: analysisIds } },
    distinct: ["key"],
    select: { key: true, label: true, category: true },
  });

  const labelByKey = new Map(labels.map((l) => [l.key, l]));

  return rows.map((row) => ({
    key: row.key,
    label: labelByKey.get(row.key)?.label ?? row.key,
    category: labelByKey.get(row.key)?.category ?? "CHANGE_SHAPE",
    occurrences: row._count._all,
    /** Share of analyses in the window where this factor increased risk. */
    frequency: Math.round((row._count._all / analysisIds.length) * 1000) / 10,
    avgContribution: round1(row._avg.contribution),
  }));
}

// ---------------------------------------------------------------------------
// Health score
// ---------------------------------------------------------------------------

export interface HealthInputs {
  avgRiskScore: number | null;
  highRiskShare: number; // 0-1
  testCoverageRatio: number | null; // share of analysed PRs touching tests
  deploymentFailureRate: number | null; // 0-1
  analysesCount: number;
}

/**
 * Repository health, 0-100.
 *
 * **This is a product heuristic, not a model output.** It exists to give a
 * repository a single glanceable number, and the formula is stated so nobody has
 * to guess what it means:
 *
 *     start at 100
 *       - up to 40 points off for average PR risk
 *       - up to 25 points off for the share of high/critical PRs
 *       - up to 20 points off for deployment failures
 *       + up to 15 points back for test discipline
 *
 * Low-volume repositories are pulled toward 100 in proportion to how little
 * evidence exists, so a repository with two analyses is not labelled unhealthy
 * on the strength of one risky PR. `confidence` reports that explicitly.
 */
export function computeHealthScore(inputs: HealthInputs): {
  score: number | null;
  confidence: "low" | "medium" | "high";
  components: Record<string, number>;
} {
  if (inputs.analysesCount === 0) {
    return { score: null, confidence: "low", components: {} };
  }

  const riskPenalty = ((inputs.avgRiskScore ?? 0) / 100) * 40;
  const highRiskPenalty = inputs.highRiskShare * 25;
  const deployPenalty = (inputs.deploymentFailureRate ?? 0) * 20;
  const testBonus = Math.min(1, inputs.testCoverageRatio ?? 0) * 15;

  const raw = 100 - riskPenalty - highRiskPenalty - deployPenalty + testBonus;

  // Shrink toward 100 when there is little evidence. At 20+ analyses the
  // adjustment is negligible; at 1 it dominates.
  const weight = Math.min(1, inputs.analysesCount / 20);
  const shrunk = 100 - (100 - raw) * weight;

  return {
    score: Math.max(0, Math.min(100, Math.round(shrunk * 10) / 10)),
    confidence: inputs.analysesCount >= 20 ? "high" : inputs.analysesCount >= 6 ? "medium" : "low",
    components: {
      riskPenalty: round1(riskPenalty) ?? 0,
      highRiskPenalty: round1(highRiskPenalty) ?? 0,
      deploymentPenalty: round1(deployPenalty) ?? 0,
      testBonus: round1(testBonus) ?? 0,
      evidenceWeight: round1(weight * 100) ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Dashboard overview
// ---------------------------------------------------------------------------

export async function getDashboardOverview(auth: AuthContext, days = 30) {
  const { value } = await cached(
    CACHE_KEYS.dashboardOverview(auth.userId) + `:${days}`,
    env.CACHE_TTL_ANALYTICS,
    async () => {
      const repositoryIds = await accessibleRepositoryIds(auth);

      if (repositoryIds.length === 0) {
        return {
          hasRepositories: false,
          totals: {
            repositories: 0,
            openPullRequests: 0,
            analyses: 0,
            highRiskOpen: 0,
            avgRiskScore: null as number | null,
            pendingAnalyses: 0,
          },
          distribution: emptyDistribution(),
          trend: buildTrend([], days),
          topRiskFactors: [] as Awaited<ReturnType<typeof topRiskFactors>>,
          recentAnalyses: [] as unknown[],
          attentionNeeded: [] as unknown[],
          windowDays: days,
        };
      }

      const since = new Date(Date.now() - days * DAY_MS);

      const [
        repositoryCount,
        openPullRequests,
        analysisRows,
        distributionRows,
        pendingAnalyses,
        recentAnalyses,
        attentionNeeded,
      ] = await Promise.all([
        prisma.repository.count({ where: { id: { in: repositoryIds }, isActive: true } }),
        prisma.pullRequest.count({
          where: { repositoryId: { in: repositoryIds }, state: "OPEN" },
        }),
        prisma.analysis.findMany({
          where: {
            repositoryId: { in: repositoryIds },
            status: "COMPLETED",
            createdAt: { gte: since },
          },
          select: { id: true, createdAt: true, riskScore: true, riskLevel: true },
          orderBy: { createdAt: "desc" },
          take: 5_000,
        }),
        prisma.analysis.groupBy({
          by: ["riskLevel"],
          where: {
            repositoryId: { in: repositoryIds },
            status: "COMPLETED",
            createdAt: { gte: since },
          },
          _count: { _all: true },
        }),
        prisma.analysis.count({
          where: {
            repositoryId: { in: repositoryIds },
            status: { in: ["QUEUED", "RUNNING"] },
          },
        }),
        prisma.analysis.findMany({
          where: { repositoryId: { in: repositoryIds }, status: "COMPLETED" },
          orderBy: { completedAt: "desc" },
          take: 8,
          select: {
            id: true,
            riskScore: true,
            riskLevel: true,
            completedAt: true,
            scoredBy: true,
            degraded: true,
            repository: { select: { id: true, fullName: true } },
            pullRequest: {
              select: {
                id: true,
                number: true,
                title: true,
                authorLogin: true,
                authorAvatarUrl: true,
                state: true,
              },
            },
          },
        }),
        // Open PRs whose latest analysis is high risk and which have no merge
        // decision recorded — the actual "what needs me" list.
        prisma.analysis.findMany({
          where: {
            repositoryId: { in: repositoryIds },
            status: "COMPLETED",
            riskLevel: { in: ["HIGH", "CRITICAL"] },
            pullRequest: { state: "OPEN" },
            mergeDecision: null,
          },
          orderBy: [{ riskScore: "desc" }, { completedAt: "desc" }],
          distinct: ["pullRequestId"],
          take: 8,
          select: {
            id: true,
            riskScore: true,
            riskLevel: true,
            summary: true,
            completedAt: true,
            repository: { select: { id: true, fullName: true } },
            pullRequest: {
              select: {
                id: true,
                number: true,
                title: true,
                authorLogin: true,
                authorAvatarUrl: true,
                additions: true,
                deletions: true,
                changedFiles: true,
              },
            },
            riskFactors: {
              where: { direction: "INCREASES_RISK" },
              orderBy: { rank: "asc" },
              take: 2,
              select: { key: true, label: true, contribution: true },
            },
          },
        }),
      ]);

      const distribution = emptyDistribution();
      for (const row of distributionRows) {
        if (row.riskLevel && row.riskLevel in distribution) {
          distribution[row.riskLevel as keyof RiskDistribution] = row._count._all;
        }
      }

      const scores = analysisRows
        .map((r) => r.riskScore)
        .filter((s): s is number => s !== null);

      return {
        hasRepositories: true,
        totals: {
          repositories: repositoryCount,
          openPullRequests,
          analyses: analysisRows.length,
          highRiskOpen: attentionNeeded.length,
          avgRiskScore: round1(average(scores)),
          pendingAnalyses,
        },
        distribution,
        trend: buildTrend(analysisRows, days),
        topRiskFactors: await topRiskFactors(analysisRows.map((r) => r.id)),
        recentAnalyses,
        attentionNeeded,
        windowDays: days,
      };
    },
  );

  return value;
}

// ---------------------------------------------------------------------------
// Repository health
// ---------------------------------------------------------------------------

export async function getRepositoryHealth(
  auth: AuthContext,
  repositoryId: string,
  days = 30,
) {
  await assertRepositoryAccess(auth, repositoryId);

  const { value } = await cached(
    CACHE_KEYS.repoAnalytics(repositoryId, days),
    env.CACHE_TTL_ANALYTICS,
    async () => {
      const since = new Date(Date.now() - days * DAY_MS);

      const [
        analysisRows,
        prCounts,
        deploymentStats,
        featureRows,
        authorRows,
        overrideCount,
        decisionCount,
      ] = await Promise.all([
        prisma.analysis.findMany({
          where: { repositoryId, status: "COMPLETED", createdAt: { gte: since } },
          select: {
            id: true,
            createdAt: true,
            riskScore: true,
            riskLevel: true,
            features: true,
          },
          orderBy: { createdAt: "desc" },
          take: 5_000,
        }),
        prisma.pullRequest.groupBy({
          by: ["state"],
          where: { repositoryId, githubCreatedAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.deployment.groupBy({
          by: ["status"],
          where: { repositoryId, startedAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.analysis.findMany({
          where: { repositoryId, status: "COMPLETED", createdAt: { gte: since } },
          select: { features: true },
          take: 2_000,
        }),
        prisma.pullRequest.groupBy({
          by: ["authorLogin"],
          where: { repositoryId, githubCreatedAt: { gte: since } },
          _count: { _all: true },
          _avg: { additions: true, changedFiles: true },
          orderBy: { _count: { authorLogin: "desc" } },
          take: 12,
        }),
        prisma.mergeDecision.count({
          where: {
            pullRequest: { repositoryId },
            createdAt: { gte: since },
            riskLevelAtDecision: { in: ["HIGH", "CRITICAL"] },
            decision: { in: ["APPROVED_MERGE", "OVERRIDDEN"] },
          },
        }),
        prisma.mergeDecision.count({
          where: { pullRequest: { repositoryId }, createdAt: { gte: since } },
        }),
      ]);

      const scores = analysisRows
        .map((r) => r.riskScore)
        .filter((s): s is number => s !== null);

      const highRiskCount = analysisRows.filter(
        (r) => r.riskLevel === "HIGH" || r.riskLevel === "CRITICAL",
      ).length;

      // Test discipline, read back out of the stored feature vectors. Reusing
      // the persisted features means analytics cannot disagree with what the
      // model was actually shown.
      const withTests = featureRows.filter((row) => {
        const features = row.features as Record<string, number> | null;
        return features ? (features.touches_tests ?? 0) >= 0.5 : false;
      }).length;

      const testCoverageRatio =
        featureRows.length > 0 ? withTests / featureRows.length : null;

      const avgChurn = average(
        featureRows
          .map((row) => (row.features as Record<string, number> | null)?.total_churn)
          .filter((v): v is number => typeof v === "number"),
      );

      const deploymentsTotal = deploymentStats.reduce((sum, r) => sum + r._count._all, 0);
      const deploymentsFailed = deploymentStats
        .filter((r) => r.status === "FAILURE" || r.status === "ROLLED_BACK")
        .reduce((sum, r) => sum + r._count._all, 0);

      const deploymentFailureRate =
        deploymentsTotal > 0 ? deploymentsFailed / deploymentsTotal : null;

      const health = computeHealthScore({
        avgRiskScore: average(scores),
        highRiskShare: analysisRows.length > 0 ? highRiskCount / analysisRows.length : 0,
        testCoverageRatio,
        deploymentFailureRate,
        analysesCount: analysisRows.length,
      });

      const distribution = emptyDistribution();
      for (const row of analysisRows) {
        if (row.riskLevel && row.riskLevel in distribution) {
          distribution[row.riskLevel as keyof RiskDistribution] += 1;
        }
      }

      return {
        repositoryId,
        windowDays: days,
        health,
        totals: {
          analyses: analysisRows.length,
          avgRiskScore: round1(average(scores)),
          p90RiskScore: round1(percentile(scores, 90)),
          maxRiskScore: scores.length ? Math.max(...scores) : null,
          highRiskCount,
          pullRequestsOpened: prCounts.reduce((sum, r) => sum + r._count._all, 0),
          pullRequestsMerged:
            prCounts.find((r) => r.state === "MERGED")?._count._all ?? 0,
          avgChurn: round1(avgChurn),
          testCoverageRatio:
            testCoverageRatio === null ? null : Math.round(testCoverageRatio * 1000) / 10,
          deployments: deploymentsTotal,
          deploymentsFailed,
          deploymentFailureRate:
            deploymentFailureRate === null
              ? null
              : Math.round(deploymentFailureRate * 1000) / 10,
          highRiskOverrides: overrideCount,
          decisionsRecorded: decisionCount,
        },
        distribution,
        trend: buildTrend(analysisRows, days),
        recurringRiskFactors: await topRiskFactors(analysisRows.map((r) => r.id)),
        contributors: authorRows.map((row) => ({
          login: row.authorLogin,
          pullRequests: row._count._all,
          avgAdditions: round1(row._avg.additions),
          avgFilesChanged: round1(row._avg.changedFiles),
        })),
      };
    },
  );

  return value;
}

// ---------------------------------------------------------------------------
// Team dashboard
// ---------------------------------------------------------------------------

export async function getTeamDashboard(auth: AuthContext, teamId: string, days = 30) {
  await assertTeamAccess(auth, teamId);

  const { value } = await cached(
    CACHE_KEYS.teamAnalytics(teamId, days),
    env.CACHE_TTL_ANALYTICS,
    async () => {
      const since = new Date(Date.now() - days * DAY_MS);

      const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          createdAt: true,
          members: {
            select: {
              role: true,
              joinedAt: true,
              user: {
                select: { id: true, githubLogin: true, name: true, avatarUrl: true },
              },
            },
          },
          repositories: {
            where: { isActive: true },
            select: { id: true, fullName: true, language: true, private: true },
          },
        },
      });

      if (!team) throw new Error(`Team ${teamId} not found`);

      const repositoryIds = team.repositories.map((r) => r.id);

      if (repositoryIds.length === 0) {
        return {
          team: { ...team, createdAt: team.createdAt.toISOString() },
          windowDays: days,
          totals: {
            repositories: 0,
            analyses: 0,
            avgRiskScore: null,
            highRiskCount: 0,
            openPullRequests: 0,
            highRiskOverrides: 0,
            overrideRate: null,
          },
          distribution: emptyDistribution(),
          trend: buildTrend([], days),
          repositories: [],
          contributors: [],
          recurringRiskFactors: [],
        };
      }

      const [analysisRows, openPrs, perRepo, contributors, overrides, highRiskDecisions] =
        await Promise.all([
          prisma.analysis.findMany({
            where: {
              repositoryId: { in: repositoryIds },
              status: "COMPLETED",
              createdAt: { gte: since },
            },
            select: {
              id: true,
              createdAt: true,
              riskScore: true,
              riskLevel: true,
              repositoryId: true,
            },
            take: 5_000,
          }),
          prisma.pullRequest.count({
            where: { repositoryId: { in: repositoryIds }, state: "OPEN" },
          }),
          prisma.analysis.groupBy({
            by: ["repositoryId"],
            where: {
              repositoryId: { in: repositoryIds },
              status: "COMPLETED",
              createdAt: { gte: since },
            },
            _avg: { riskScore: true },
            _count: { _all: true },
            _max: { riskScore: true },
          }),
          prisma.pullRequest.groupBy({
            by: ["authorLogin"],
            where: {
              repositoryId: { in: repositoryIds },
              githubCreatedAt: { gte: since },
            },
            _count: { _all: true },
            _avg: { additions: true, deletions: true, changedFiles: true },
            orderBy: { _count: { authorLogin: "desc" } },
            take: 20,
          }),
          prisma.mergeDecision.count({
            where: {
              pullRequest: { repositoryId: { in: repositoryIds } },
              createdAt: { gte: since },
              riskLevelAtDecision: { in: ["HIGH", "CRITICAL"] },
              decision: { in: ["APPROVED_MERGE", "OVERRIDDEN"] },
            },
          }),
          prisma.mergeDecision.count({
            where: {
              pullRequest: { repositoryId: { in: repositoryIds } },
              createdAt: { gte: since },
              riskLevelAtDecision: { in: ["HIGH", "CRITICAL"] },
            },
          }),
        ]);

      const scores = analysisRows
        .map((r) => r.riskScore)
        .filter((s): s is number => s !== null);

      const distribution = emptyDistribution();
      for (const row of analysisRows) {
        if (row.riskLevel && row.riskLevel in distribution) {
          distribution[row.riskLevel as keyof RiskDistribution] += 1;
        }
      }

      const repoStats = new Map(perRepo.map((r) => [r.repositoryId, r]));

      // Per-author average risk needs the analysis joined to its PR author, which
      // the grouped query above cannot express. One extra query rather than N.
      const authorRisk = await prisma.analysis.findMany({
        where: {
          repositoryId: { in: repositoryIds },
          status: "COMPLETED",
          createdAt: { gte: since },
        },
        select: { riskScore: true, pullRequest: { select: { authorLogin: true } } },
        take: 5_000,
      });

      const riskByAuthor = new Map<string, number[]>();
      for (const row of authorRisk) {
        if (row.riskScore === null) continue;
        const login = row.pullRequest.authorLogin;
        const list = riskByAuthor.get(login) ?? [];
        list.push(row.riskScore);
        riskByAuthor.set(login, list);
      }

      return {
        team: { ...team, createdAt: team.createdAt.toISOString() },
        windowDays: days,
        totals: {
          repositories: team.repositories.length,
          analyses: analysisRows.length,
          avgRiskScore: round1(average(scores)),
          highRiskCount: distribution.HIGH + distribution.CRITICAL,
          openPullRequests: openPrs,
          highRiskOverrides: overrides,
          /** Share of high-risk assessments that were merged anyway. */
          overrideRate:
            highRiskDecisions > 0
              ? Math.round((overrides / highRiskDecisions) * 1000) / 10
              : null,
        },
        distribution,
        trend: buildTrend(analysisRows, days),
        repositories: team.repositories.map((repository) => {
          const stats = repoStats.get(repository.id);
          return {
            ...repository,
            analyses: stats?._count._all ?? 0,
            avgRiskScore: round1(stats?._avg.riskScore ?? null),
            maxRiskScore: stats?._max.riskScore ?? null,
          };
        }),
        contributors: contributors.map((row) => {
          const authorScores = riskByAuthor.get(row.authorLogin) ?? [];
          return {
            login: row.authorLogin,
            pullRequests: row._count._all,
            avgChurn: round1(
              (row._avg.additions ?? 0) + (row._avg.deletions ?? 0),
            ),
            avgFilesChanged: round1(row._avg.changedFiles),
            avgRiskScore: round1(average(authorScores)),
            analysedPullRequests: authorScores.length,
          };
        }),
        recurringRiskFactors: await topRiskFactors(analysisRows.map((r) => r.id)),
      };
    },
  );

  return value;
}

// ---------------------------------------------------------------------------
// Snapshot rollup
// ---------------------------------------------------------------------------

/**
 * Materialise yesterday's health snapshot for every active repository.
 *
 * Run on a schedule by the worker. The dashboards read live data for recent
 * windows, so snapshots are not on the critical path — they exist so long-range
 * trends stay cheap as history accumulates.
 */
export async function computeDailySnapshots(targetDate = new Date()): Promise<number> {
  const dayStart = new Date(
    Date.UTC(
      targetDate.getUTCFullYear(),
      targetDate.getUTCMonth(),
      targetDate.getUTCDate(),
    ),
  );
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);

  const repositories = await prisma.repository.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  let written = 0;

  for (const repository of repositories) {
    const [analyses, prsOpened, prsMerged, deployments] = await Promise.all([
      prisma.analysis.findMany({
        where: {
          repositoryId: repository.id,
          status: "COMPLETED",
          createdAt: { gte: dayStart, lt: dayEnd },
        },
        select: { id: true, riskScore: true, riskLevel: true, features: true },
      }),
      prisma.pullRequest.count({
        where: {
          repositoryId: repository.id,
          githubCreatedAt: { gte: dayStart, lt: dayEnd },
        },
      }),
      prisma.pullRequest.count({
        where: { repositoryId: repository.id, mergedAt: { gte: dayStart, lt: dayEnd } },
      }),
      prisma.deployment.findMany({
        where: { repositoryId: repository.id, startedAt: { gte: dayStart, lt: dayEnd } },
        select: { status: true, causedIncident: true },
      }),
    ]);

    // Nothing happened; do not write an empty row.
    if (analyses.length === 0 && prsOpened === 0 && deployments.length === 0) continue;

    const scores = analyses.map((a) => a.riskScore).filter((s): s is number => s !== null);
    const distribution = emptyDistribution();
    for (const analysis of analyses) {
      if (analysis.riskLevel && analysis.riskLevel in distribution) {
        distribution[analysis.riskLevel as keyof RiskDistribution] += 1;
      }
    }

    const withTests = analyses.filter((a) => {
      const features = a.features as Record<string, number> | null;
      return features ? (features.touches_tests ?? 0) >= 0.5 : false;
    }).length;

    const churns = analyses
      .map((a) => (a.features as Record<string, number> | null)?.total_churn)
      .filter((v): v is number => typeof v === "number");

    const filesChanged = analyses
      .map((a) => (a.features as Record<string, number> | null)?.files_changed)
      .filter((v): v is number => typeof v === "number");

    const failedDeployments = deployments.filter(
      (d) => d.status === "FAILURE" || d.status === "ROLLED_BACK",
    ).length;

    const factors = await topRiskFactors(analyses.map((a) => a.id), 5);

    const data = {
      analysesCount: analyses.length,
      pullRequestsOpened: prsOpened,
      pullRequestsMerged: prsMerged,
      avgRiskScore: average(scores),
      maxRiskScore: scores.length ? Math.max(...scores) : null,
      p90RiskScore: percentile(scores, 90),
      lowCount: distribution.LOW,
      moderateCount: distribution.MODERATE,
      highCount: distribution.HIGH,
      criticalCount: distribution.CRITICAL,
      avgPrSize: average(churns),
      avgFilesChanged: average(filesChanged),
      testCoverageRatio: analyses.length > 0 ? withTests / analyses.length : null,
      deploymentsCount: deployments.length,
      failedDeployments,
      incidentsCount: deployments.filter((d) => d.causedIncident === true).length,
      topRiskFactors: factors.map((f) => ({ key: f.key, occurrences: f.occurrences })) as never,
      healthScore: computeHealthScore({
        avgRiskScore: average(scores),
        highRiskShare:
          analyses.length > 0
            ? (distribution.HIGH + distribution.CRITICAL) / analyses.length
            : 0,
        testCoverageRatio: analyses.length > 0 ? withTests / analyses.length : null,
        deploymentFailureRate:
          deployments.length > 0 ? failedDeployments / deployments.length : null,
        analysesCount: analyses.length,
      }).score,
    };

    await prisma.repositoryHealthSnapshot.upsert({
      where: { repositoryId_bucketDate: { repositoryId: repository.id, bucketDate: dayStart } },
      create: { ...data, repositoryId: repository.id, bucketDate: dayStart },
      update: data,
    });

    written++;
  }

  if (written > 0) {
    await cacheDelPattern("cache:analytics:*");
    log.info({ written, date: dayStart.toISOString().slice(0, 10) }, "daily snapshots written");
  }

  return written;
}

/** Long-range trend read from snapshots rather than raw analyses. */
export async function getRepositorySnapshots(
  auth: AuthContext,
  repositoryId: string,
  days = 90,
) {
  await assertRepositoryAccess(auth, repositoryId);

  const since = new Date(Date.now() - days * DAY_MS);

  const snapshots = await prisma.repositoryHealthSnapshot.findMany({
    where: { repositoryId, bucketDate: { gte: since } },
    orderBy: { bucketDate: "asc" },
  });

  return snapshots.map((s) => ({
    date: s.bucketDate.toISOString().slice(0, 10),
    analyses: s.analysesCount,
    avgRiskScore: round1(s.avgRiskScore),
    p90RiskScore: round1(s.p90RiskScore),
    healthScore: round1(s.healthScore),
    pullRequestsOpened: s.pullRequestsOpened,
    pullRequestsMerged: s.pullRequestsMerged,
    LOW: s.lowCount,
    MODERATE: s.moderateCount,
    HIGH: s.highCount,
    CRITICAL: s.criticalCount,
    deployments: s.deploymentsCount,
    failedDeployments: s.failedDeployments,
    incidents: s.incidentsCount,
    testCoverageRatio: round1(s.testCoverageRatio === null ? null : s.testCoverageRatio * 100),
  }));
}
