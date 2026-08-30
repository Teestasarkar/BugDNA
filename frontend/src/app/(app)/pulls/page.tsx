"use client";

/**
 * Pull request list — PR discovery.
 *
 * The working screen: every open pull request across connected repositories, each
 * annotated with its latest risk assessment so the list itself is the triage
 * tool. An unanalysed PR shows an "Analyse" button inline, because making someone
 * open a detail page to start an analysis adds a click to the most common action.
 *
 * Filters live in the URL, so a filtered view is shareable and survives a reload.
 */
import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ExternalLink,
  GitPullRequest,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { PageBody, PageHeader } from "../page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage, initialsOf } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RiskBadge } from "@/components/risk/risk-badge";
import { RiskFactorChips } from "@/components/risk/risk-factors";
import { AnalysisProgressPill } from "@/components/risk/analysis-progress";
import { EmptyState, ErrorState, ListSkeleton, NoRepositoriesState } from "@/components/states";
import {
  usePullRequests,
  useRepositoryOptions,
  useRequestAnalysis,
} from "@/hooks/use-api";
import { RISK_LEVELS } from "@/lib/risk";
import { diffStat, number as fmtNumber, shortRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PullRequestListItem, RiskLevel } from "@/types/api";

export default function PullRequestsPage() {
  return (
    <React.Suspense fallback={<ListSkeleton rows={6} />}>
      <PullRequestsContent />
    </React.Suspense>
  );
}

