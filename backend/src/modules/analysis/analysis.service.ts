/**
 * Analysis service — the HTTP-facing half of the pipeline.
 *
 * Everything here is fast and non-blocking: request an analysis (enqueue and
 * return immediately), read one back, list history, compare two runs, record a
 * merge decision. The expensive work happens in the worker.
 */
import { prisma } from "../../lib/prisma";
import { scoped } from "../../lib/logger";
import { env } from "../../config/env";
import { randomToken } from "../../lib/crypto";
import { acquireLock, releaseLock } from "../../lib/redis";
import { CACHE_KEYS } from "../../config/constants";
import { analysisInProgress, badRequest, conflict, notFound } from "../../lib/errors";
import { enqueueAnalysis, removeAnalysisJob } from "../../queue/queues";
import { announceQueued } from "./analysis.state";
import { createNotification } from "../notifications/notification.service";
import { publishEvent } from "../../realtime/bus";
import { EVENT, ROOM } from "../../realtime/events";
import {
  assertAnalysisAccess,
  assertPullRequestAccess,
  repositoryAccessWhere,
} from "../repositories/repository.access";
import type { AuthContext } from "../../types/express";

const log = scoped("analysis-service");

// ---------------------------------------------------------------------------
// Requesting an analysis
// ---------------------------------------------------------------------------

export interface RequestAnalysisResult {
  analysisId: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED";
  /** True when an existing analysis was returned instead of starting a new one. */
  reused: boolean;
  jobId?: string;
  headSha: string;
}

/**
 * Queue an analysis for a pull request.
 *
 * Deduplication is deliberate and layered, because the natural user behaviour is
 * to click twice:
 *
 *  1. A **completed** analysis for the same head SHA is reused unless `force` is
 *     set — re-scoring an unchanged commit produces an identical answer.
 *  2. A **queued or running** analysis for the same SHA is returned as-is, so
 *     the client attaches to the existing job.
 *  3. A short **Redis lock** closes the race between two simultaneous requests
 *     that both pass checks 1 and 2.
 *
 * `force` exists for the case where the answer genuinely could change: the model
 * was retrained, or repository history has moved on.
 */
export async function requestAnalysis(
  auth: AuthContext,
  pullRequestId: string,
  options: { force?: boolean } = {},
): Promise<RequestAnalysisResult> {
  const pr = await assertPullRequestAccess(auth, pullRequestId);

  const pullRequest = await prisma.pullRequest.findUnique({
    where: { id: pullRequestId },
    select: {
      id: true,
      number: true,
      headSha: true,
      title: true,
      repositoryId: true,
      repository: { select: { id: true, fullName: true, isActive: true, ownerUserId: true } },
    },
  });

  if (!pullRequest) throw notFound("Pull request");
  if (!pullRequest.repository.isActive) {
    throw badRequest(
      "This repository is disconnected. Reconnect it before running an analysis.",
    );
  }

  const headSha = pullRequest.headSha;

  // --- 1 & 2: existing analyses for this commit ---------------------------
  const existing = await prisma.analysis.findFirst({
    where: { pullRequestId, headSha },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, jobId: true },
  });

  if (existing && !options.force) {
    if (existing.status === "QUEUED" || existing.status === "RUNNING") {
      return {
        analysisId: existing.id,
        status: existing.status,
        reused: true,
        ...(existing.jobId ? { jobId: existing.jobId } : {}),
        headSha,
      };
    }

    if (existing.status === "COMPLETED") {
      return { analysisId: existing.id, status: "COMPLETED", reused: true, headSha };
    }
    // FAILED / CANCELLED fall through to a fresh attempt.
  }

  // --- 3: lock the (pull request, sha) pair -------------------------------
  const lockKey = CACHE_KEYS.analysisLock(pullRequestId, headSha);
  const lockToken = randomToken(16);
  const gotLock = await acquireLock(lockKey, 30, lockToken);

  if (!gotLock) {
    const concurrent = await prisma.analysis.findFirst({
      where: { pullRequestId, headSha, status: { in: ["QUEUED", "RUNNING"] } },
      select: { id: true },
    });
    if (concurrent) throw analysisInProgress(concurrent.id);
    throw conflict("Another analysis request for this commit is already being processed.");
  }

  try {
    const analysis = await prisma.analysis.create({
      data: {
        pullRequestId,
        repositoryId: pullRequest.repositoryId,
        requestedById: auth.userId,
        headSha,
        status: "QUEUED",
        progress: 0,
      },
      select: { id: true },
    });

    // The user whose credential fetches the diff must be able to read the repo.
    // Using the requester is correct: they demonstrably have access, and it
    // keeps GitHub API usage attributed to the person who asked.
    const { jobId } = await enqueueAnalysis({
      analysisId: analysis.id,
      userId: auth.userId,
      repositoryId: pullRequest.repositoryId,
      pullRequestId,
      pullRequestNumber: pullRequest.number,
      headSha,
    });

    await prisma.analysis.update({ where: { id: analysis.id }, data: { jobId } });

    await announceQueued(
      {
        analysisId: analysis.id,
        repositoryId: pullRequest.repositoryId,
        pullRequestId,
      },
      { pullRequestNumber: pullRequest.number, headSha },
    );

    log.info(
      {
        analysisId: analysis.id,
        pullRequest: pullRequest.number,
        repository: pullRequest.repository.fullName,
        requestedBy: auth.githubLogin,
        forced: Boolean(options.force),
      },
      "analysis requested",
    );

    return { analysisId: analysis.id, status: "QUEUED", reused: false, jobId, headSha };
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}

