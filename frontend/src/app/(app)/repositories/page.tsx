"use client";

/**
 * Connected repositories.
 *
 * Each card carries the rollup that matters for triage — open PRs, how many are
 * analysed, average risk, and how many high-risk ones are still awaiting a
 * decision — so the list answers "where should I look" without opening anything.
 *
 * A sync error is surfaced on the card rather than hidden in a log: a repository
 * that silently stopped syncing looks identical to one with no new pull requests,
 * and that is exactly the failure a risk tool must not have.
 */
import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  ExternalLink,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  TriangleAlert,
} from "lucide-react";
import { PageBody, PageHeader } from "../page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { InfoTooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RiskBadge } from "@/components/risk/risk-badge";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/states";
import {
  useDisconnectRepository,
  useRepositories,
  useSyncRepository,
  useUpdateRepository,
} from "@/hooks/use-api";
import { number as fmtNumber, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Repository } from "@/types/api";

export default function RepositoriesPage() {
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, isError, error, refetch, isFetching } = useRepositories({
    perPage: 50,
    ...(debounced ? { search: debounced } : {}),
  });

  const repositories = data?.data ?? [];

  return (
    <PageBody>
      <PageHeader
        title="Repositories"
        description="Repositories BugDNA is watching for pre-merge risk."
        action={
          <Button asChild>
            <Link href="/repositories/connect">
              <Plus />
              Connect
            </Link>
          </Button>
        }
      />

      {repositories.length > 0 && (
        <div className="relative max-w-sm">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter repositories"
            className="h-8 pl-8 text-xs"
            aria-label="Filter repositories"
          />
        </div>
      )}

      {isLoading ? (
        <ListSkeleton rows={3} />
      ) : isError ? (
        <Card>
          <CardContent className="pt-5">
            <ErrorState error={error} onRetry={refetch} isRetrying={isFetching} />
          </CardContent>
        </Card>
      ) : repositories.length === 0 ? (
        <Card>
          <CardContent className="pt-5">
            <EmptyState
              title={debounced ? "No repositories match" : "No repositories connected"}
              description={
                debounced
                  ? "Try a different search."
                  : "Connect a GitHub repository and BugDNA will start assessing its open pull requests."
              }
              {...(debounced
                ? {}
                : { action: { label: "Connect a repository", href: "/repositories/connect" } })}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {repositories.map((repository) => (
            <RepositoryCard key={repository.id} repository={repository} />
          ))}
        </div>
      )}
    </PageBody>
  );
}

function RepositoryCard({ repository }: { repository: Repository }) {
  const sync = useSyncRepository();
  const disconnect = useDisconnectRepository();
  const update = useUpdateRepository();

  const stats = repository.stats;

  return (
    <Card className={cn(!repository.isActive && "opacity-60")}>
      <CardHeader>
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex min-w-0 items-center gap-1.5">
            <Link
              href={`/repositories/${repository.id}`}
              className="truncate font-mono hover:underline"
            >
              {repository.fullName}
            </Link>
            {repository.private && (
              <InfoTooltip label="Private repository. Reading its diffs requires the `repo` OAuth scope.">
                <Lock className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              </InfoTooltip>
            )}
          </CardTitle>

          {repository.description && (
            <CardDescription className="line-clamp-2">
              {repository.description}
            </CardDescription>
          )}
        </div>

        <div className="col-start-2 row-span-2 flex shrink-0 items-start gap-1">
          {stats.latestRiskLevel && (
            <RiskBadge
              level={stats.latestRiskLevel}
              score={stats.avgRiskScore}
              size="sm"
              hideScore
            />
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Repository actions">
                <Settings2 />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                onClick={() => sync.mutate({ repositoryId: repository.id })}
                disabled={sync.isPending}
              >
                <RefreshCw />
                Sync pull requests
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/repositories/${repository.id}`}>
                  <ArrowRight />
                  Open health view
                </Link>
              </DropdownMenuItem>
              {repository.htmlUrl && (
                <DropdownMenuItem asChild>
                  <a href={repository.htmlUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink />
                    View on GitHub
                  </a>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => disconnect.mutate(repository.id)}
                disabled={disconnect.isPending}
              >
                Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* --- sync error, prominent --------------------------------------- */}
        {repository.syncError && (
          <div className="flex items-start gap-2 rounded-md border border-risk-moderate-border bg-risk-moderate-bg px-2.5 py-2">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-risk-moderate" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-risk-moderate">Last sync failed</p>
              <p className="mt-0.5 line-clamp-2 text-[0.6875rem] leading-relaxed text-risk-moderate/85">
                {repository.syncError}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => sync.mutate({ repositoryId: repository.id })}
              disabled={sync.isPending}
              aria-label="Retry sync"
            >
              <RefreshCw />
            </Button>
          </div>
        )}

        {/* --- rollup ------------------------------------------------------ */}
        <div className="grid grid-cols-4 gap-2 text-center">
          <Metric label="Open PRs" value={fmtNumber(stats.openPullRequests)} />
          <Metric label="Analysed" value={fmtNumber(stats.analysedPullRequests)} />
          <Metric
            label="Avg risk"
            value={stats.avgRiskScore === null ? "—" : String(Math.round(stats.avgRiskScore))}
            accent={stats.avgRiskScore !== null && stats.avgRiskScore >= 60}
          />
          <Metric
            label="Needs attention"
            value={fmtNumber(stats.highRiskOpen)}
            accent={stats.highRiskOpen > 0}
          />
        </div>

        {/* --- footer ------------------------------------------------------ */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {repository.language && <span>{repository.language}</span>}
            {repository.team && (
              <Badge variant="muted" className="font-normal">
                {repository.team.name}
              </Badge>
            )}
            <span>
              synced{" "}
              {repository.lastSyncedAt ? relativeTime(repository.lastSyncedAt) : "never"}
            </span>
          </div>

          <InfoTooltip label="When on, BugDNA keeps this repository's pull requests in sync so they are ready to analyse.">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                checked={repository.autoAnalyze}
                onCheckedChange={(checked) =>
                  update.mutate({ repositoryId: repository.id, autoAnalyze: checked })
                }
                aria-label="Keep in sync"
              />
              auto-sync
            </label>
          </InfoTooltip>
        </div>

        {stats.highRiskOpen > 0 && (
          <Button asChild variant="outline" size="sm" className="w-full">
            <Link href={`/pulls?repositoryId=${repository.id}&riskLevel=HIGH&riskLevel=CRITICAL`}>
              <AlertTriangle />
              Review {stats.highRiskOpen} high-risk pull request
              {stats.highRiskOpen === 1 ? "" : "s"}
            </Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <p
        className={cn(
          "tabular text-lg font-bold leading-none",
          accent && "text-risk-high",
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-[0.625rem] leading-tight text-muted-foreground">{label}</p>
    </div>
  );
}
