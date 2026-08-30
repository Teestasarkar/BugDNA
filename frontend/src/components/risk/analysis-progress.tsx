"use client";

/**
 * Live analysis progress.
 *
 * An analysis takes seconds to tens of seconds, involves several GitHub round
 * trips and an inference call, and can fail in ways worth distinguishing. A bare
 * spinner would waste all of that information.
 *
 * So this renders the actual pipeline as a stepper, driven by Socket.io events,
 * with an HTTP polling fallback for clients whose websocket is blocked. Three
 * behaviours are deliberate:
 *
 *  - **A pending retry reads as "retrying", not "failed."** The queue may still
 *    have attempts left; telling the user it failed would make them re-click
 *    something already in progress.
 *  - **The stage names are the real ones.** "Retrieving diff from GitHub" tells a
 *    developer where the time is going, and where it stopped if it stops.
 *  - **A failure names the stage it failed at**, so "GitHub rate limit during
 *    FETCHING_DIFF" is diagnosable without opening a log.
 */
import * as React from "react";
import {
  AlertTriangle,
  Check,
  CircleDashed,
  Loader2,
  RefreshCw,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { PIPELINE_STAGES, STAGE_LABEL } from "@/lib/risk";
import { duration } from "@/lib/format";
import { useAnalysisStatus, useCancelAnalysis, useRetryAnalysis } from "@/hooks/use-api";
import { useLiveAnalysis } from "@/stores/analysis.store";
import { subscribeToAnalysis } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import type { AnalysisStage, AnalysisStatus } from "@/types/api";

/** Joins the analysis room for as long as the component is mounted. */
export function useWatchAnalysis(analysisId: string | null | undefined, active: boolean): void {
  React.useEffect(() => {
    if (!analysisId || !active) return;
    return subscribeToAnalysis(analysisId);
  }, [analysisId, active]);
}

export interface AnalysisProgressProps {
  analysisId: string;
  /** Status from the server, used until a socket event supersedes it. */
  initialStatus?: AnalysisStatus;
  initialStage?: AnalysisStage | null;
  initialProgress?: number;
  showActions?: boolean;
  className?: string;
}

export function AnalysisProgress({
  analysisId,
  initialStatus = "QUEUED",
  initialStage = null,
  initialProgress = 0,
  showActions = true,
  className,
}: AnalysisProgressProps) {
  const live = useLiveAnalysis(analysisId);

  // Prefer the socket's view; fall back to what the page was rendered with.
  const status = live?.status ?? initialStatus;
  const stage = live?.stage ?? initialStage;
  const progress = live?.progress ?? initialProgress;

  const inFlight = status === "QUEUED" || status === "RUNNING";

  useWatchAnalysis(analysisId, inFlight);

  // Polling fallback. Only runs while in flight, and only matters when the
  // websocket never connected — otherwise the socket is always ahead of it.
  const { data: polled } = useAnalysisStatus(analysisId, inFlight);

  const effectiveStatus = live ? status : (polled?.status ?? status);
  const effectiveStage = live?.stage ?? (polled?.stage ?? stage);
  const effectiveProgress = live?.progress ?? (polled?.progress ?? progress);

  const retry = useRetryAnalysis();
  const cancel = useCancelAnalysis();

  const willRetry = live?.willRetry ?? false;
  const errorMessage = live?.errorMessage ?? polled?.errorMessage ?? null;
  const errorCode = live?.errorCode ?? polled?.errorCode ?? null;
  const attempts = live?.attempts ?? polled?.attempts ?? 0;

  // ---- failed -------------------------------------------------------------
  if (effectiveStatus === "FAILED" && !willRetry) {
    return (
      <div
        className={cn(
          "space-y-3 rounded-lg border border-risk-critical-border bg-risk-critical-bg p-4",
          className,
        )}
        role="alert"
      >
        <div className="flex items-start gap-2.5">
          <XCircle className="mt-0.5 size-4 shrink-0 text-risk-critical" aria-hidden />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium text-risk-critical">
              Analysis failed
              {effectiveStage && (
                <span className="font-normal opacity-80">
                  {" "}
                  during {STAGE_LABEL[effectiveStage]?.toLowerCase() ?? effectiveStage}
                </span>
              )}
            </p>
            {errorMessage && (
              <p className="text-xs leading-relaxed text-risk-critical/85">{errorMessage}</p>
            )}
            <p className="font-mono text-[0.6875rem] text-risk-critical/60">
              {errorCode}
              {attempts > 0 && ` · ${attempts} attempt${attempts === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>

        {showActions && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => retry.mutate(analysisId)}
            loading={retry.isPending}
          >
            <RefreshCw />
            Run it again
          </Button>
        )}
      </div>
    );
  }

  // ---- cancelled ----------------------------------------------------------
  if (effectiveStatus === "CANCELLED") {
    return (
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-lg border border-border bg-muted/40 p-4",
          className,
        )}
      >
        <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="flex-1 text-sm text-muted-foreground">This analysis was cancelled.</p>
        {showActions && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => retry.mutate(analysisId)}
            loading={retry.isPending}
          >
            Run again
          </Button>
        )}
      </div>
    );
  }

  // ---- in flight ----------------------------------------------------------
  if (!inFlight && effectiveStatus === "COMPLETED") return null;

  const currentIndex = effectiveStage
    ? PIPELINE_STAGES.indexOf(effectiveStage as (typeof PIPELINE_STAGES)[number])
    : -1;

  return (
    <div className={cn("space-y-4 rounded-lg border border-border bg-card p-4", className)}>
      {/* --- headline ------------------------------------------------------ */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" aria-hidden />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">
              {willRetry
                ? `Retrying — attempt ${attempts + 1}`
                : effectiveStatus === "QUEUED"
                  ? "Queued"
                  : "Analysing this pull request"}
            </p>
            <p className="text-xs text-muted-foreground">
              {live?.message ??
                (effectiveStage
                  ? STAGE_LABEL[effectiveStage]
                  : "Waiting for a worker to pick this up")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="tabular text-sm font-semibold text-muted-foreground">
            {Math.round(effectiveProgress)}%
          </span>
          {showActions && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => cancel.mutate(analysisId)}
              disabled={cancel.isPending}
              aria-label="Cancel analysis"
            >
              <X />
            </Button>
          )}
        </div>
      </div>

      <Progress value={effectiveProgress} />

      {/* --- pipeline stepper --------------------------------------------- */}
      <ol className="grid gap-1.5">
        {PIPELINE_STAGES.filter((s) => s !== "DONE").map((pipelineStage, index) => {
          const done = currentIndex > index;
          const active = currentIndex === index;

          return (
            <li
              key={pipelineStage}
              className={cn(
                "flex items-center gap-2.5 text-xs transition-colors",
                done && "text-muted-foreground",
                active && "font-medium text-foreground",
                !done && !active && "text-muted-foreground/50",
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {done ? (
                  <Check className="size-3.5 text-risk-low" aria-hidden />
                ) : active ? (
                  <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
                ) : (
                  <span className="size-1.5 rounded-full bg-current opacity-40" aria-hidden />
                )}
              </span>
              {STAGE_LABEL[pipelineStage]}
            </li>
          );
        })}
      </ol>

      {willRetry && errorMessage && (
        <div className="flex items-start gap-2 rounded-md border border-risk-moderate-border bg-risk-moderate-bg px-3 py-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-risk-moderate" aria-hidden />
          <p className="text-xs leading-relaxed text-risk-moderate">
            Previous attempt failed: {errorMessage}. The queue is retrying with backoff.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Inline pill for list rows.
 *
 * The pull request list can have several analyses in flight; a full stepper per
 * row would be unreadable, but a silent row would be worse.
 */
export function AnalysisProgressPill({
  analysisId,
  status,
  progress,
  className,
}: {
  analysisId: string;
  status: AnalysisStatus;
  progress: number;
  className?: string;
}) {
  const live = useLiveAnalysis(analysisId);

  const effectiveStatus = live?.status ?? status;
  const effectiveProgress = live?.progress ?? progress;
  const inFlight = effectiveStatus === "QUEUED" || effectiveStatus === "RUNNING";

  useWatchAnalysis(analysisId, inFlight);

  if (!inFlight) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-primary/25 bg-primary/5",
        "px-1.5 py-0.5 text-[0.6875rem] font-medium text-primary",
        className,
      )}
    >
      <Loader2 className="size-3 animate-spin" aria-hidden />
      {live?.willRetry
        ? "Retrying"
        : effectiveStatus === "QUEUED"
          ? "Queued"
          : `${Math.round(effectiveProgress)}%`}
    </span>
  );
}

/**
 * Per-stage timing trace, from the persisted AnalysisEvent rows.
 *
 * Shown on a completed analysis. It is the answer to "why did that take 40
 * seconds" — almost always the GitHub diff fetch, and being able to see that
 * rather than guess is the difference between a tool you trust and one you don't.
 */
export function AnalysisTimingTrace({
  events,
  totalMs,
  className,
}: {
  events: Array<{
    id: string;
    stage: AnalysisStage;
    status: AnalysisStatus;
    message: string | null;
    durationMs: number | null;
  }>;
  totalMs: number | null;
  className?: string;
}) {
  const timed = events.filter((event) => event.durationMs !== null && event.durationMs > 0);
  if (timed.length === 0) return null;

  const slowest = Math.max(...timed.map((event) => event.durationMs ?? 0), 1);

  return (
    <div className={cn("space-y-2", className)}>
      {timed.map((event) => (
        <div key={event.id} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-muted-foreground">
              {STAGE_LABEL[event.stage] ?? event.stage}
            </span>
            <span className="tabular shrink-0 font-medium text-muted-foreground">
              {duration(event.durationMs)}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-chart-2"
              style={{ width: `${((event.durationMs ?? 0) / slowest) * 100}%` }}
            />
          </div>
        </div>
      ))}

      {totalMs !== null && (
        <p className="pt-1 text-xs text-muted-foreground">
          Total <span className="tabular font-medium">{duration(totalMs)}</span>
        </p>
      )}
    </div>
  );
}
