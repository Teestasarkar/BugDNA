"use client";

/**
 * Dashboard.
 *
 * The screen that has to answer, in one glance: *is anything about to hurt me?*
 *
 * So it is ordered by urgency rather than by data type. "Needs attention" — open
 * pull requests scored HIGH or CRITICAL with no decision recorded — comes first,
 * above the KPIs and the charts. A dashboard that opens with a pretty trend line
 * while a CRITICAL migration sits unreviewed has its priorities backwards.
 */
import * as React from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  FolderGit2,
  GitPullRequest,
  Loader2,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { PageBody, PageHeader } from "../page-header";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import {
  RecurringFactorsChart,
  RiskDistributionBar,
  RiskTrendChart,
  RiskVolumeChart,
} from "@/components/charts";
import {
  ChartSkeleton,
  EmptyState,
  ErrorState,
  ListSkeleton,
  NoRepositoriesState,
  StatsSkeleton,
} from "@/components/states";
import { useDashboardOverview } from "@/hooks/use-api";
import { diffStat, number as fmtNumber, shortRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const WINDOWS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

export default function DashboardPage() {
  const [days, setDays] = React.useState(30);

  const { data, isLoading, isError, error, refetch, isFetching } =
    useDashboardOverview(days);

  return (
    <PageBody>
      <PageHeader
        title="Dashboard"
        description="Deployment risk across every repository you can see."
        action={
          <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
            <SelectTrigger size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOWS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {isLoading ? (
        <>
          <StatsSkeleton />
          <ListSkeleton rows={3} />
        </>
      ) : isError ? (
        <Card>
          <CardContent className="pt-5">
            <ErrorState error={error} onRetry={refetch} isRetrying={isFetching} />
          </CardContent>
        </Card>
      ) : !data?.hasRepositories ? (
        <NoRepositoriesState />
      ) : (
        <>
          {/* --- needs attention, first ------------------------------------ */}
          {data.attentionNeeded.length > 0 && (
            <Card className="border-risk-high-border">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-risk-high">
                  <TriangleAlert className="size-4" aria-hidden />
                  Needs attention
                </CardTitle>
                <CardDescription>
                  Open pull requests assessed as high or critical risk with no
                  decision recorded yet.
                </CardDescription>
                <CardAction>
                  <Button asChild variant="ghost" size="sm">
                    <Link href="/analyses?riskLevel=HIGH&riskLevel=CRITICAL">
                      View all
                      <ArrowRight />
                    </Link>
                  </Button>
                </CardAction>
              </CardHeader>

              <CardContent className="space-y-2">
                {data.attentionNeeded.map((item) => (
                  <Link
                    key={item.id}
                    href={`/analyses/${item.id}`}
                    className={cn(
                      "block rounded-lg border border-border bg-card p-3.5 transition-colors",
                      "hover:border-risk-high-border hover:bg-risk-high-bg/30",
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex items-baseline gap-2">
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            #{item.pullRequest.number}
                          </span>
                          <span className="truncate text-sm font-medium">
                            {item.pullRequest.title}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span className="font-mono">{item.repository.fullName}</span>
                          <span>{item.pullRequest.authorLogin}</span>
                          <span className="font-mono">
                            {diffStat(
                              item.pullRequest.additions,
                              item.pullRequest.deletions,
                            )}
                          </span>
                          <span>
                            {fmtNumber(item.pullRequest.changedFiles)} files
                          </span>
                        </div>

                        {item.riskFactors.length > 0 && (
                          <RiskFactorChips factors={item.riskFactors} limit={2} />
                        )}
                      </div>

                      <RiskBadge
                        level={item.riskLevel}
                        score={item.riskScore}
                        size="lg"
                        className="shrink-0"
                      />
                    </div>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}

          {/* --- KPIs ----------------------------------------------------- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Repositories"
              value={fmtNumber(data.totals.repositories)}
              hint="connected and syncing"
              icon={FolderGit2}
              href="/repositories"
            />
            <StatTile
              label="Open pull requests"
              value={fmtNumber(data.totals.openPullRequests)}
              hint={`${fmtNumber(data.totals.analyses)} analysed in ${days} days`}
              icon={GitPullRequest}
              href="/pulls"
            />
            <StatTile
              label="Average risk"
              value={
                data.totals.avgRiskScore === null
                  ? "—"
                  : String(Math.round(data.totals.avgRiskScore))
              }
              hint={data.totals.avgRiskScore === null ? "no analyses yet" : "out of 100"}
              icon={Activity}
              accent={
                data.totals.avgRiskScore !== null && data.totals.avgRiskScore >= 60
                  ? "risk"
                  : undefined
              }
            />
            <StatTile
              label="Awaiting a decision"
              value={fmtNumber(data.totals.highRiskOpen)}
              hint="high or critical, still open"
              icon={ShieldAlert}
              accent={data.totals.highRiskOpen > 0 ? "risk" : undefined}
              {...(data.totals.pendingAnalyses > 0
                ? { badge: `${data.totals.pendingAnalyses} running` }
                : {})}
            />
          </div>

          {/* --- charts --------------------------------------------------- */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Risk over time</CardTitle>
                <CardDescription>
                  Average score per day, against the high and critical thresholds.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isFetching && !data ? (
                  <ChartSkeleton />
                ) : (
                  <RiskTrendChart data={data.trend} />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Distribution</CardTitle>
                <CardDescription>
                  {fmtNumber(data.totals.analyses)} completed analyses.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RiskDistributionBar distribution={data.distribution} />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* --- recurring factors ------------------------------------- */}
            <Card>
              <CardHeader>
                <CardTitle>Recurring risk factors</CardTitle>
                <CardDescription>
                  How often each signal raised a score. A factor near the top is a
                  process problem, not a one-off.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RecurringFactorsChart factors={data.topRiskFactors.slice(0, 7)} />
              </CardContent>
            </Card>

            {/* --- volume ------------------------------------------------- */}
            <Card>
              <CardHeader>
                <CardTitle>Analysis volume</CardTitle>
                <CardDescription>Daily counts, stacked by severity.</CardDescription>
              </CardHeader>
              <CardContent>
                <RiskVolumeChart data={data.trend} />
              </CardContent>
            </Card>
          </div>

          {/* --- recent --------------------------------------------------- */}
          <Card>
            <CardHeader>
              <CardTitle>Recent analyses</CardTitle>
              <CardAction>
                <Button asChild variant="ghost" size="sm">
                  <Link href="/analyses">
                    View all
                    <ArrowRight />
                  </Link>
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              {data.recentAnalyses.length === 0 ? (
                <EmptyState
                  icon={ShieldAlert}
                  title="No analyses yet"
                  description="Open a pull request and run an analysis to see it here."
                  action={{ label: "Browse pull requests", href: "/pulls" }}
                  compact
                />
              ) : (
                <ul className="divide-y divide-border">
                  {data.recentAnalyses.map((analysis) => (
                    <li key={analysis.id}>
                      <Link
                        href={`/analyses/${analysis.id}`}
                        className="flex items-center gap-3 py-2.5 transition-colors hover:bg-muted/30"
                      >
                        <Avatar className="size-6 shrink-0">
                          {analysis.pullRequest.authorAvatarUrl && (
                            <AvatarImage src={analysis.pullRequest.authorAvatarUrl} alt="" />
                          )}
                          <AvatarFallback>
                            {initialsOf(analysis.pullRequest.authorLogin)}
                          </AvatarFallback>
                        </Avatar>

                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">
                            <span className="font-mono text-xs text-muted-foreground">
                              #{analysis.pullRequest.number}
                            </span>{" "}
                            {analysis.pullRequest.title}
                          </p>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {analysis.repository.fullName}
                          </p>
                        </div>

                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                          {shortRelativeTime(analysis.completedAt)}
                        </span>

                        <RiskBadge
                          level={analysis.riskLevel}
                          score={analysis.riskScore}
                          size="sm"
                          heuristic={analysis.scoredBy === "HEURISTIC"}
                          degraded={analysis.degraded}
                          className="shrink-0"
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </PageBody>
  );
}

function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  href,
  accent,
  badge,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Activity;
  href?: string;
  accent?: "risk";
  badge?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Icon className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <p
          className={cn(
            "tabular text-2xl font-bold leading-none",
            accent === "risk" && "text-risk-high",
          )}
        >
          {value}
        </p>
        {badge && (
          <span className="flex items-center gap-1 rounded border border-primary/25 bg-primary/5 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary">
            <Loader2 className="size-2.5 animate-spin" aria-hidden />
            {badge}
          </span>
        )}
      </div>

      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </>
  );

  const className = cn(
    "rounded-xl border border-border bg-card p-4",
    href && "transition-colors hover:border-primary/30 hover:bg-accent/20",
  );

  if (href) {
    return (
      <Link href={href} className={cn(className, "block")}>
        {body}
      </Link>
    );
  }

  return <div className={className}>{body}</div>;
}