function PullRequestsContent() {
  const router = useRouter();
  const params = useSearchParams();

  // ---- URL-backed filters ------------------------------------------------
  const repositoryId = params.get("repositoryId") ?? undefined;
  const state = (params.get("state") ?? "OPEN") as "OPEN" | "CLOSED" | "MERGED" | "ALL";
  const sort = (params.get("sort") ?? "updated") as "updated" | "created" | "risk" | "size";
  const riskLevels = params.getAll("riskLevel") as RiskLevel[];
  const unanalysedOnly = params.get("unanalysedOnly") === "true";
  const page = Number(params.get("page") ?? "1");

  const [searchInput, setSearchInput] = React.useState(params.get("search") ?? "");
  const [debouncedSearch, setDebouncedSearch] = React.useState(searchInput);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const setParam = React.useCallback(
    (updates: Record<string, string | string[] | undefined>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(updates)) {
        next.delete(key);
        if (Array.isArray(value)) {
          for (const item of value) next.append(key, item);
        } else if (value !== undefined && value !== "") {
          next.set(key, value);
        }
      }
      // Any filter change invalidates the current page number.
      if (!("page" in updates)) next.delete("page");
      router.replace(`/pulls?${next.toString()}`);
    },
    [params, router],
  );

  const { data: repositories } = useRepositoryOptions();

  const { data, isLoading, isError, error, refetch, isFetching } = usePullRequests({
    page,
    perPage: 20,
    state,
    sort,
    unanalysedOnly,
    ...(repositoryId ? { repositoryId } : {}),
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(riskLevels.length > 0 ? { riskLevel: riskLevels } : {}),
  });

  const pullRequests = data?.data ?? [];
  const meta = data?.meta;

  const hasFilters =
    Boolean(repositoryId) ||
    state !== "OPEN" ||
    riskLevels.length > 0 ||
    unanalysedOnly ||
    Boolean(debouncedSearch);

  const noRepositories = repositories !== undefined && repositories.length === 0;

  return (
    <PageBody>
      <PageHeader
        title="Pull requests"
        description="Every pull request BugDNA can see, with its latest risk assessment."
      />

      {noRepositories ? (
        <NoRepositoriesState />
      ) : (
        <>
          {/* --- filters -------------------------------------------------- */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 pt-5">
              <div className="relative min-w-48 flex-1">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={searchInput}
                  onChange={(event) => {
                    setSearchInput(event.target.value);
                    setParam({ search: event.target.value.trim() || undefined });
                  }}
                  placeholder="Title, branch or author"
                  className="h-8 pl-8 text-xs"
                  aria-label="Search pull requests"
                />
              </div>

              <Select
                value={repositoryId ?? "all"}
                onValueChange={(value) =>
                  setParam({ repositoryId: value === "all" ? undefined : value })
                }
              >
                <SelectTrigger size="sm" className="w-44">
                  <SelectValue placeholder="All repositories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All repositories</SelectItem>
                  {(repositories ?? []).map((repository) => (
                    <SelectItem key={repository.id} value={repository.id}>
                      {repository.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={state} onValueChange={(value) => setParam({ state: value })}>
                <SelectTrigger size="sm" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OPEN">Open</SelectItem>
                  <SelectItem value="MERGED">Merged</SelectItem>
                  <SelectItem value="CLOSED">Closed</SelectItem>
                  <SelectItem value="ALL">Any state</SelectItem>
                </SelectContent>
              </Select>

              <Select value={sort} onValueChange={(value) => setParam({ sort: value })}>
                <SelectTrigger size="sm" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="updated">Recently updated</SelectItem>
                  <SelectItem value="created">Newest</SelectItem>
                  <SelectItem value="risk">Highest risk</SelectItem>
                  <SelectItem value="size">Largest</SelectItem>
                </SelectContent>
              </Select>

              {/* risk level toggles */}
              <div className="flex items-center gap-1">
                {RISK_LEVELS.map((level) => {
                  const active = riskLevels.includes(level);
                  return (
                    <button
                      key={level}
                      type="button"
                      onClick={() =>
                        setParam({
                          riskLevel: active
                            ? riskLevels.filter((l) => l !== level)
                            : [...riskLevels, level],
                        })
                      }
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[0.6875rem] font-medium transition-opacity",
                        active ? "opacity-100" : "opacity-40 hover:opacity-70",
                        level === "LOW" && "risk-low",
                        level === "MODERATE" && "risk-moderate",
                        level === "HIGH" && "risk-high",
                        level === "CRITICAL" && "risk-critical",
                      )}
                      aria-pressed={active}
                    >
                      {level}
                    </button>
                  );
                })}
              </div>

              <Button
                variant={unanalysedOnly ? "default" : "outline"}
                size="sm"
                onClick={() => setParam({ unanalysedOnly: unanalysedOnly ? undefined : "true" })}
                className="text-xs"
              >
                Not yet analysed
              </Button>

              {hasFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSearchInput("");
                    router.replace("/pulls");
                  }}
                  className="text-xs"
                >
                  <X />
                  Clear
                </Button>
              )}
            </CardContent>
          </Card>

          {/* --- list ----------------------------------------------------- */}
          {isLoading ? (
            <ListSkeleton rows={6} />
          ) : isError ? (
            <Card>
              <CardContent className="pt-5">
                <ErrorState error={error} onRetry={refetch} isRetrying={isFetching} />
              </CardContent>
            </Card>
          ) : pullRequests.length === 0 ? (
            <Card>
              <CardContent className="pt-5">
                <EmptyState
                  icon={GitPullRequest}
                  title={hasFilters ? "No pull requests match those filters" : "No pull requests yet"}
                  description={
                    hasFilters
                      ? "Try widening the state or clearing the risk filters."
                      : "Sync a repository to pull in its open pull requests."
                  }
                  {...(hasFilters
                    ? { action: { label: "Clear filters", onClick: () => router.replace("/pulls") } }
                    : { action: { label: "View repositories", href: "/repositories" } })}
                />
              </CardContent>
            </Card>
          ) : (
            <>
              <ul className="space-y-2">
                {pullRequests.map((pullRequest) => (
                  <PullRequestRow key={pullRequest.id} pullRequest={pullRequest} />
                ))}
              </ul>

              {/* --- pagination ------------------------------------------ */}
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
                      onClick={() => setParam({ page: String(meta.page - 1) })}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={meta.page >= meta.totalPages}
                      onClick={() => setParam({ page: String(meta.page + 1) })}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </PageBody>
  );
}

function PullRequestRow({ pullRequest }: { pullRequest: PullRequestListItem }) {
  const analyse = useRequestAnalysis();
  const latest = pullRequest.latestAnalysis;

  const inFlight = latest?.status === "QUEUED" || latest?.status === "RUNNING";

  return (
    <li className="rounded-lg border border-border bg-card transition-colors hover:border-primary/25">
      <div className="flex flex-wrap items-start gap-3 p-4">
        <Avatar className="size-7 shrink-0">
          {pullRequest.authorAvatarUrl && (
            <AvatarImage src={pullRequest.authorAvatarUrl} alt="" />
          )}
          <AvatarFallback>{initialsOf(pullRequest.authorLogin)}</AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-baseline gap-2">
            <Link
              href={`/pulls/${pullRequest.id}`}
              className="text-sm font-medium leading-snug hover:underline"
            >
              <span className="font-mono text-xs text-muted-foreground">
                #{pullRequest.number}
              </span>{" "}
              {pullRequest.title}
            </Link>
            {pullRequest.draft && <Badge variant="muted">draft</Badge>}
            {pullRequest.state === "MERGED" && (
              <Badge variant="outline" className="border-primary/30 text-primary">
                merged
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <Link
              href={`/repositories/${pullRequest.repository.id}`}
              className="font-mono transition-colors hover:text-foreground"
            >
              {pullRequest.repository.fullName}
            </Link>
            <span>{pullRequest.authorLogin}</span>
            <span className="font-mono">
              {diffStat(pullRequest.additions, pullRequest.deletions)}
            </span>
            <span>{fmtNumber(pullRequest.changedFiles)} files</span>
            <span>updated {shortRelativeTime(pullRequest.githubUpdatedAt)}</span>
          </div>

          {latest?.topFactors && latest.topFactors.length > 0 && (
            <RiskFactorChips factors={latest.topFactors} limit={3} />
          )}
        </div>

        {/* --- risk + action ------------------------------------------- */}
        <div className="flex shrink-0 items-center gap-2">
          {inFlight && latest ? (
            <AnalysisProgressPill
              analysisId={latest.id}
              status={latest.status}
              progress={latest.progress}
            />
          ) : latest ? (
            <Link href={`/analyses/${latest.id}`}>
              <RiskBadge
                level={latest.riskLevel}
                score={latest.riskScore}
                size="default"
                stale={!latest.isCurrent}
                heuristic={latest.scoredBy === "HEURISTIC"}
                degraded={latest.degraded}
              />
            </Link>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => analyse.mutate({ pullRequestId: pullRequest.id })}
              loading={analyse.isPending}
            >
              <Sparkles />
              Analyse
            </Button>
          )}

          {pullRequest.htmlUrl && (
            <a
              href={pullRequest.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Open on GitHub"
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </div>
    </li>
  );
}
