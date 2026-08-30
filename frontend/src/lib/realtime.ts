/**
 * Socket.io client.
 *
 * Mirrors `backend/src/realtime/events.ts`. One shared connection for the whole
 * app, created lazily on first use and reused — several components watch
 * analyses simultaneously and each opening its own socket would multiply the
 * server's connection count for no benefit.
 *
 * Three things this layer guarantees:
 *
 *  1. **Realtime is an optimisation, never the source of truth.** Every event
 *     mirrors state already committed to Postgres. A dropped message costs a
 *     live update, so on reconnect the app refetches rather than assuming it
 *     missed nothing.
 *  2. **Room subscriptions survive a reconnect.** The rooms a client has joined
 *     are tracked here and re-sent after `connect`, because the server's room
 *     membership is per-socket and does not survive one.
 *  3. **Auth failures are terminal.** A rejected handshake means the session is
 *     gone; retrying forever would spin. It surfaces once and stops.
 */
import { io, type Socket } from "socket.io-client";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "http://localhost:4000";

/** Event names, matching the backend's EVENT map exactly. */
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
  progress: number;
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

/** Server -> client event map, so `socket.on` is typed. */
export interface ServerEvents {
  "analysis:queued": (payload: AnalysisQueuedPayload) => void;
  "analysis:progress": (payload: AnalysisProgressPayload) => void;
  "analysis:completed": (payload: AnalysisCompletedPayload) => void;
  "analysis:failed": (payload: AnalysisFailedPayload) => void;
  "notification:created": (payload: NotificationCreatedPayload) => void;
  "repository:synced": (payload: RepositorySyncedPayload) => void;
  "repository:sync_failed": (payload: RepositorySyncFailedPayload) => void;
  "deployment:recorded": (payload: DeploymentRecordedPayload) => void;
  "merge_decision:recorded": (payload: MergeDecisionRecordedPayload) => void;
  "subscribe:ok": (payload: { room: string }) => void;
  "subscribe:denied": (payload: { room: string }) => void;
}

export interface ClientEvents {
  "subscribe:analysis": (analysisId: string) => void;
  "unsubscribe:analysis": (analysisId: string) => void;
  "subscribe:repository": (repositoryId: string) => void;
  "unsubscribe:repository": (repositoryId: string) => void;
}

export type BugDnaSocket = Socket<ServerEvents, ClientEvents>;

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

let socket: BugDnaSocket | null = null;
let connectionState: ConnectionState = "idle";

/** Rooms this client has joined, replayed after a reconnect. */
const subscribedAnalyses = new Set<string>();
const subscribedRepositories = new Set<string>();

type StateListener = (state: ConnectionState) => void;
const stateListeners = new Set<StateListener>();

/** Called after a reconnect so the app can refetch anything it may have missed. */
type ResyncListener = () => void;
const resyncListeners = new Set<ResyncListener>();

function setState(next: ConnectionState): void {
  if (connectionState === next) return;
  connectionState = next;
  for (const listener of stateListeners) listener(next);
}

export function getConnectionState(): ConnectionState {
  return connectionState;
}

export function onConnectionStateChange(listener: StateListener): () => void {
  stateListeners.add(listener);
  listener(connectionState);
  return () => stateListeners.delete(listener);
}

export function onResync(listener: ResyncListener): () => void {
  resyncListeners.add(listener);
  return () => resyncListeners.delete(listener);
}

/**
 * Get (or create) the shared socket.
 *
 * Returns null during SSR — there is no socket on the server, and callers guard
 * on that rather than this throwing.
 */
export function getSocket(): BugDnaSocket | null {
  if (typeof window === "undefined") return null;
  if (socket) return socket;

  setState("connecting");

  socket = io(WS_URL, {
    path: "/socket.io",
    // The session cookie authenticates the handshake, exactly as it does for
    // HTTP. No separate token to manage or leak.
    withCredentials: true,
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 10_000,
    timeout: 12_000,
    // Connect on demand rather than at import, so a signed-out visitor on the
    // landing page never opens a socket.
    autoConnect: true,
  }) as BugDnaSocket;

  let hasConnectedBefore = false;

  socket.on("connect", () => {
    setState("connected");

    // Re-join every room: server-side membership is per-socket.
    for (const id of subscribedAnalyses) socket?.emit("subscribe:analysis", id);
    for (const id of subscribedRepositories) socket?.emit("subscribe:repository", id);

    // On a *re*connect, we may have missed events while away. Tell the app to
    // refetch rather than trusting that nothing happened.
    if (hasConnectedBefore) {
      for (const listener of resyncListeners) listener();
    }
    hasConnectedBefore = true;
  });

  socket.on("disconnect", (reason) => {
    // A deliberate client-side disconnect is not a fault.
    setState(reason === "io client disconnect" ? "idle" : "reconnecting");
  });

  socket.on("connect_error", (error) => {
    const message = error.message ?? "";

    // The handshake rejects with these when the session is invalid. Retrying
    // cannot succeed, so stop and let the app prompt for sign-in.
    if (message === "UNAUTHENTICATED" || message === "SESSION_EXPIRED") {
      setState("failed");
      socket?.disconnect();
      return;
    }

    setState("reconnecting");
  });

  socket.io.on("reconnect_failed", () => setState("failed"));

  return socket;
}

/** Close the socket and forget subscriptions. Called on sign-out. */
export function disconnectSocket(): void {
  subscribedAnalyses.clear();
  subscribedRepositories.clear();
  socket?.disconnect();
  socket = null;
  setState("idle");
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Follow one analysis. Returns an unsubscribe function.
 *
 * The set is the authority on what should be joined; the emit is just the
 * current socket catching up. That ordering is what makes reconnection correct.
 */
export function subscribeToAnalysis(analysisId: string): () => void {
  subscribedAnalyses.add(analysisId);
  const active = getSocket();
  if (active?.connected) active.emit("subscribe:analysis", analysisId);

  return () => {
    subscribedAnalyses.delete(analysisId);
    if (active?.connected) active.emit("unsubscribe:analysis", analysisId);
  };
}

export function subscribeToRepository(repositoryId: string): () => void {
  subscribedRepositories.add(repositoryId);
  const active = getSocket();
  if (active?.connected) active.emit("subscribe:repository", repositoryId);

  return () => {
    subscribedRepositories.delete(repositoryId);
    if (active?.connected) active.emit("unsubscribe:repository", repositoryId);
  };
}

/** Typed `on`, returning a disposer so effects can clean up. */
export function onEvent<K extends keyof ServerEvents>(
  name: K,
  handler: ServerEvents[K],
): () => void {
  const active = getSocket();
  if (!active) return () => undefined;

  active.on(name, handler as never);
  return () => {
    active.off(name, handler as never);
  };
}
