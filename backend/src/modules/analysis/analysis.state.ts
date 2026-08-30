/**
 * Analysis state transitions.
 *
 * One place that owns "the analysis moved to stage X", because that fact has to
 * land in three systems at once and they must not disagree:
 *
 *  - **Postgres** — the durable record. A client that reloads mid-analysis reads
 *    the current stage from here, so progress survives a refresh.
 *  - **Redis** — transient live state with a TTL, cheap to read on every poll
 *    and reconstructible from Postgres if it is lost.
 *  - **Socket.io** (via the Redis bus) — the push so a watching client updates
 *    without polling at all.
 *
 * Postgres is written first and is authoritative. Redis and the realtime push
 * are best-effort: losing either costs a live update, never correctness.
 */
import { prisma } from "../../lib/prisma";
import { scoped } from "../../lib/logger";
import { stateSet } from "../../lib/cache";
import { publishEvent } from "../../realtime/bus";
import { EVENT, ROOM } from "../../realtime/events";
import { ANALYSIS_STATE_TTL_SECONDS, CACHE_KEYS, STAGE_PROGRESS } from "../../config/constants";

const log = scoped("analysis-state");

export type AnalysisStage =
  | "NORMALIZING"
  | "FETCHING_DIFF"
  | "EXTRACTING_FEATURES"
  | "PREDICTING"
  | "EXPLAINING"
  | "RECOMMENDING"
  | "PERSISTING"
  | "DONE";

export type AnalysisStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

/** Human-readable text shown next to the progress bar for each stage. */
const STAGE_MESSAGE: Record<AnalysisStage, string> = {
  NORMALIZING: "Reading pull request metadata",
  FETCHING_DIFF: "Retrieving changed files from GitHub",
  EXTRACTING_FEATURES: "Extracting risk signals from the diff",
  PREDICTING: "Scoring with the risk model",
  EXPLAINING: "Working out which factors drove the score",
  RECOMMENDING: "Producing mitigation suggestions",
  PERSISTING: "Saving results",
  DONE: "Complete",
};

export interface StageContext {
  analysisId: string;
  repositoryId: string;
  pullRequestId: string;
}

/**
 * Record entry into a pipeline stage.
 *
 * Also appends an `AnalysisEvent` row, which gives the UI a real answer to
 * "where did this fail" instead of a bare FAILED status, and doubles as a
 * per-stage timing trace.
 */
export async function enterStage(
  ctx: StageContext,
  stage: AnalysisStage,
  options: { previousStageStartedAt?: number; message?: string } = {},
): Promise<number> {
  const now = Date.now();
  const progress = STAGE_PROGRESS[stage] ?? 0;
  const message = options.message ?? STAGE_MESSAGE[stage];

  try {
    await prisma.analysis.update({
      where: { id: ctx.analysisId },
      data: { stage, progress, status: "RUNNING" },
    });

    await prisma.analysisEvent.create({
      data: {
        analysisId: ctx.analysisId,
        stage,
        status: "RUNNING",
        message,
        durationMs: options.previousStageStartedAt
          ? now - options.previousStageStartedAt
          : null,
      },
    });
  } catch (e) {
    log.warn({ err: e, analysisId: ctx.analysisId, stage }, "failed to record stage entry");
  }

  await stateSet(
    CACHE_KEYS.analysisState(ctx.analysisId),
    { status: "RUNNING", stage, progress, message, updatedAt: new Date().toISOString() },
    ANALYSIS_STATE_TTL_SECONDS,
  );

  await publishEvent({
    name: EVENT.analysisProgress,
    rooms: [ROOM.analysis(ctx.analysisId), ROOM.repository(ctx.repositoryId)],
    payload: {
      analysisId: ctx.analysisId,
      repositoryId: ctx.repositoryId,
      pullRequestId: ctx.pullRequestId,
      status: "RUNNING",
      stage,
      progress,
      message,
    },
  });

  return now;
}

/** Mark the analysis as started, separately from the first stage. */
export async function markRunning(ctx: StageContext, attempt: number): Promise<void> {
  await prisma.analysis.update({
    where: { id: ctx.analysisId },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      attempts: attempt,
      // Clear any error from a previous attempt so a successful retry does not
      // leave a stale message behind.
      errorCode: null,
      errorMessage: null,
    },
  });
}

/**
 * Persist a terminal failure.
 *
 * `willRetry` is passed through to the client so the UI can say "retrying"
 * rather than "failed" while BullMQ still has attempts left — the difference
 * between a user waiting and a user re-clicking.
 */
