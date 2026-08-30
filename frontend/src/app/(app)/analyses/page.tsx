"use client";

/**
 * Analysis history.
 *
 * Every analysis BugDNA has run, filterable. This is the "revisit previous
 * analyses and compare risk over time" half of the product — the record that
 * makes an assessment auditable after the fact, rather than a number that
 * appeared once and vanished.
 */
import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Clock, ShieldAlert, TriangleAlert, X } from "lucide-react";
import { PageBody, PageHeader } from "../page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { MergeDecisionBadge } from "@/components/risk/merge-decision";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/states";
import { useAnalyses, useRepositoryOptions } from "@/hooks/use-api";
import { RISK_LEVELS } from "@/lib/risk";
import {
  duration,
  number as fmtNumber,
  relativeTime,
  sha as shortSha,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AnalysisListItem, RiskLevel } from "@/types/api";

export default function AnalysesPage() {
  return (
    <React.Suspense fallback={<ListSkeleton rows={6} />}>
      <AnalysesContent />
    </React.Suspense>
  );
}

function AnalysesContent() {
  const router = useRouter();
  const params = useSearchParams();

  const repositoryId = params.get("repositoryId") ?? undefined;
  const riskLevels = params.getAll("riskLevel") as RiskLevel[];
  const days = params.get("days") ?? "";
  const page = Number(params.get("page") ?? "1");

  const setParam = (updates: Record<string, string | string[] | undefined>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(updates)) {
      next.delete(key);
      if (Array.isArray(value)) {
        for (const item of value) next.append(key, item);
      } else if (value !== undefined && value !== "") {
        next.set(key, value);
      }
    }
    if (!("page" in updates)) next.delete("page");
    router.replace(`/analyses?${next.toString()}`);
  };

  const { data: repositories } = useRepositoryOptions();

  const { data, isLoading, isError, error, refetch, isFetching } = useAnalyses({
    page,
    perPage: 20,
    ...(repositoryId ? { repositoryId } : {}),
    ...(riskLevels.length > 0 ? { riskLevel: riskLevels } : {}),
    ...(days ? { days: Number(days) } : {}),
  });

  const analyses = data?.data ?? [];
  const meta = data?.meta;
  const hasFilters = Boolean(repositoryId) || riskLevels.length > 0 || Boolean(days);

  return (
    <PageBody>
      <PageHeader
        title="Analyses"
        description="Every risk assessment BugDNA has produced, newest first."
      />

      {/* --- filters ------------------------------------------------------ */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 pt-5">
          <Select
            value={repositoryId ?? "all"}
            onValueChange={(value) =>
              setParam({ repositoryId: value === "all" ? undefined : value })
            }
          >
            <SelectTrigger size="sm" className="w-48">
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

          <Select
            value={days || "all"}
            onValueChange={(value) => setParam({ days: value === "all" ? undefined : value })}
          >
            <SelectTrigger size="sm" className="w-32">
              <SelectValue placeholder="Any time" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any time</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>

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

          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.replace("/analyses")}
              className="text-xs"
            >
              <X />
              Clear
            </Button>
          )}
        </CardContent>
      </Card>

      {/* --- list --------------------------------------------------------- */}
      {isLoading ? (
        <ListSkeleton rows={6} />
      ) : isError ? (
        <Card>
          <CardContent className="pt-5">
            <ErrorState error={error} onRetry={refetch} isRetrying={isFetching} />
          </CardContent>
        </Card>
      ) : analyses.length === 0 ? (
        <Card>
          <CardContent className="pt-5">
            <EmptyState
              icon={ShieldAlert}
              title={hasFilters ? "No analyses match those filters" : "No analyses yet"}
              description={
                hasFilters
                  ? "Try widening the time window or clearing the risk filters."
                  : "Analyse an open pull request and its assessment will appear here."
              }
              {...(hasFilters
                ? { action: { label: "Clear filters", onClick: () => router.replace("/analyses") } }
                : { action: { label: "Browse pull requests", href: "/pulls" } })}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <ul className="space-y-2">
            {analyses.map((analysis) => (
              <AnalysisRow key={analysis.id} analysis={analysis} />
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
    </PageBody>
  );
}

function AnalysisRow({ analysis }: { analysis: AnalysisListItem }) {
  const failed = analysis.status === "FAILED";
  const pending = analysis.status === "QUEUED" || analysis.status === "RUNNING";

  return (
    <li>
      <Link
        href={`/analyses/${analysis.id}`}
        className={cn(
          "block rounded-lg border border-border bg-card p-4 transition-colors",
          "hover:border-primary/25",
          failed && "border-risk-critical-border/60",
        )}
      >
        <div className="flex flex-wrap items-start gap-3">
          <Avatar className="size-7 shrink-0">
            {analysis.pullRequest.authorAvatarUrl && (
              <AvatarImage src={analysis.pullRequest.authorAvatarUrl} alt="" />
            )}
            <AvatarFallback>{initialsOf(analysis.pullRequest.authorLogin)}</AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-sm font-medium leading-snug">
              <span className="font-mono text-xs text-muted-foreground">
                #{analysis.pullRequest.number}
              </span>{" "}
              {analysis.pullRequest.title}
            </p>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="font-mono">{analysis.repository.fullName}</span>
              <span>{analysis.pullRequest.authorLogin}</span>
              <span className="font-mono">{shortSha(analysis.headSha)}</span>
              <span>{relativeTime(analysis.createdAt)}</span>
              {analysis.durationMs !== null && (
                <span className="flex items-center gap-1">
                  <Clock className="size-3" aria-hidden />
                  {duration(analysis.durationMs)}
                </span>
              )}
            </div>

            {/* summary, or the failure reason */}
            {failed ? (
              <p className="flex items-start gap-1.5 text-xs leading-relaxed text-risk-critical">
                <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                {analysis.errorMessage ?? "This analysis failed."}
              </p>
            ) : (
              analysis.summary && (
                <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {analysis.summary}
                </p>
              )
            )}

            {analysis.riskFactors.length > 0 && (
              <RiskFactorChips factors={analysis.riskFactors} limit={3} />
            )}
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {pending ? (
              <Badge variant="outline" className="border-primary/30 text-primary">
                {analysis.status.toLowerCase()}
              </Badge>
            ) : failed ? (
              <Badge variant="outline" className="border-risk-critical-border text-risk-critical">
                failed
              </Badge>
            ) : (
              <RiskBadge
                level={analysis.riskLevel}
                score={analysis.riskScore}
                heuristic={analysis.scoredBy === "HEURISTIC"}
                degraded={analysis.degraded}
              />
            )}

            {analysis.mergeDecision && (
              <MergeDecisionBadge decision={analysis.mergeDecision.decision} />
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}
