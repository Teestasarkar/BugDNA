"use client";

/**
 * Notifications.
 *
 * The full list, with a filter for unread. The bell in the top bar is for
 * glancing; this is for catching up.
 */
import * as React from "react";
import Link from "next/link";
import {
  Bell,
  CheckCheck,
  FolderGit2,
  Rocket,
  ShieldAlert,
  Sparkles,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { PageBody, PageHeader } from "../page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/states";
import {
  useDismissNotification,
  useMarkAllNotificationsRead,
  useMarkNotificationsRead,
  useNotifications,
} from "@/hooks/use-api";
import { absoluteTime, number as fmtNumber, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AppNotification, NotificationSeverity, NotificationType } from "@/types/api";

const TYPE_ICON: Partial<Record<NotificationType, LucideIcon>> = {
  HIGH_RISK_PR: ShieldAlert,
  ANALYSIS_COMPLETED: Sparkles,
  ANALYSIS_FAILED: ShieldAlert,
  ANALYSIS_QUEUED: Sparkles,
  MERGE_DECISION_RECORDED: CheckCheck,
  DEPLOYMENT_RECORDED: Rocket,
  DEPLOYMENT_FAILED: Rocket,
  REPOSITORY_CONNECTED: FolderGit2,
  REPOSITORY_SYNC_FAILED: FolderGit2,
  TEAM_MEMBER_ADDED: Users,
};

const SEVERITY_STYLE: Record<NotificationSeverity, string> = {
  INFO: "border-border bg-muted/30 text-muted-foreground",
  SUCCESS: "risk-low",
  WARNING: "risk-moderate",
  CRITICAL: "risk-critical",
};

export default function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const [page, setPage] = React.useState(1);

  const { data, isLoading, isError, error, refetch, isFetching } = useNotifications({
    page,
    unreadOnly,
  });

  const markAllRead = useMarkAllNotificationsRead();

  const notifications = data?.data ?? [];
  const meta = data?.meta;

  return (
    <PageBody>
      <PageHeader
        title="Notifications"
        description="Analysis results, high-risk pull requests and deployment outcomes."
        action={
          <>
            <Button
              variant={unreadOnly ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setUnreadOnly(!unreadOnly);
                setPage(1);
              }}
            >
              Unread only
              {meta?.unreadCount ? (
                <Badge variant="secondary" className="ml-1">
                  {meta.unreadCount}
                </Badge>
              ) : null}
            </Button>

            {(meta?.unreadCount ?? 0) > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => markAllRead.mutate()}
                loading={markAllRead.isPending}
              >
                <CheckCheck />
                Mark all read
              </Button>
            )}
          </>
        }
      />

      {isLoading ? (
        <ListSkeleton rows={6} />
      ) : isError ? (
        <Card>
          <CardContent className="pt-5">
            <ErrorState error={error} onRetry={refetch} isRetrying={isFetching} />
          </CardContent>
        </Card>
      ) : notifications.length === 0 ? (
        <Card>
          <CardContent className="pt-5">
            <EmptyState
              icon={Bell}
              title={unreadOnly ? "Nothing unread" : "No notifications yet"}
              description={
                unreadOnly
                  ? "You are up to date."
                  : "BugDNA will notify you when an analysis completes, a high-risk pull request appears, or a deployment is reported as causing an incident."
              }
              {...(unreadOnly
                ? { action: { label: "Show all", onClick: () => setUnreadOnly(false) } }
                : {})}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <ul className="space-y-2">
            {notifications.map((notification) => (
              <NotificationCard key={notification.id} notification={notification} />
            ))}
          </ul>

          {meta && meta.totalPages > 1 && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Page {meta.page} of {meta.totalPages} · {fmtNumber(meta.total)} total
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={meta.page <= 1}
                  onClick={() => setPage((current) => current - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={meta.page >= meta.totalPages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </PageBody>
  );
}

function NotificationCard({ notification }: { notification: AppNotification }) {
  const markRead = useMarkNotificationsRead();
  const dismiss = useDismissNotification();

  const Icon = TYPE_ICON[notification.type] ?? Bell;

  return (
    <li
      className={cn(
        "group relative rounded-lg border bg-card p-4 transition-colors",
        notification.read ? "border-border" : "border-primary/30 bg-primary/[0.03]",
      )}
    >
      <div className="flex gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border",
            SEVERITY_STYLE[notification.severity],
          )}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <p
              className={cn(
                "text-sm leading-snug",
                notification.read ? "font-normal" : "font-semibold",
              )}
            >
              {notification.title}
            </p>
            {!notification.read && (
              <Badge variant="default" className="text-[0.625rem]">
                new
              </Badge>
            )}
          </div>

          {notification.body && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {notification.body}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-[0.6875rem] text-muted-foreground/70">
            <span title={absoluteTime(notification.createdAt)}>
              {relativeTime(notification.createdAt)}
            </span>
            <span className="font-mono">{notification.type.toLowerCase()}</span>
          </div>

          <div className="flex items-center gap-2 pt-1">
            {notification.href && (
              <Button
                asChild
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  if (!notification.read) markRead.mutate([notification.id]);
                }}
              >
                <Link href={notification.href}>Open</Link>
              </Button>
            )}

            {!notification.read && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => markRead.mutate([notification.id])}
              >
                Mark read
              </Button>
            )}
          </div>
        </div>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => dismiss.mutate(notification.id)}
          className="shrink-0 self-start opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          aria-label="Dismiss notification"
        >
          <X />
        </Button>
      </div>
    </li>
  );
}
