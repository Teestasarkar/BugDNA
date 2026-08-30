/**
 * Live analysis state.
 *
 * Holds the in-flight progress of analyses the user is currently watching. This
 * is genuinely client state — it exists only while a socket connection is open,
 * and it is *ahead* of what a REST query would return.
 *
 * The division of labour with TanStack Query matters:
 *
 *  - **This store** answers "what is happening right now" — stage, percentage,
 *    the fact that a retry is pending. It is overwritten by every socket event
 *    and is never persisted.
 *  - **TanStack Query** owns the completed analysis. When a socket event says an
 *    analysis finished, the store records that and the query cache is
 *    invalidated so the real, authoritative record is refetched.
 *
 * That split is why a page refresh mid-analysis still works: the durable state
 * came from Postgres, and this store just re-populates as new events arrive.
 */
import { create } from "zustand";
import type { AnalysisStage, AnalysisStatus, RiskLevel } from "@/types/api";

export interface LiveAnalysis {
  analysisId: string;
  repositoryId: string;
  pullRequestId: string;
  status: AnalysisStatus;
  stage: AnalysisStage | null;
  progress: number;
  message?: string;
  /** Populated on completion. */
  riskScore?: number;
  riskLevel?: RiskLevel;
  scoredBy?: "MODEL" | "HEURISTIC";
  degraded?: boolean;
  topFactors?: Array<{ key: string; label: string; contribution: number }>;
  durationMs?: number;
  /** Populated on failure. */
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  /** True while the queue still has attempts left — the UI says "retrying". */
  willRetry?: boolean;
  attempts?: number;
  updatedAt: number;
}

interface AnalysisState {
  /** Keyed by analysis id. */
  live: Record<string, LiveAnalysis>;
  /** Analysis ids the client has asked the socket to follow. */
  watched: string[];

  upsert: (analysis: Partial<LiveAnalysis> & { analysisId: string }) => void;
  get: (analysisId: string) => LiveAnalysis | undefined;
  remove: (analysisId: string) => void;
  watch: (analysisId: string) => void;
  unwatch: (analysisId: string) => void;
  /** Drop completed/failed entries older than the cutoff. */
  prune: (maxAgeMs?: number) => void;
  reset: () => void;
}

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  live: {},
  watched: [],

  upsert: (analysis) =>
    set((state) => {
      const existing = state.live[analysis.analysisId];

      // Defaults keep the type complete when the first event to arrive is a
      // partial progress update. Declared as its own object rather than as
      // literal keys before the spreads, so the precedence is explicit:
      // defaults < existing < incoming.
      const defaults: Omit<LiveAnalysis, "analysisId" | "updatedAt"> = {
        repositoryId: "",
        pullRequestId: "",
        status: "QUEUED",
        stage: null,
        progress: 0,
      };

      return {
        live: {
          ...state.live,
          [analysis.analysisId]: {
            ...defaults,
            ...existing,
            ...analysis,
            updatedAt: Date.now(),
          },
        },
      };
    }),

  get: (analysisId) => get().live[analysisId],

  remove: (analysisId) =>
    set((state) => {
      const { [analysisId]: _removed, ...rest } = state.live;
      return { live: rest };
    }),

  watch: (analysisId) =>
    set((state) =>
      state.watched.includes(analysisId)
        ? state
        : { watched: [...state.watched, analysisId] },
    ),

  unwatch: (analysisId) =>
    set((state) => ({ watched: state.watched.filter((id) => id !== analysisId) })),

  prune: (maxAgeMs = 10 * 60_000) =>
    set((state) => {
      const cutoff = Date.now() - maxAgeMs;
      const live: Record<string, LiveAnalysis> = {};

      for (const [id, analysis] of Object.entries(state.live)) {
        const settled =
          analysis.status === "COMPLETED" ||
          analysis.status === "FAILED" ||
          analysis.status === "CANCELLED";
        // Keep everything in flight, and recent outcomes.
        if (!settled || analysis.updatedAt > cutoff) live[id] = analysis;
      }

      return { live };
    }),

  reset: () => set({ live: {}, watched: [] }),
}));

/** True when this analysis is queued or running right now. */
export function isInFlight(analysis: LiveAnalysis | undefined): boolean {
  if (!analysis) return false;
  return analysis.status === "QUEUED" || analysis.status === "RUNNING";
}

/**
 * Selector for one analysis.
 *
 * Reading a single key keeps a component from re-rendering when an unrelated
 * analysis updates — which matters on the pull request list, where several can
 * be in flight at once.
 */
export function useLiveAnalysis(analysisId: string | null | undefined) {
  return useAnalysisStore((state) => (analysisId ? state.live[analysisId] : undefined));
}
