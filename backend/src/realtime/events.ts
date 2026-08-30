/**
 * Realtime event contract.
 *
 * One declaration of every event the server pushes, its payload and the room it
 * targets. The frontend mirrors these names in `frontend/src/lib/realtime.ts`;
 * keeping them in a single typed union here is what stops the two sides drifting.
 *
 * Rooms
 * -----
 *  - `user:<userId>`        personal stream: notifications, anything the user owns
 *  - `analysis:<id>`        progress for one analysis; joined when a client opens it
 *  - `repo:<repositoryId>`  repository-scoped activity (sync, new PRs, deployments)
 *
 * Room membership is authorised on join (see socket.ts) — a client cannot
 * subscribe to a room for data it is not allowed to read.
 */

export const ROOM = {
  user: (userId: string) => `user:${userId}`,
  analysis: (analysisId: string) => `analysis:${analysisId}`,
  repository: (repositoryId: string) => `repo:${repositoryId}`,
} as const;

/** Event names. String literals so both sides can switch exhaustively. */
export const EVENT = {
  analysisQueued: "analysis:queued",
  analysisProgress: "analysis:progress",
  analysisCompleted: "analysis:completed",
  analysisFailed: "analysis:failed",
  notificationCreated: "notification:created",
  repositorySynced: "repository:synced",
  repositorySyncFailed: "repository:sync_failed",
  deploymentRecorded: "deployment:recorded",
  mergeDecisionRecorded: "merge_decision:recorded",
} as const;

export type EventName = (typeof EVENT)[keyof typeof EVENT];

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface AnalysisQueuedPayload {
  analysisId: string;
  pullRequestId: string;
  repositoryId: string;
  pullRequestNumber: number;
  headSha: string;
  status: "QUEUED";
  queuedAt: string;
}

export interface AnalysisProgressPayload {
  analysisId: string;
  repositoryId: string;
  pullRequestId: string;
  status: "QUEUED" | "RUNNING";
  stage: string;
  /** 0-100 so the UI can render a determinate bar. */
  progress: number;
  /** Short human-readable description of the current stage. */
  message?: string;
}

export interface AnalysisCompletedPayload {
  analysisId: string;
  repositoryId: string;
  pullRequestId: string;
  pullRequestNumber: number;
  status: "COMPLETED";
  riskScore: number;
  riskLevel: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  scoredBy: "MODEL" | "HEURISTIC";
  degraded: boolean;
  topFactors: Array<{ key: string; label: string; contribution: number }>;
  durationMs: number;
  completedAt: string;
}

export interface AnalysisFailedPayload {
  analysisId: string;
  repositoryId: string;
  pullRequestId: string;
  status: "FAILED";
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
  attempts: number;
  /** True while BullMQ still has attempts left — the UI says "retrying". */
  willRetry: boolean;
}

export interface NotificationCreatedPayload {
  id: string;
  type: string;
  severity: "INFO" | "SUCCESS" | "WARNING" | "CRITICAL";
  title: string;
  body?: string | null;
  href?: string | null;
  createdAt: string;
  unreadCount: number;
}

export interface RepositorySyncedPayload {
  repositoryId: string;
  fullName: string;
  pullRequestsSynced: number;
  syncedAt: string;
}

export interface RepositorySyncFailedPayload {
  repositoryId: string;
  fullName: string;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
}

export interface DeploymentRecordedPayload {
  deploymentId: string;
  repositoryId: string;
  environment: string;
  status: string;
  sha: string;
  causedIncident: boolean | null;
  startedAt: string;
}

export interface MergeDecisionRecordedPayload {
  analysisId: string;
  pullRequestId: string;
  repositoryId: string;
  decision: string;
  decidedBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * A published event, addressed to one or more rooms.
 *
 * The envelope crosses a Redis channel (so the worker process can reach sockets
 * held by an API process), which is why the target rooms travel with it rather
 * than being decided at emit time.
 */
export type RealtimeEvent =
  | { name: typeof EVENT.analysisQueued; rooms: string[]; payload: AnalysisQueuedPayload }
  | { name: typeof EVENT.analysisProgress; rooms: string[]; payload: AnalysisProgressPayload }
  | { name: typeof EVENT.analysisCompleted; rooms: string[]; payload: AnalysisCompletedPayload }
  | { name: typeof EVENT.analysisFailed; rooms: string[]; payload: AnalysisFailedPayload }
  | {
      name: typeof EVENT.notificationCreated;
      rooms: string[];
      payload: NotificationCreatedPayload;
    }
  | { name: typeof EVENT.repositorySynced; rooms: string[]; payload: RepositorySyncedPayload }
  | {
      name: typeof EVENT.repositorySyncFailed;
      rooms: string[];
      payload: RepositorySyncFailedPayload;
    }
  | {
      name: typeof EVENT.deploymentRecorded;
      rooms: string[];
      payload: DeploymentRecordedPayload;
    }
  | {
      name: typeof EVENT.mergeDecisionRecorded;
      rooms: string[];
      payload: MergeDecisionRecordedPayload;
    };

/** Client -> server messages. Deliberately tiny: subscribe and unsubscribe only. */
export interface ClientToServerEvents {
  "subscribe:analysis": (analysisId: string) => void;
  "unsubscribe:analysis": (analysisId: string) => void;
  "subscribe:repository": (repositoryId: string) => void;
  "unsubscribe:repository": (repositoryId: string) => void;
}