export async function markFailed(
  ctx: StageContext,
  error: { code: string; message: string; retryable: boolean },
  meta: { attempt: number; willRetry: boolean; stage?: AnalysisStage },
): Promise<void> {
  try {
    await prisma.analysis.update({
      where: { id: ctx.analysisId },
      data: {
        // Keep it RUNNING while a retry is pending, so the UI does not flash a
        // failure that is about to be superseded.
        status: meta.willRetry ? "RUNNING" : "FAILED",
        errorCode: error.code,
        errorMessage: error.message.slice(0, 2000),
        attempts: meta.attempt,
        ...(meta.willRetry ? {} : { completedAt: new Date() }),
      },
    });

    await prisma.analysisEvent.create({
      data: {
        analysisId: ctx.analysisId,
        stage: meta.stage ?? "NORMALIZING",
        status: meta.willRetry ? "RUNNING" : "FAILED",
        message: error.message.slice(0, 1000),
        metadata: { code: error.code, retryable: error.retryable, attempt: meta.attempt } as never,
      },
    });
  } catch (e) {
    log.error({ err: e, analysisId: ctx.analysisId }, "failed to record analysis failure");
  }

  await stateSet(
    CACHE_KEYS.analysisState(ctx.analysisId),
    {
      status: meta.willRetry ? "RUNNING" : "FAILED",
      errorCode: error.code,
      errorMessage: error.message,
      willRetry: meta.willRetry,
      updatedAt: new Date().toISOString(),
    },
    ANALYSIS_STATE_TTL_SECONDS,
  );

  await publishEvent({
    name: EVENT.analysisFailed,
    rooms: [ROOM.analysis(ctx.analysisId), ROOM.repository(ctx.repositoryId)],
    payload: {
      analysisId: ctx.analysisId,
      repositoryId: ctx.repositoryId,
      pullRequestId: ctx.pullRequestId,
      status: "FAILED",
      errorCode: error.code,
      errorMessage: error.message,
      retryable: error.retryable,
      attempts: meta.attempt,
      willRetry: meta.willRetry,
    },
  });
}

/** Publish completion. The row itself is written by the pipeline's transaction. */
export async function announceCompleted(
  ctx: StageContext,
  result: {
    pullRequestNumber: number;
    riskScore: number;
    riskLevel: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
    scoredBy: "MODEL" | "HEURISTIC";
    degraded: boolean;
    topFactors: Array<{ key: string; label: string; contribution: number }>;
    durationMs: number;
  },
): Promise<void> {
  await stateSet(
    CACHE_KEYS.analysisState(ctx.analysisId),
    {
      status: "COMPLETED",
      stage: "DONE",
      progress: 100,
      riskScore: result.riskScore,
      riskLevel: result.riskLevel,
      updatedAt: new Date().toISOString(),
    },
    ANALYSIS_STATE_TTL_SECONDS,
  );

  await publishEvent({
    name: EVENT.analysisCompleted,
    rooms: [ROOM.analysis(ctx.analysisId), ROOM.repository(ctx.repositoryId)],
    payload: {
      analysisId: ctx.analysisId,
      repositoryId: ctx.repositoryId,
      pullRequestId: ctx.pullRequestId,
      pullRequestNumber: result.pullRequestNumber,
      status: "COMPLETED",
      riskScore: result.riskScore,
      riskLevel: result.riskLevel,
      scoredBy: result.scoredBy,
      degraded: result.degraded,
      topFactors: result.topFactors,
      durationMs: result.durationMs,
      completedAt: new Date().toISOString(),
    },
  });
}

/** Announce a freshly queued analysis so the PR list updates immediately. */
export async function announceQueued(
  ctx: StageContext,
  meta: { pullRequestNumber: number; headSha: string },
): Promise<void> {
  await stateSet(
    CACHE_KEYS.analysisState(ctx.analysisId),
    { status: "QUEUED", progress: 0, updatedAt: new Date().toISOString() },
    ANALYSIS_STATE_TTL_SECONDS,
  );

  await publishEvent({
    name: EVENT.analysisQueued,
    rooms: [ROOM.analysis(ctx.analysisId), ROOM.repository(ctx.repositoryId)],
    payload: {
      analysisId: ctx.analysisId,
      pullRequestId: ctx.pullRequestId,
      repositoryId: ctx.repositoryId,
      pullRequestNumber: meta.pullRequestNumber,
      headSha: meta.headSha,
      status: "QUEUED",
      queuedAt: new Date().toISOString(),
    },
  });
}

export { STAGE_MESSAGE };
