/**
 * Notifications.
 *
 * Two delivery paths from a single write:
 *
 *  - the row in Postgres, which is the durable record the bell icon reads;
 *  - a Socket.io event, so a connected client updates without polling.
 *
 * The database write is authoritative and the realtime push is best-effort. That
 * ordering matters: a user who was offline when their analysis finished must
 * still see the notification when they return.
 */
import { prisma } from "../../lib/prisma";
import { scoped } from "../../lib/logger";
import { publishEvent } from "../../realtime/bus";
import { EVENT, ROOM } from "../../realtime/events";

const log = scoped("notifications");

export type NotificationType =
  | "ANALYSIS_QUEUED"
  | "ANALYSIS_COMPLETED"
  | "ANALYSIS_FAILED"
  | "HIGH_RISK_PR"
  | "MERGE_DECISION_RECORDED"
  | "DEPLOYMENT_RECORDED"
  | "DEPLOYMENT_FAILED"
  | "REPOSITORY_CONNECTED"
  | "REPOSITORY_SYNC_FAILED"
  | "TEAM_MEMBER_ADDED"
  | "SYSTEM";

export type NotificationSeverity = "INFO" | "SUCCESS" | "WARNING" | "CRITICAL";

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  severity?: NotificationSeverity;
  title: string;
  body?: string;
  href?: string;
  repositoryId?: string;
  pullRequestId?: string;
  analysisId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Persist a notification and push it to the user's realtime room.
 *
 * Never throws: a notification failure must not roll back the thing it was
 * announcing. A dropped notification is an inconvenience; a rolled-back analysis
 * is data loss.
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<{ id: string } | null> {
  try {
    const notification = await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        severity: input.severity ?? "INFO",
        title: input.title.slice(0, 300),
        body: input.body?.slice(0, 2000) ?? null,
        href: input.href ?? null,
        repositoryId: input.repositoryId ?? null,
        pullRequestId: input.pullRequestId ?? null,
        analysisId: input.analysisId ?? null,
        metadata: (input.metadata ?? undefined) as never,
      },
      select: {
        id: true,
        type: true,
        severity: true,
        title: true,
        body: true,
        href: true,
        createdAt: true,
      },
    });

    const unreadCount = await prisma.notification.count({
      where: { userId: input.userId, readAt: null, dismissedAt: null },
    });

    await publishEvent({
      name: EVENT.notificationCreated,
      rooms: [ROOM.user(input.userId)],
      payload: {
        id: notification.id,
        type: notification.type,
        severity: notification.severity as NotificationSeverity,
        title: notification.title,
        body: notification.body,
        href: notification.href,
        createdAt: notification.createdAt.toISOString(),
        unreadCount,
      },
    });

    return { id: notification.id };
  } catch (e) {
    log.error({ err: e, userId: input.userId, type: input.type }, "failed to create notification");
    return null;
  }
}

/**
 * Notify everyone who can see a repository.
 *
 * Used for repository-scoped events (a high-risk PR, a failed deployment) so a
 * team lead learns about a risky change even though they did not trigger the
 * analysis. Resolves recipients through the same tenancy rule as reads: the
 * connecting user plus every member of the owning team.
 */
export async function notifyRepositoryAudience(
  repositoryId: string,
  input: Omit<CreateNotificationInput, "userId">,
  options: { excludeUserId?: string } = {},
): Promise<number> {
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: {
      ownerUserId: true,
      team: { select: { members: { select: { userId: true } } } },
    },
  });

  if (!repository) return 0;

  const recipients = new Set<string>([repository.ownerUserId]);
  for (const member of repository.team?.members ?? []) recipients.add(member.userId);
  if (options.excludeUserId) recipients.delete(options.excludeUserId);

  let sent = 0;
  for (const userId of recipients) {
    const created = await createNotification({ ...input, userId, repositoryId });
    if (created) sent++;
  }

  return sent;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface NotificationListOptions {
  unreadOnly?: boolean;
  types?: NotificationType[];
  skip?: number;
  take?: number;
}

export async function listNotifications(
  userId: string,
  options: NotificationListOptions = {},
): Promise<{
  items: Array<{
    id: string;
    type: string;
    severity: string;
    title: string;
    body: string | null;
    href: string | null;
    repositoryId: string | null;
    pullRequestId: string | null;
    analysisId: string | null;
    read: boolean;
    createdAt: string;
    metadata: unknown;
  }>;
  total: number;
  unreadCount: number;
}> {
  const where = {
    userId,
    dismissedAt: null,
    ...(options.unreadOnly ? { readAt: null } : {}),
    ...(options.types?.length ? { type: { in: options.types as never } } : {}),
  };

  const [rows, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: options.skip ?? 0,
      take: options.take ?? 20,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null, dismissedAt: null } }),
  ]);

  return {
    items: rows.map((n) => ({
      id: n.id,
      type: n.type,
      severity: n.severity,
      title: n.title,
      body: n.body,
      href: n.href,
      repositoryId: n.repositoryId,
      pullRequestId: n.pullRequestId,
      analysisId: n.analysisId,
      read: n.readAt !== null,
      createdAt: n.createdAt.toISOString(),
      metadata: n.metadata,
    })),
    total,
    unreadCount,
  };
}

export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null, dismissedAt: null } });
}

/** Mark specific notifications read. Scoped by userId so ids cannot be guessed. */
export async function markRead(userId: string, ids: string[]): Promise<number> {
  const { count } = await prisma.notification.updateMany({
    where: { userId, id: { in: ids }, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}

export async function markAllRead(userId: string): Promise<number> {
  const { count } = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}

export async function dismiss(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.notification.updateMany({
    where: { userId, id },
    data: { dismissedAt: new Date(), readAt: new Date() },
  });
  return count > 0;
}
