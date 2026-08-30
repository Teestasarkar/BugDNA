"use client";

/**
 * Notification bell.
 *
 * The unread count arrives over Socket.io (written straight into the query cache
 * by the realtime bridge), with a slow poll as a fallback for clients whose
 * websocket is blocked. Opening the panel does not mark everything read —
 * silently clearing a badge the user has not actually looked at loses
 * information they wanted.
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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDismissNotification,
  useMarkAllNotificationsRead,
  useMarkNotificationsRead,
  useNotifications,
  useUnreadCount,
} from "@/hooks/use-api";
import { shortRelativeTime } from "@/lib/format";
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

const SEVERITY_ACCENT: Record<NotificationSeverity, string> = {
  INFO: "text-muted-foreground",
  SUCCESS: "text-risk-low",
  WARNING: "text-risk-moderate",
  CRITICAL: "text-risk-critical",
};

export function NotificationBell() {
  const [open, setOpen] = React.useState(false);

  const { data: countData } = useUnreadCount();
  const unread = countData?.unreadCount ?? 0;

  // Only fetch the list once the panel is opened — the badge needs a count, not
  // the payload.
  const { data, isLoading } = useNotifications(open ? { page: 1 } : {});
  const notifications = open ? (data?.data ?? []) : [];

  const markRead = useMarkNotificationsRead();
  const markAllRead = useMarkAllNotificationsRead();
  const dismiss = useDismissNotification();

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell />
          {unread > 0 && (
            <span
              className={cn(
                "absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center",
                "rounded-full bg-risk-high px-1 text-[0.625rem] font-bold leading-4",
                "text-background",
              )}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-[min(24rem,calc(100vw-2rem))] p-0" align="end">
        {/* --- header ---------------------------------------------------- */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
          <p className="text-sm font-semibold">
            Notifications
            {unread > 0 && (
              <span className="ml-1.5 font-normal text-muted-foreground">{unread} unread</span>
            )}
          </p>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => markAllRead.mutate()}
              loading={markAllRead.isPending}
              className="h-7 text-xs"
            >
              <CheckCheck />
              Mark all read
            </Button>
          )}
        </div>

        {/* --- list ------------------------------------------------------ */}
        <div className="max-h-[24rem] overflow-y-auto">
          {isLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className="flex gap-2.5">
                  <Skeleton className="size-4 rounded" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-2.5 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : notifications.length === 0 ? (
            <EmptyState
              icon={Bell}
              title="Nothing yet"
              description="You will be notified when an analysis completes, a high-risk pull request appears, or a deployment is reported as causing an incident."
              compact
            />
          ) : (
            <ul className="divide-y divide-border">
              {notifications.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onRead={() => {
                    if (!notification.read) markRead.mutate([notification.id]);
                  }}
                  onDismiss={() => dismiss.mutate(notification.id)}
                  onNavigate={() => setOpen(false)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* --- footer ---------------------------------------------------- */}
        <div className="border-t border-border p-2">
          <Button asChild variant="ghost" size="sm" className="w-full text-xs">
            <Link href="/notifications" onClick={() => setOpen(false)}>
              View all notifications
            </Link>
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NotificationRow({
  notification,
  onRead,
  onDismiss,
  onNavigate,
}: {
  notification: AppNotification;
  onRead: () => void;
  onDismiss: () => void;
  onNavigate: () => void;
}) {
  const Icon = TYPE_ICON[notification.type] ?? Bell;

  const body = (
    <div className="flex gap-2.5">
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", SEVERITY_ACCENT[notification.severity])}
        aria-hidden
      />

      <div className="min-w-0 flex-1 space-y-0.5">
        <p
          className={cn(
            "text-sm leading-snug",
            notification.read ? "font-normal text-muted-foreground" : "font-medium",
          )}
        >
          {notification.title}
        </p>
        {notification.body && (
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {notification.body}
          </p>
        )}
        <p className="text-[0.6875rem] text-muted-foreground/60">
          {shortRelativeTime(notification.createdAt)}
        </p>
      </div>

      {!notification.read && (
        <span
          className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
          aria-label="Unread"
        />
      )}
    </div>
  );

  return (
    <li className="group relative">
      {notification.href ? (
        <Link
          href={notification.href}
          onClick={() => {
            onRead();
            onNavigate();
          }}
          className="block px-3 py-2.5 transition-colors hover:bg-muted/50"
        >
          {body}
        </Link>
      ) : (
        <button
          type="button"
          onClick={onRead}
          className="block w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
        >
          {body}
        </button>
      )}

      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }}
        className={cn(
          "absolute right-2 top-2 rounded p-1 text-muted-foreground/60 opacity-0",
          "transition-opacity hover:bg-muted hover:text-foreground",
          "group-hover:opacity-100 focus-visible:opacity-100",
        )}
        aria-label="Dismiss"
      >
        <X className="size-3" />
      </button>
    </li>
  );
}
