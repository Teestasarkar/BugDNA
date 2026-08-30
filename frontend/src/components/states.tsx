"use client";

/**
 * Empty, error and loading states.
 *
 * Collected in one file because they are the parts of an interface most often
 * left as an afterthought, and the ones a reviewer notices. The rules applied
 * here:
 *
 *  - **An empty state says what to do next**, not just that there is nothing.
 *  - **An error state says what failed, whether retrying helps, and offers the
 *    retry** — driven by the API's own `retryable` flag rather than a guess.
 *  - **A loading state occupies the shape of the real content**, so nothing
 *    jumps when data arrives.
 *  - **A GitHub problem is treated as its own case.** "Reconnect GitHub" is a
 *    different action from "try again", and conflating them wastes the user's
 *    time.
 */
import Link from "next/link";
import {
  AlertTriangle,
  Clock,
  FolderGit2,
  Inbox,
  Loader2,
  Lock,
  RefreshCw,
  SearchX,
  ServerCrash,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { GithubIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Empty
// ---------------------------------------------------------------------------

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  secondaryAction,
  className,
  compact = false,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; href?: string; onClick?: () => void };
  secondaryAction?: { label: string; href?: string; onClick?: () => void };
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center justify-center rounded-full border border-border bg-muted/40",
          compact ? "size-9" : "size-12",
        )}
      >
        <Icon
          className={cn("text-muted-foreground", compact ? "size-4" : "size-5")}
          aria-hidden
        />
      </div>

      <div className="max-w-md space-y-1.5">
        <p className={cn("font-medium", compact ? "text-sm" : "text-base")}>{title}</p>
        {description && (
          <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>

      {(action || secondaryAction) && (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {action &&
            (action.href ? (
              <Button asChild size={compact ? "sm" : "default"}>
                <Link href={action.href}>{action.label}</Link>
              </Button>
            ) : (
              <Button size={compact ? "sm" : "default"} onClick={action.onClick}>
                {action.label}
              </Button>
            ))}

          {secondaryAction &&
            (secondaryAction.href ? (
              <Button asChild variant="outline" size={compact ? "sm" : "default"}>
                <Link href={secondaryAction.href}>{secondaryAction.label}</Link>
              </Button>
            ) : (
              <Button
                variant="outline"
                size={compact ? "sm" : "default"}
                onClick={secondaryAction.onClick}
              >
                {secondaryAction.label}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}

/** No repositories connected — the first thing a new user sees. */
export function NoRepositoriesState() {
  return (
    <Card>
      <CardContent className="pt-5">
        <EmptyState
          icon={FolderGit2}
          title="No repositories connected yet"
          description="Connect a GitHub repository and BugDNA will start assessing its open pull requests for deployment risk before they merge."
          action={{ label: "Connect a repository", href: "/repositories/connect" }}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Error state driven by the API's error taxonomy.
 *
 * The message, the icon and whether a retry is offered all come from the error's
 * `code` and `retryable` flag, so the UI never has to interpret a message string.
 */
export function ErrorState({
  error,
  onRetry,
  isRetrying = false,
  className,
  compact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  isRetrying?: boolean;
  className?: string;
  compact?: boolean;
}) {
  const resolved = describeError(error);

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-12",
        className,
      )}
      role="alert"
    >
      <div
        className={cn(
          "flex items-center justify-center rounded-full border",
          resolved.tone === "warning"
            ? "border-risk-moderate-border bg-risk-moderate-bg"
            : "border-risk-critical-border bg-risk-critical-bg",
          compact ? "size-9" : "size-12",
        )}
      >
        <resolved.icon
          className={cn(
            resolved.tone === "warning" ? "text-risk-moderate" : "text-risk-critical",
            compact ? "size-4" : "size-5",
          )}
          aria-hidden
        />
      </div>

      <div className="max-w-lg space-y-1.5">
        <p className={cn("font-medium", compact ? "text-sm" : "text-base")}>
          {resolved.title}
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">{resolved.message}</p>
        {resolved.hint && (
          <p className="text-xs leading-relaxed text-muted-foreground/80">{resolved.hint}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
        {resolved.retryable && onRetry && (
          <Button
            size={compact ? "sm" : "default"}
            onClick={onRetry}
            loading={isRetrying}
            variant="outline"
          >
            <RefreshCw />
            Try again
          </Button>
        )}

        {resolved.action && (
          <Button asChild size={compact ? "sm" : "default"}>
            <Link href={resolved.action.href}>{resolved.action.label}</Link>
          </Button>
        )}
      </div>

      {/* The request id is what makes a support conversation possible. */}
      {resolved.requestId && (
        <p className="pt-1 font-mono text-[0.6875rem] text-muted-foreground/60">
          request {resolved.requestId}
        </p>
      )}
    </div>
  );
}

interface DescribedError {
  title: string;
  message: string;
  hint?: string;
  icon: LucideIcon;
  tone: "warning" | "danger";
  retryable: boolean;
  action?: { label: string; href: string };
  requestId?: string;
}

/** Map an error onto what the user should see and do. */
export function describeError(error: unknown): DescribedError {
  if (!(error instanceof ApiError)) {
    return {
      title: "Something went wrong",
      message:
        error instanceof Error ? error.message : "An unexpected error occurred.",
      icon: ServerCrash,
      tone: "danger",
      retryable: true,
    };
  }

  const base = { requestId: error.requestId, retryable: error.retryable };

  switch (error.code) {
    case "NETWORK_ERROR":
      return {
        ...base,
        title: "Cannot reach the API",
        message: error.message,
        hint: "If you have just started the stack, the API may still be booting.",
        icon: WifiOff,
        tone: "warning",
        retryable: true,
      };

    case "UNAUTHENTICATED":
    case "SESSION_EXPIRED":
      return {
        ...base,
        title: "You have been signed out",
        message: "Your session is no longer valid. Sign in again to continue.",
        icon: Lock,
        tone: "warning",
        retryable: false,
        action: { label: "Sign in", href: "/login" },
      };

    case "GITHUB_NOT_CONNECTED":
    case "GITHUB_TOKEN_INVALID":
      return {
        ...base,
        title: "GitHub is not connected",
        message: error.message,
        icon: GithubIcon as unknown as LucideIcon,
        tone: "warning",
        retryable: false,
        action: { label: "Connect GitHub", href: "/settings" },
      };

    case "GITHUB_NOT_CONFIGURED":
      return {
        ...base,
        title: "GitHub sign-in is not configured",
        message: error.message,
        hint: "An administrator needs to set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET on this deployment.",
        icon: GithubIcon as unknown as LucideIcon,
        tone: "warning",
        retryable: false,
      };

    case "GITHUB_RATE_LIMITED":
      return {
        ...base,
        title: "GitHub rate limit reached",
        message: error.message,
        hint: "BugDNA uses conditional requests to conserve quota, but a large sync can still exhaust it. Access is restored automatically when the window resets.",
        icon: Clock,
        tone: "warning",
        retryable: true,
      };

    case "GITHUB_FORBIDDEN":
    case "FORBIDDEN":
      return {
        ...base,
        title: "You do not have access",
        message: error.message,
        icon: Lock,
        tone: "warning",
        retryable: false,
      };

    case "NOT_FOUND":
      return {
        ...base,
        title: "Not found",
        message: error.message,
        hint: "It may have been deleted, or belong to an account you cannot see.",
        icon: SearchX,
        tone: "warning",
        retryable: false,
      };

    case "GITHUB_UNAVAILABLE":
    case "DIFF_UNAVAILABLE":
      return {
        ...base,
        title: "GitHub is not responding",
        message: error.message,
        icon: GithubIcon as unknown as LucideIcon,
        tone: "warning",
        retryable: true,
      };

    case "ML_UNAVAILABLE":
    case "ML_TIMEOUT":
    case "ML_MODEL_NOT_LOADED":
      return {
        ...base,
        title: "The risk service is unavailable",
        message: error.message,
        hint: "Queued analyses retry automatically. Existing results are unaffected.",
        icon: ServerCrash,
        tone: "warning",
        retryable: true,
      };

    case "RATE_LIMITED":
      return {
        ...base,
        title: "Too many requests",
        message: error.message,
        icon: Clock,
        tone: "warning",
        retryable: true,
      };

    case "VALIDATION_FAILED": {
      const issues = error.validationIssues;
      return {
        ...base,
        title: "That request was not valid",
        message:
          issues.length > 0
            ? issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
            : error.message,
        icon: AlertTriangle,
        tone: "warning",
        retryable: false,
      };
    }

    default:
      return {
        ...base,
        title: error.status >= 500 ? "The server had a problem" : "Request failed",
        message: error.message,
        icon: ServerCrash,
        tone: error.status >= 500 ? "danger" : "warning",
        retryable: error.retryable,
      };
  }
}

/** Compact inline error, for a panel inside an otherwise working page. */
export function InlineError({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const resolved = describeError(error);

  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm",
        resolved.tone === "warning"
          ? "border-risk-moderate-border bg-risk-moderate-bg text-risk-moderate"
          : "border-risk-critical-border bg-risk-critical-bg text-risk-critical",
        className,
      )}
    >
      <resolved.icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium leading-snug">{resolved.title}</p>
        <p className="text-xs leading-relaxed opacity-90">{resolved.message}</p>
      </div>
      {resolved.retryable && onRetry && (
        <Button variant="ghost" size="icon-sm" onClick={onRetry} aria-label="Try again">
          <RefreshCw />
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Centred spinner with a label, for a whole-page load. */
export function LoadingState({
  label = "Loading",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center gap-3 py-16", className)}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

/** Skeleton rows shaped like the list they replace. */
export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} role="status" aria-label="Loading list">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-4 rounded-lg border border-border bg-card p-4"
        >
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-6 w-20 rounded-md" />
        </div>
      ))}
    </div>
  );
}

/** Stat-tile skeletons for a dashboard header. */
export function StatsSkeleton({ tiles = 4 }: { tiles?: number }) {
  return (
    <div
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      role="status"
      aria-label="Loading statistics"
    >
      {Array.from({ length: tiles }).map((_, index) => (
        <div key={index} className="space-y-2.5 rounded-xl border border-border bg-card p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 220 }: { height?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading chart">
      <Skeleton className="h-3 w-32" />
      <Skeleton className="w-full rounded-lg" style={{ height }} />
    </div>
  );
}