/**
 * Re-run a failed analysis.
 *
 * Creates a new row rather than resetting the old one, so the failure stays in
 * the history. "It failed twice then worked" is information worth keeping.
 */
export async function retryAnalysis(
  auth: AuthContext,
  analysisId: string,
): Promise<RequestAnalysisResult> {
  const analysis = await assertAnalysisAccess(auth, analysisId);

  if (analysis.status === "QUEUED" || analysis.status === "RUNNING") {
    throw analysisInProgress(analysisId);
  }

  await removeAnalysisJob(analysisId);
  return requestAnalysis(auth, analysis.pullRequestId, { force: true });
}

/** Cancel a queued or running analysis. */
export async function cancelAnalysis(auth: AuthContext, analysisId: string): Promise<void> {
  const analysis = await assertAnalysisAccess(auth, analysisId);

  if (analysis.status !== "QUEUED" && analysis.status !== "RUNNING") {
    throw badRequest(`This analysis is already ${analysis.status.toLowerCase()}.`);
  }

  await removeAnalysisJob(analysisId);

  await prisma.analysis.update({
    where: { id: analysisId },
    data: { status: "CANCELLED", completedAt: new Date(), stage: null },
  });

  await prisma.analysisEvent.create({
    data: {
      analysisId,
      stage: "DONE",
      status: "CANCELLED",
      message: `Cancelled by ${auth.githubLogin}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Full analysis detail: the payload behind the PR analysis view.
 *
 * One query with nested selects rather than several round trips, because this is
 * the most-visited endpoint in the product.
 */
export async function getAnalysisDetail(auth: AuthContext, analysisId: string) {
  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, repository: repositoryAccessWhere(auth) },
    select: {
      id: true,
      status: true,
      stage: true,
      progress: true,
      headSha: true,
      riskScore: true,
      riskLevel: true,
      probability: true,
      confidence: true,
      scoredBy: true,
      modelName: true,
      modelVersion: true,
      featureSetVersion: true,
      features: true,
      summary: true,
      degraded: true,
      degradedReasons: true,
      errorCode: true,
      errorMessage: true,
      attempts: true,
      queuedAt: true,
      startedAt: true,
      completedAt: true,
      durationMs: true,
      createdAt: true,
      requestedBy: { select: { githubLogin: true, avatarUrl: true, name: true } },
      repository: {
        select: {
          id: true,
          fullName: true,
          owner: true,
          name: true,
          private: true,
          language: true,
          defaultBranch: true,
          htmlUrl: true,
        },
      },
      pullRequest: {
        select: {
          id: true,
          number: true,
          title: true,
          body: true,
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
          files: {
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
        },
      },
      riskFactors: { orderBy: { rank: "asc" } },
      recommendations: { orderBy: { rank: "asc" } },
      events: { orderBy: { createdAt: "asc" } },
      mergeDecision: {
        select: {
          id: true,
          decision: true,
          reason: true,
          riskScoreAtDecision: true,
          riskLevelAtDecision: true,
          addressedRecommendationIds: true,
          createdAt: true,
          user: { select: { githubLogin: true, avatarUrl: true } },
        },
      },
    },
  });

  if (!analysis) throw notFound("Analysis");
  return analysis;
}

/** Lightweight status, for polling as a fallback when websockets are blocked. */
export async function getAnalysisStatus(auth: AuthContext, analysisId: string) {
  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, repository: repositoryAccessWhere(auth) },
    select: {
      id: true,
      status: true,
      stage: true,
      progress: true,
      riskScore: true,
      riskLevel: true,
      errorCode: true,
      errorMessage: true,
      attempts: true,
      degraded: true,
      completedAt: true,
      durationMs: true,
    },
  });

  if (!analysis) throw notFound("Analysis");
  return analysis;
}

export interface ListAnalysesFilters {
  repositoryId?: string;
  pullRequestId?: string;
  riskLevels?: Array<"LOW" | "MODERATE" | "HIGH" | "CRITICAL">;
  statuses?: Array<"QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED">;
  authorLogin?: string;
  since?: Date;
  skip?: number;
  take?: number;
}

/** Analysis history across everything the caller can see. */
export async function listAnalyses(auth: AuthContext, filters: ListAnalysesFilters = {}) {
  const where = {
    repository: repositoryAccessWhere(auth),
    ...(filters.repositoryId ? { repositoryId: filters.repositoryId } : {}),
    ...(filters.pullRequestId ? { pullRequestId: filters.pullRequestId } : {}),
    ...(filters.riskLevels?.length ? { riskLevel: { in: filters.riskLevels as never } } : {}),
    ...(filters.statuses?.length ? { status: { in: filters.statuses as never } } : {}),
    ...(filters.since ? { createdAt: { gte: filters.since } } : {}),
    ...(filters.authorLogin
      ? { pullRequest: { authorLogin: filters.authorLogin } }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.analysis.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: filters.skip ?? 0,
      take: filters.take ?? 20,
      select: {
        id: true,
        status: true,
        stage: true,
        progress: true,
        riskScore: true,
        riskLevel: true,
        scoredBy: true,
        degraded: true,
        summary: true,
        headSha: true,
        durationMs: true,
        createdAt: true,
        completedAt: true,
        errorCode: true,
        errorMessage: true,
        repository: { select: { id: true, fullName: true, language: true, private: true } },
        pullRequest: {
          select: {
            id: true,
            number: true,
            title: true,
            state: true,
            authorLogin: true,
            authorAvatarUrl: true,
            additions: true,
            deletions: true,
            changedFiles: true,
            htmlUrl: true,
          },
        },
        riskFactors: {
          where: { direction: "INCREASES_RISK" },
          orderBy: { rank: "asc" },
          take: 3,
          select: { key: true, label: true, contribution: true, category: true },
        },
        mergeDecision: { select: { decision: true } },
      },
    }),
    prisma.analysis.count({ where }),
  ]);

  return { items, total };
}

/**
 * Every analysis for one pull request, oldest first.
 *
 * This is what makes risk comparable over time: a reviewer can see that #431
 * scored 82 before tests were added and 47 after.
 */
export async function listAnalysesForPullRequest(auth: AuthContext, pullRequestId: string) {
  await assertPullRequestAccess(auth, pullRequestId);

  return prisma.analysis.findMany({
    where: { pullRequestId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      riskScore: true,
      riskLevel: true,
      scoredBy: true,
      headSha: true,
      degraded: true,
      createdAt: true,
      completedAt: true,
      durationMs: true,
      modelVersion: true,
      featureSetVersion: true,
      riskFactors: {
        orderBy: { rank: "asc" },
        take: 5,
        select: { key: true, label: true, contribution: true, direction: true },
      },
    },
  });
}

/**
 * Compare two analyses of the same pull request.
 *
 * Reports the score delta plus which factors appeared, disappeared or changed
 * weight — the concrete answer to "did my extra commit actually reduce the risk".
 */
export async function compareAnalyses(
  auth: AuthContext,
  baseId: string,
  compareId: string,
) {
  const [base, compare] = await Promise.all([
    getComparableAnalysis(auth, baseId),
    getComparableAnalysis(auth, compareId),
  ]);

  if (base.pullRequestId !== compare.pullRequestId) {
    throw badRequest("Only analyses of the same pull request can be compared.");
  }

  const baseFactors = new Map(base.riskFactors.map((factor) => [factor.key, factor]));
  const compareFactors = new Map(compare.riskFactors.map((factor) => [factor.key, factor]));
  const allKeys = new Set([...baseFactors.keys(), ...compareFactors.keys()]);

  const factorChanges = [...allKeys]
    .map((key) => {
      const before = baseFactors.get(key);
      const after = compareFactors.get(key);
      return {
        key,
        label: after?.label ?? before?.label ?? key,
        category: after?.category ?? before?.category ?? "CHANGE_SHAPE",
        before: before
          ? { value: before.value, contribution: before.contribution, direction: before.direction }
          : null,
        after: after
          ? { value: after.value, contribution: after.contribution, direction: after.direction }
          : null,
        change: !before ? "ADDED" : !after ? "REMOVED" : "CHANGED",
        contributionDelta: (after?.contribution ?? 0) - (before?.contribution ?? 0),
      };
    })
    .sort((a, b) => Math.abs(b.contributionDelta) - Math.abs(a.contributionDelta));

  return {
    base,
    compare,
    scoreDelta: (compare.riskScore ?? 0) - (base.riskScore ?? 0),
    levelChanged: base.riskLevel !== compare.riskLevel,
    factorChanges,
  };
}

async function getComparableAnalysis(auth: AuthContext, analysisId: string) {
  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, repository: repositoryAccessWhere(auth) },
    select: {
      id: true,
      pullRequestId: true,
      status: true,
      riskScore: true,
      riskLevel: true,
      headSha: true,
      createdAt: true,
      summary: true,
      modelVersion: true,
      riskFactors: {
        orderBy: { rank: "asc" },
        select: {
          key: true,
          label: true,
          value: true,
          displayValue: true,
          contribution: true,
          direction: true,
          category: true,
        },
      },
    },
  });

  if (!analysis) throw notFound("Analysis");
  return analysis;
}

// ---------------------------------------------------------------------------
// Merge decision
// ---------------------------------------------------------------------------

export type MergeDecisionType =
  | "APPROVED_MERGE"
  | "BLOCKED"
  | "DEFERRED"
  | "OVERRIDDEN"
  | "CLOSED_WITHOUT_MERGE";

/**
 * Record the developer's call on a pull request.
 *
 * This closes the loop the product is built around: the assessment is only
 * meaningful if the decision it informed is captured. It is also the label a
 * future retraining run would use, and it powers the "how often do we override
 * high risk" rollup on the team dashboard.
 *
 * A justification is required when overriding a HIGH or CRITICAL assessment —
 * not to obstruct the developer, but because that is exactly the decision a team
 * will want to revisit after an incident.
 */
export async function recordMergeDecision(
  auth: AuthContext,
  analysisId: string,
  input: {
    decision: MergeDecisionType;
    reason?: string;
    addressedRecommendationIds?: string[];
  },
): Promise<{ id: string }> {
  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, repository: repositoryAccessWhere(auth) },
    select: {
      id: true,
      status: true,
      riskScore: true,
      riskLevel: true,
      pullRequestId: true,
      repositoryId: true,
      pullRequest: { select: { number: true, title: true } },
      repository: { select: { fullName: true } },
      mergeDecision: { select: { id: true } },
    },
  });

  if (!analysis) throw notFound("Analysis");

  if (analysis.status !== "COMPLETED") {
    throw badRequest(
      "A merge decision can only be recorded once the analysis has completed.",
    );
  }

  const isHighRisk = analysis.riskLevel === "HIGH" || analysis.riskLevel === "CRITICAL";
  const isOverride = input.decision === "OVERRIDDEN" || input.decision === "APPROVED_MERGE";

  if (isHighRisk && isOverride && !input.reason?.trim()) {
    throw badRequest(
      `This analysis is ${analysis.riskLevel?.toLowerCase()} risk. ` +
        `Please record why you are proceeding, so the decision can be reviewed later.`,
    );
  }

  // Validate that the recommendation ids belong to this analysis, so a client
  // cannot record having addressed something unrelated.
  let addressed: string[] = [];
  if (input.addressedRecommendationIds?.length) {
    const valid = await prisma.recommendation.findMany({
      where: { analysisId, id: { in: input.addressedRecommendationIds } },
      select: { id: true },
    });
    addressed = valid.map((r) => r.id);
  }

  const data = {
    decision: input.decision,
    reason: input.reason?.trim().slice(0, 2000) ?? null,
    riskScoreAtDecision: analysis.riskScore,
    riskLevelAtDecision: analysis.riskLevel,
    addressedRecommendationIds: addressed,
    userId: auth.userId,
    pullRequestId: analysis.pullRequestId,
  };

  const decision = analysis.mergeDecision
    ? await prisma.mergeDecision.update({
        where: { analysisId },
        data,
        select: { id: true },
      })
    : await prisma.mergeDecision.create({
        data: { ...data, analysisId },
        select: { id: true },
      });

  await publishEvent({
    name: EVENT.mergeDecisionRecorded,
    rooms: [ROOM.analysis(analysisId), ROOM.repository(analysis.repositoryId)],
    payload: {
      analysisId,
      pullRequestId: analysis.pullRequestId,
      repositoryId: analysis.repositoryId,
      decision: input.decision,
      decidedBy: auth.githubLogin,
      createdAt: new Date().toISOString(),
    },
  });

  // A high-risk override is exactly the event a manager should hear about.
  if (isHighRisk && isOverride) {
    await createNotification({
      userId: auth.userId,
      type: "MERGE_DECISION_RECORDED",
      severity: "WARNING",
      title: `High-risk merge approved in ${analysis.repository.fullName}`,
      body:
        `#${analysis.pullRequest.number} (${analysis.riskLevel}, ` +
        `${Math.round(analysis.riskScore ?? 0)}/100) was approved by ${auth.githubLogin}.`,
      href: `/analyses/${analysisId}`,
      repositoryId: analysis.repositoryId,
      pullRequestId: analysis.pullRequestId,
      analysisId,
    });
  }

  log.info(
    {
      analysisId,
      decision: input.decision,
      riskLevel: analysis.riskLevel,
      by: auth.githubLogin,
    },
    "merge decision recorded",
  );

  return decision;
}

