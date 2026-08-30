"use client";

/**
 * Compare two analyses.
 *
 * The screen that closes the loop: analyse a pull request, act on the advice,
 * re-analyse, and see precisely what changed. It reports the score delta plus
 * which factors appeared, disappeared or shifted weight — so "I added tests"
 * becomes a measurable 82 → 47 with `touches_tests` flipping direction.
 *
 * It is also the honest test of whether the recommendations are worth following.
 * If addressing them never moves the score, the user should be able to see that.
 */
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowDown, ArrowLeft, ArrowUp, Minus } from "lucide-react";
import { PageBody, PageHeader } from "../../page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RiskBadge, RiskMeter } from "@/components/risk/risk-badge";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useAnalysisComparison } from "@/hooks/use-api";
import { FACTOR_CATEGORY_LABEL } from "@/lib/risk";
import { absoluteTime, delta as fmtDelta, sha as shortSha } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RiskLevel } from "@/types/api";

export default function ComparePage() {
  return (
    <React.Suspense fallback={<LoadingState label="Loading comparison" />}>
      <CompareContent />
    </React.Suspense>
  );
}

function CompareContent() {
  const params = useSearchParams();
  const base = params.get("base") ?? undefined;
  const compare = params.get("compare") ?? undefined;

  const { data, isLoading, isError, error, refetch } = useAnalysisComparison(base, compare);

  if (!base || !compare) {
    return (
      <PageBody>
        <PageHeader title="Compare analyses" />
        <Card>
          <CardContent className="pt-5">
            <EmptyState
              title="Nothing selected"
              description="Open a pull request with more than one analysis and use its history to pick two to compare."
              action={{ label: "Browse analyses", href: "/analyses" }}
            />
          </CardContent>
        </Card>
      </PageBody>
    );
  }

  if (isLoading) return <LoadingState label="Comparing" />;

  if (isError) {
    return (
      <PageBody>
        <ErrorState error={error} onRetry={refetch} />
      </PageBody>
    );
  }

  if (!data) return null;

  const improved = data.scoreDelta < 0;
  const unchanged = Math.round(data.scoreDelta) === 0;

  return (
    <PageBody>
      <PageHeader
        breadcrumb={
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href={`/analyses/${data.compare.id}`}>
              <ArrowLeft />
              Back to analysis
            </Link>
          </Button>
        }
        title="Comparison"
        description="What changed between two assessments of the same pull request."
      />

      {/* --- the delta ---------------------------------------------------- */}
      <Card>
        <CardContent className="pt-5">
          <div className="grid gap-5 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
            <Side label="Before" analysis={data.base} />

            <div className="flex flex-col items-center gap-1.5 px-4">
              <span
                className={cn(
                  "flex size-11 items-center justify-center rounded-full border",
                  unchanged
                    ? "border-border bg-muted text-muted-foreground"
                    : improved
                      ? "border-risk-low-border bg-risk-low-bg text-risk-low"
                      : "border-risk-high-border bg-risk-high-bg text-risk-high",
                )}
              >
                {unchanged ? (
                  <Minus className="size-4" />
                ) : improved ? (
                  <ArrowDown className="size-4" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </span>
              <span
                className={cn(
                  "tabular text-sm font-bold",
                  unchanged
                    ? "text-muted-foreground"
                    : improved
                      ? "text-risk-low"
                      : "text-risk-high",
                )}
              >
                {fmtDelta(data.scoreDelta)}
              </span>
              {data.levelChanged && (
                <Badge variant="outline" className="text-[0.625rem]">
                  band changed
                </Badge>
              )}
            </div>

            <Side label="After" analysis={data.compare} />
          </div>
        </CardContent>
      </Card>

      {/* --- factor changes ----------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>What moved</CardTitle>
          <CardDescription>
            Factors ranked by how much their contribution shifted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.factorChanges.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No factor contributions changed between these two analyses.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {data.factorChanges.map((change) => (
                <li key={change.key} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{change.label}</p>
                    <p className="text-[0.6875rem] text-muted-foreground">
                      {FACTOR_CATEGORY_LABEL[change.category] ?? change.category}
                    </p>
                  </div>

                  <Badge
                    variant="outline"
                    className={cn(
                      "shrink-0 text-[0.625rem]",
                      change.change === "ADDED" && "border-risk-high-border text-risk-high",
                      change.change === "REMOVED" && "border-risk-low-border text-risk-low",
                    )}
                  >
                    {change.change.toLowerCase()}
                  </Badge>

                  <span className="tabular w-24 shrink-0 text-right text-xs text-muted-foreground">
                    {change.before ? `${change.before.contribution.toFixed(0)}%` : "—"}
                    {" → "}
                    {change.after ? `${change.after.contribution.toFixed(0)}%` : "—"}
                  </span>

                  <span
                    className={cn(
                      "tabular w-14 shrink-0 text-right text-xs font-semibold",
                      change.contributionDelta > 0 ? "text-risk-high" : "text-risk-low",
                    )}
                  >
                    {fmtDelta(change.contributionDelta, "%")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </PageBody>
  );
}

function Side({
  label,
  analysis,
}: {
  label: string;
  analysis: {
    id: string;
    riskScore: number | null;
    riskLevel: RiskLevel | null;
    headSha: string;
    createdAt: string;
    summary: string | null;
  };
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <Link
          href={`/analyses/${analysis.id}`}
          className="font-mono text-xs text-muted-foreground hover:text-foreground"
        >
          {shortSha(analysis.headSha)}
        </Link>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="tabular text-3xl font-bold leading-none">
          {analysis.riskScore === null ? "—" : Math.round(analysis.riskScore)}
        </span>
        <RiskBadge level={analysis.riskLevel} score={null} hideScore size="sm" />
      </div>

      <RiskMeter score={analysis.riskScore} level={analysis.riskLevel} showBands={false} />

      <p className="text-[0.6875rem] text-muted-foreground">
        {absoluteTime(analysis.createdAt)}
      </p>
    </div>
  );
}
