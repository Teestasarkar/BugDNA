"use client";

/**
 * Realtime bridge.
 *
 * Mounted once, near the root. It is the single place where socket events are
 * translated into (a) live progress in the Zustand store and (b) cache
 * invalidations in TanStack Query.
 *
 * Keeping this in one hook rather than scattering `socket.on` calls through
 * components matters: an event that arrives while the relevant page is unmounted
 * still updates the cache and the notification count, so navigating back shows
 * the truth rather than a stale snapshot.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  EVENT,
  getSocket,
  onEvent,
  onResync,
  type AnalysisCompletedPayload,
  type AnalysisFailedPayload,
  type AnalysisProgressPayload,
  type AnalysisQueuedPayload,
  type DeploymentRecordedPayload,
  type MergeDecisionRecordedPayload,
  type NotificationCreatedPayload,
  type RepositorySyncFailedPayload,
  type RepositorySyncedPayload,
} from "@/lib/realtime";
import { analysisCompletionKeys, qk } from "@/lib/query-keys";
import { useAnalysisStore } from "@/stores/analysis.store";
import { toast } from "@/stores/toast.store";
import { RISK_PRESENTATION } from "@/lib/risk";

export function useRealtime(enabled: boolean): void {
  const queryClient = useQueryClient();
  const upsert = useAnalysisStore((state) => state.upsert);

  useEffect(() => {
    if (!enabled) return;

    // Opens the connection if it is not already open.
    const socket = getSocket();
    if (!socket) return;

    const invalidateAll = () => {
      for (const key of analysisCompletionKeys()) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    };

    const disposers: Array<() => void> = [];

    // ---- analysis lifecycle ------------------------------------------------

    disposers.push(
      onEvent(EVENT.analysisQueued, (payload: AnalysisQueuedPayload) => {
        upsert({
          analysisId: payload.analysisId,
          repositoryId: payload.repositoryId,
          pullRequestId: payload.pullRequestId,
          status: "QUEUED",
          stage: null,
          progress: 0,
        });

        // The PR list shows a "queued" pill, so it needs to know.
        void queryClient.invalidateQueries({ queryKey: qk.pulls.all });
      }),
    );

    disposers.push(
      onEvent(EVENT.analysisProgress, (payload: AnalysisProgressPayload) => {
        // Progress is deliberately NOT written to the query cache. It changes
        // several times a second and would invalidate constantly; the store is
        // the right home for transient state.
        upsert({
          analysisId: payload.analysisId,
          repositoryId: payload.repositoryId,
          pullRequestId: payload.pullRequestId,
          status: payload.status,
          stage: payload.stage as never,
          progress: payload.progress,
          message: payload.message,
        });
      }),
    );

    disposers.push(
      onEvent(EVENT.analysisCompleted, (payload: AnalysisCompletedPayload) => {
        upsert({
          analysisId: payload.analysisId,
          repositoryId: payload.repositoryId,
          pullRequestId: payload.pullRequestId,
          status: "COMPLETED",
          stage: "DONE",
          progress: 100,
          riskScore: payload.riskScore,
          riskLevel: payload.riskLevel,
          scoredBy: payload.scoredBy,
          degraded: payload.degraded,
          topFactors: payload.topFactors,
          durationMs: payload.durationMs,
        });

        // Now refetch the authoritative record — the socket payload is a summary,
        // not the full analysis with factors and recommendations.
        invalidateAll();

        const presentation = RISK_PRESENTATION[payload.riskLevel];

        toast.show({
          // Reusing the analysis id replaces any "queued"/"running" toast rather
          // than stacking a second one for the same event.
          id: `analysis-${payload.analysisId}`,
          title: `Analysis complete — #${payload.pullRequestNumber}`,
          description: presentation.summary,
          variant: payload.riskLevel === "LOW" ? "success" : "warning",
          riskLevel: payload.riskLevel,
          riskScore: payload.riskScore,
          action: { label: "View analysis", href: `/analyses/${payload.analysisId}` },
        });
      }),
    );

    disposers.push(
      onEvent(EVENT.analysisFailed, (payload: AnalysisFailedPayload) => {
        upsert({
          analysisId: payload.analysisId,
          repositoryId: payload.repositoryId,
          pullRequestId: payload.pullRequestId,
          // While the queue still has attempts, this is not a failure yet.
          status: payload.willRetry ? "RUNNING" : "FAILED",
          errorCode: payload.errorCode,
          errorMessage: payload.errorMessage,
          retryable: payload.retryable,
          willRetry: payload.willRetry,
          attempts: payload.attempts,
        });

        if (payload.willRetry) {
          // Not an error the user needs to act on — say what is happening.
          toast.show({
            id: `analysis-${payload.analysisId}`,
            title: `Retrying analysis (attempt ${payload.attempts + 1})`,
            description: payload.errorMessage,
            variant: "loading",
          });
          return;
        }

        invalidateAll();

        toast.error(`Analysis failed`, {
          id: `analysis-${payload.analysisId}`,
          description: payload.errorMessage,
          action: { label: "Open", href: `/analyses/${payload.analysisId}` },
        });
      }),
    );

    // ---- notifications -----------------------------------------------------

    disposers.push(
      onEvent(EVENT.notificationCreated, (payload: NotificationCreatedPayload) => {
        // Write the count straight into the cache so the badge updates without a
        // round trip, then let the list refetch in the background.
        queryClient.setQueryData(qk.notifications.unreadCount(), {
          unreadCount: payload.unreadCount,
        });
        void queryClient.invalidateQueries({ queryKey: qk.notifications.all });

        // Only genuinely important notifications interrupt with a toast. An
        // ANALYSIS_COMPLETED notification is already covered by the event above,
        // and toasting both would double up.
        if (payload.type === "HIGH_RISK_PR" || payload.severity === "CRITICAL") {
          toast.show({
            id: `notification-${payload.id}`,
            title: payload.title,
            description: payload.body ?? undefined,
            variant: payload.severity === "CRITICAL" ? "danger" : "warning",
            ...(payload.href ? { action: { label: "View", href: payload.href } } : {}),
          });
        }
      }),
    );

    // ---- repositories ------------------------------------------------------

    disposers.push(
      onEvent(EVENT.repositorySynced, (payload: RepositorySyncedPayload) => {
        void queryClient.invalidateQueries({ queryKey: qk.repositories.all });
        void queryClient.invalidateQueries({ queryKey: qk.pulls.all });

        toast.success(`Synced ${payload.fullName}`, {
          id: `sync-${payload.repositoryId}`,
          description: `${payload.pullRequestsSynced} pull request${
            payload.pullRequestsSynced === 1 ? "" : "s"
          } up to date.`,
        });
      }),
    );

    disposers.push(
      onEvent(EVENT.repositorySyncFailed, (payload: RepositorySyncFailedPayload) => {
        void queryClient.invalidateQueries({ queryKey: qk.repositories.all });

        toast.error(`Could not sync ${payload.fullName}`, {
          id: `sync-${payload.repositoryId}`,
          description: payload.errorMessage,
        });
      }),
    );

    // ---- deployments & decisions -------------------------------------------

    disposers.push(
      onEvent(EVENT.deploymentRecorded, (_payload: DeploymentRecordedPayload) => {
        void queryClient.invalidateQueries({ queryKey: qk.timeline.all });
        void queryClient.invalidateQueries({ queryKey: qk.analytics.all });
      }),
    );

    disposers.push(
      onEvent(EVENT.mergeDecisionRecorded, (payload: MergeDecisionRecordedPayload) => {
        void queryClient.invalidateQueries({
          queryKey: qk.analyses.detail(payload.analysisId),
        });
        void queryClient.invalidateQueries({ queryKey: qk.analytics.all });
      }),
    );

    // ---- reconnection ------------------------------------------------------
    // Events that arrived while disconnected are simply gone. Refetching is the
    // only correct response.
    disposers.push(onResync(invalidateAll));

    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [enabled, queryClient, upsert]);
}