/**
 * Merge-readiness view.
 *
 * Deliberately does not tell the user what to do — it states the assessment,
 * what remains unaddressed, and whether a justification will be required. The
 * decision stays with the developer.
 */
export async function getMergeReadiness(auth: AuthContext, analysisId: string) {
  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, repository: repositoryAccessWhere(auth) },
    select: {
      id: true,
      status: true,
      riskScore: true,
      riskLevel: true,
      degraded: true,
      degradedReasons: true,
      scoredBy: true,
      pullRequest: {
        select: { number: true, state: true, draft: true, mergeable: true, mergedAt: true },
      },
      recommendations: {
        orderBy: { rank: "asc" },
        select: { id: true, title: true, priority: true, category: true },
      },
      mergeDecision: { select: { decision: true, createdAt: true, addressedRecommendationIds: true } },
    },
  });

  if (!analysis) throw notFound("Analysis");

  const addressed = new Set(analysis.mergeDecision?.addressedRecommendationIds ?? []);
  const outstanding = analysis.recommendations.filter((r) => !addressed.has(r.id));
  const blockingPriorities = outstanding.filter(
    (r) => r.priority === "CRITICAL" || r.priority === "HIGH",
  );

  const isHighRisk = analysis.riskLevel === "HIGH" || analysis.riskLevel === "CRITICAL";

  return {
    analysisId: analysis.id,
    status: analysis.status,
    riskScore: analysis.riskScore,
    riskLevel: analysis.riskLevel,
    scoredBy: analysis.scoredBy,
    degraded: analysis.degraded,
    degradedReasons: analysis.degradedReasons,
    pullRequestState: analysis.pullRequest.state,
    isDraft: analysis.pullRequest.draft,
    githubMergeable: analysis.pullRequest.mergeable,
    alreadyMerged: analysis.pullRequest.mergedAt !== null,
    outstandingRecommendations: outstanding,
    highPriorityOutstanding: blockingPriorities.length,
    /** A reason will be required to approve this. */
    justificationRequired: isHighRisk,
    highRiskThreshold: env.HIGH_RISK_NOTIFY_THRESHOLD,
    decision: analysis.mergeDecision,
  };
}
