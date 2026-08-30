/**
 * The risk-analysis pipeline.
 *
 * This is the sequence the product exists to run:
 *
 *   normalise PR  ->  fetch diff  ->  extract features  ->  score (XGBoost)
 *      ->  explain (SHAP)  ->  recommend  ->  persist
 *
 * It runs inside a BullMQ worker, never in an HTTP request, because a single
 * analysis involves several GitHub round trips plus an inference call and can
 * take tens of seconds. The HTTP layer only enqueues and reports status.
 *
 * Failure policy
 * --------------
 * Stages fail in two distinct ways and the distinction is preserved end to end:
 *
 *  - **Retryable** (GitHub 5xx, ML cold start, network): thrown, so BullMQ
 *    retries with backoff. The analysis stays RUNNING and the UI says "retrying".
 *  - **Terminal** (feature/model contract mismatch, PR deleted, token revoked):
 *    recorded as FAILED immediately, because retrying cannot help and leaving a
 *    job spinning is worse than a clear error.
 *
 * Degradation is a third, separate case: the analysis *completes* but some input
 * was incomplete (diff truncated, no repository history yet). Those runs are
 * marked `degraded` with reasons, and the UI discloses them rather than
 * presenting a partial assessment as a full one.
 */
import { prisma } from "../../lib/prisma";
import { scoped } from "../../lib/logger";
import { env } from "../../config/env";
import { AppError, isAppError, errorMessage } from "../../lib/errors";
import { cacheDelPattern } from "../../lib/cache";
import { scoreToRiskLevel } from "../../config/constants";
import { ingestPullRequestDiff } from "../github/github.service";
import { extractFeaturesForPullRequest } from "./features/extract";
import { predict } from "../ml/ml.client";
import { buildExplanation } from "./explain/explain";
import { buildRecommendations } from "./recommend/rules";
import {
  announceCompleted,
  enterStage,
  markFailed,
  markRunning,
  type AnalysisStage,
  type StageContext,
} from "./analysis.state";
import { notifyRepositoryAudience, createNotification } from "../notifications/notification.service";

const log = scoped("pipeline");

export interface AnalysisJobData {
  analysisId: string;
  /** The user whose GitHub credential is used for the diff fetch. */
  userId: string;
  repositoryId: string;
  pullRequestId: string;
  pullRequestNumber: number;
  headSha: string;
}

export interface PipelineResult {
  analysisId: string;
  riskScore: number;
  riskLevel: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  scoredBy: "MODEL" | "HEURISTIC";
  degraded: boolean;
  durationMs: number;
}

/**
 * Run one analysis to completion.
 *
 * `attempt` and `willRetry` come from the queue, so the pipeline can report
 * accurately whether a failure is final without knowing about BullMQ.
 */
export async function runAnalysis(
  data: AnalysisJobData,
  queueMeta: { attempt: number; maxAttempts: number },
): Promise<PipelineResult> {
  const started = Date.now();
  const ctx: StageContext = {
    analysisId: data.analysisId,
    repositoryId: data.repositoryId,
    pullRequestId: data.pullRequestId,
  };

  let currentStage: AnalysisStage = "NORMALIZING";
  const degradedReasons: string[] = [];

  try {
    await markRunning(ctx, queueMeta.attempt);

    // ---- 1. normalise ----------------------------------------------------
    currentStage = "NORMALIZING";
    let stageStart = await enterStage(ctx, currentStage);

    const repository = await prisma.repository.findUnique({
      where: { id: data.repositoryId },
      select: { id: true, fullName: true, owner: true, name: true, ownerUserId: true },
    });

    if (!repository) {
      // The repository was disconnected while the job sat in the queue. Nothing
      // to retry against.
      throw new AppError(404, "The repository was disconnected before this analysis ran.", {
        code: "NOT_FOUND",
        retryable: false,
      });
    }

    // ---- 2. fetch diff ---------------------------------------------------
    currentStage = "FETCHING_DIFF";
    stageStart = await enterStage(ctx, currentStage, { previousStageStartedAt: stageStart });

    const ingested = await ingestPullRequestDiff(
      data.userId,
      data.repositoryId,
      data.pullRequestNumber,
    );
    degradedReasons.push(...ingested.degradedReasons);

    // The head SHA can move between queueing and execution if the author pushed.
    // Analysing the newer commit is the useful behaviour; recording the drift
    // keeps the result honest about what was actually assessed.
    if (ingested.headSha !== data.headSha) {
      degradedReasons.push(
        `The pull request was updated while this analysis was queued. ` +
          `Assessed commit ${ingested.headSha.slice(0, 7)} rather than ${data.headSha.slice(0, 7)}.`,
      );
      await prisma.analysis.update({
        where: { id: data.analysisId },
        data: { headSha: ingested.headSha },
      });
    }

    // ---- 3. extract features --------------------------------------------
    currentStage = "EXTRACTING_FEATURES";
    stageStart = await enterStage(ctx, currentStage, { previousStageStartedAt: stageStart });

    const extraction = await extractFeaturesForPullRequest(data.pullRequestId);
    degradedReasons.push(...extraction.degradedReasons);

    // ---- 4. predict ------------------------------------------------------
    currentStage = "PREDICTING";
    stageStart = await enterStage(ctx, currentStage, { previousStageStartedAt: stageStart });

    const prediction = await predict({
      feature_set_version: extraction.featureSetVersion,
      features: extraction.features,
      context: {
        analysis_id: data.analysisId,
        repository: repository.fullName,
        pull_request_number: data.pullRequestNumber,
      },
      max_contributions: 16,
    });

    const scoredBy = prediction.model.engine === "heuristic" ? "HEURISTIC" : "MODEL";

    if (scoredBy === "HEURISTIC") {
      degradedReasons.push(
        "No trained model artifact was available, so this score came from the transparent " +
          "rule-based fallback scorer rather than the XGBoost model.",
      );
    }

    if (prediction.warnings.length > 0) {
      degradedReasons.push(...prediction.warnings);
    }

    // The band is a product decision, applied here rather than trusting the
    // service, so the vocabulary cannot drift between components.
    const riskScore = Math.max(0, Math.min(100, prediction.prediction.risk_score));
    const riskLevel = scoreToRiskLevel(riskScore);

    // ---- 5. explain ------------------------------------------------------
    currentStage = "EXPLAINING";
    stageStart = await enterStage(ctx, currentStage, { previousStageStartedAt: stageStart });

    const explanation = buildExplanation({
      contributions: prediction.explanation.contributions,
      features: extraction.features,
      evidence: extraction.evidence,
      explanation: prediction.explanation,
      riskScore,
      riskLevel,
      pullRequest: {
        number: extraction.pullRequest.number,
        authorLogin: extraction.pullRequest.authorLogin,
        title: extraction.pullRequest.title,
      },
      scoredBy,
      degradedReasons,
    });

    // ---- 6. recommend ----------------------------------------------------
    currentStage = "RECOMMENDING";
    stageStart = await enterStage(ctx, currentStage, { previousStageStartedAt: stageStart });

    const recommendations = buildRecommendations({
      features: extraction.features,
      evidence: extraction.evidence,
      factors: explanation.factors,
      riskLevel,
      riskScore,
      modules: extraction.modules,
      pullRequest: {
        number: extraction.pullRequest.number,
        authorLogin: extraction.pullRequest.authorLogin,
        title: extraction.pullRequest.title,
      },
    });

    // ---- 7. persist ------------------------------------------------------
    currentStage = "PERSISTING";
    stageStart = await enterStage(ctx, currentStage, { previousStageStartedAt: stageStart });

    const durationMs = Date.now() - started;
    const degraded = degradedReasons.length > 0;

    // One transaction: an analysis is never visible as COMPLETED without its
    // factors and recommendations, which would render as an empty results page.
    await prisma.$transaction(async (tx) => {
      // Re-running the same analysis id (a retry) must not duplicate children.
      await tx.riskFactor.deleteMany({ where: { analysisId: data.analysisId } });
      await tx.recommendation.deleteMany({ where: { analysisId: data.analysisId } });

      await tx.analysis.update({
        where: { id: data.analysisId },
        data: {
          status: "COMPLETED",
          stage: "DONE",
          progress: 100,
          riskScore,
          riskLevel,
          probability: prediction.prediction.probability,
          confidence: prediction.prediction.confidence,
          scoredBy,
          modelName: prediction.model.name,
          modelVersion: prediction.model.version,
          features: extraction.features as never,
          featureSetVersion: extraction.featureSetVersion,
          summary: explanation.summary,
          completedAt: new Date(),
          durationMs,
          degraded,
          degradedReasons,
          errorCode: null,
          errorMessage: null,
        },
      });

      if (explanation.factors.length > 0) {
        await tx.riskFactor.createMany({
          data: explanation.factors.map((factor) => ({
            analysisId: data.analysisId,
            key: factor.key,
            label: factor.label,
            value: factor.value,
            displayValue: factor.displayValue,
            shapValue: factor.shapValue,
            contribution: factor.contribution,
            direction: factor.direction,
            category: factor.category,
            description: factor.description,
            evidence: (factor.evidence ?? undefined) as never,
            rank: factor.rank,
          })),
        });
      }

      if (recommendations.length > 0) {
        await tx.recommendation.createMany({
          data: recommendations.map((rec, index) => ({
            analysisId: data.analysisId,
            title: rec.title,
            description: rec.description,
            rationale: rec.rationale,
            category: rec.category,
            priority: rec.priority,
            effort: rec.effort,
            triggeredByFactorKeys: rec.triggeredByFactorKeys,
            targets: (rec.targets ?? undefined) as never,
            rank: index + 1,
          })),
        });
      }

      await tx.analysisEvent.create({
        data: {
          analysisId: data.analysisId,
          stage: "DONE",
          status: "COMPLETED",
          message: `Scored ${Math.round(riskScore)}/100 (${riskLevel})`,
          durationMs: Date.now() - stageStart,
          metadata: {
            factors: explanation.factors.length,
            recommendations: recommendations.length,
            scoredBy,
          } as never,
        },
      });
    });

    // Analytics for this repository are now stale.
    await cacheDelPattern(`cache:analytics:repo:${data.repositoryId}:*`);
    await cacheDelPattern(`cache:dashboard:*`);

    // ---- notify ----------------------------------------------------------
    const topFactors = explanation.factors
      .filter((factor) => factor.direction === "INCREASES_RISK")
      .slice(0, 3)
      .map((factor) => ({
        key: factor.key,
        label: factor.label,
        contribution: factor.contribution,
      }));

    await announceCompleted(ctx, {
      pullRequestNumber: extraction.pullRequest.number,
      riskScore,
      riskLevel,
      scoredBy,
      degraded,
      topFactors,
      durationMs,
    });

    await emitCompletionNotifications({
      userId: data.userId,
      repositoryId: data.repositoryId,
      repositoryFullName: repository.fullName,
      analysisId: data.analysisId,
      pullRequestId: data.pullRequestId,
      pullRequestNumber: extraction.pullRequest.number,
      pullRequestTitle: extraction.pullRequest.title,
      riskScore,
      riskLevel,
    });

    log.info(
      {
        analysisId: data.analysisId,
        repository: repository.fullName,
        pullRequest: data.pullRequestNumber,
        riskScore,
        riskLevel,
        scoredBy,
        factors: explanation.factors.length,
        recommendations: recommendations.length,
        degraded,
        durationMs,
      },
      "analysis completed",
    );

    return { analysisId: data.analysisId, riskScore, riskLevel, scoredBy, degraded, durationMs };
  } catch (e) {
    const appError = isAppError(e)
      ? e
      : new AppError(500, errorMessage(e), { code: "ANALYSIS_FAILED", retryable: true, cause: e });

    const willRetry = appError.retryable && queueMeta.attempt < queueMeta.maxAttempts;

    log.error(
      {
        analysisId: data.analysisId,
        stage: currentStage,
        code: appError.code,
        attempt: queueMeta.attempt,
        maxAttempts: queueMeta.maxAttempts,
        willRetry,
        err: appError.cause ?? appError,
      },
      `analysis failed during ${currentStage}: ${appError.message}`,
    );

    await markFailed(
      ctx,
      { code: appError.code, message: appError.message, retryable: appError.retryable },
      { attempt: queueMeta.attempt, willRetry, stage: currentStage },
    );

    if (!willRetry) {
      await createNotification({
        userId: data.userId,
        type: "ANALYSIS_FAILED",
        severity: "WARNING",
        title: `Analysis failed for pull request #${data.pullRequestNumber}`,
        body: appError.message,
        href: `/analyses/${data.analysisId}`,
        repositoryId: data.repositoryId,
        pullRequestId: data.pullRequestId,
        analysisId: data.analysisId,
        metadata: { code: appError.code, retryable: appError.retryable },
      });
    }

    // Rethrow only when a retry should happen; a terminal failure is already
    // recorded, and rethrowing would make BullMQ burn its remaining attempts.
    if (willRetry) throw appError;

    return {
      analysisId: data.analysisId,
      riskScore: 0,
      riskLevel: "LOW",
      scoredBy: "MODEL",
      degraded: true,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Notify on completion.
 *
 * A low-risk result notifies only the person who asked, whereas a high-risk one
 * reaches everyone who can see the repository — that is the behaviour an
 * engineering manager actually wants, and it is why the threshold is
 * configurable rather than hard-coded.
 */
async function emitCompletionNotifications(args: {
  userId: string;
  repositoryId: string;
  repositoryFullName: string;
  analysisId: string;
  pullRequestId: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  riskScore: number;
  riskLevel: string;
}): Promise<void> {
  const href = `/analyses/${args.analysisId}`;
  const isHighRisk = args.riskScore >= env.HIGH_RISK_NOTIFY_THRESHOLD;

  await createNotification({
    userId: args.userId,
    type: "ANALYSIS_COMPLETED",
    severity: isHighRisk ? "WARNING" : "SUCCESS",
    title: `#${args.pullRequestNumber} scored ${Math.round(args.riskScore)}/100 (${args.riskLevel})`,
    body: args.pullRequestTitle,
    href,
    repositoryId: args.repositoryId,
    pullRequestId: args.pullRequestId,
    analysisId: args.analysisId,
    metadata: { riskScore: args.riskScore, riskLevel: args.riskLevel },
  });

  if (isHighRisk) {
    await notifyRepositoryAudience(
      args.repositoryId,
      {
        type: "HIGH_RISK_PR",
        severity: args.riskLevel === "CRITICAL" ? "CRITICAL" : "WARNING",
        title: `High-risk pull request in ${args.repositoryFullName}`,
        body:
          `#${args.pullRequestNumber} "${args.pullRequestTitle}" scored ` +
          `${Math.round(args.riskScore)}/100 (${args.riskLevel}).`,
        href,
        pullRequestId: args.pullRequestId,
        analysisId: args.analysisId,
      },
      // The requester already got the completion notification above.
      { excludeUserId: args.userId },
    );
  }
}
