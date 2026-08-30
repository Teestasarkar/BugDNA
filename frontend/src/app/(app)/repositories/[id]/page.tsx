"use client";

/**
 * Repository detail — health analytics.
 *
 * Aggregates the repository's history into engineering-health signals: risk
 * trend, distribution, test discipline, deployment reliability and the risk
 * factors that keep recurring.
 *
 * The health score is presented with its formula and its confidence, not as a
 * bare number. It is a product heuristic, and a composite score that hides how
 * it was computed is exactly the kind of thing engineers rightly distrust.
 */
import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Info,
  Lock,
  RefreshCw,
  Rocket,
  TriangleAlert,
} from "lucide-react";
import { PageBody, PageHeader } from "../../page-header";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { InfoTooltip } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  HealthGauge,
  RecurringFactorsChart,
  RiskDistributionBar,
  RiskTrendChart,
} from "@/components/charts";
import { ChartSkeleton, ErrorState, LoadingState } from "@/components/states";
import {
  useRepository,
  useRepositoryHealth,
  useSyncDeployments,
  useSyncRepository,
} from "@/hooks/use-api";
import { number as fmtNumber, percent, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const WINDOWS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

export default function RepositoryDetailPage() {
  const params = useParams<{ id: string }>();
  const repositoryId = params.id;

  const [days, setDays] = React.useState(30);

  const { data: repository, isLoading, isError, error, refetch } = useRepository(repositoryId);
  const {
    data: health,
    isLoading: healthLoading,
    isError: healthError,
    error: healthErrorObject,
    refetch: refetchHealth,
  } = useRepositoryHealth(repositoryId, days);

  const sync = useSyncRepository();
  const syncDeployments = useSyncDeployments();

  if (isLoading) return <LoadingState label="Loading repository" />;

  if (isError) {
    return (
      <PageBody>
        <ErrorState error={error} onRetry={refetch} />
      </PageBody>
    );
  }

  if (!repository) return null;

  return (
    <PageBody>
      <PageHeader
        breadcrumb={
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href="/repositories">
              <ArrowLeft />
              Repositories
            </Link>
          </Button>
        }
        title={
          <span className="flex items-center gap-2 font-mono">
            {repository.fullName}
            {repository.private && (
              <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
          </span>
        }
        description={repository.description ?? undefined}
        action={
          <>
            <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
              <SelectTrigger size="sm" className="w-24">
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

            <Button
              variant="outline"
              size="sm"
              onClick={() => sync.mutate({ repositoryId })}
              loading={sync.isPending}
            >
              <RefreshCw />
              Sync
            </Button>

            {repository.htmlUrl && (
              <Button asChild variant="outline" size="sm">
                <a href={repository.htmlUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink />
                  GitHub
                </a>
              </Button>
            )}
          </>
        }
      />

      {/* --- sync error --------------------------------------------------- */}
      {repository.syncError && (
        <Alert variant="warning" icon>
          <AlertTitle>The last sync failed</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{repository.syncError}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => sync.mutate({ repositoryId })}
              loading={sync.isPending}
            >
              <RefreshCw />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* --- meta bar ----------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {repository.language && <span>{repository.language}</span>}
        <span>default branch {repository.defaultBranch}</span>
        <span>{fmtNumber(repository.counts.pullRequests)} pull requests tracked</span>
        <span>{fmtNumber(repository.counts.analyses)} analyses</span>
        <span>{fmtNumber(repository.counts.deployments)} deployments</span>
        {repository.team && (
          <Badge variant="muted" className="font-normal">
            shared with {repository.team.name}
          </Badge>
        )}
        <span>
          synced {repository.lastSyncedAt ? relativeTime(repository.lastSyncedAt) : "never"}
        </span>
      </div>

      {/* --- quick links -------------------------------------------------- */}
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href={`/pulls?repositoryId=${repositoryId}`}>
            Open pull requests
            <ArrowRight />
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href={`/analyses?repositoryId=${repositoryId}`}>Analysis history</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href={`/timeline?repositoryId=${repositoryId}`}>
            <Rocket />
            Deployment timeline
          </Link>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => syncDeployments.mutate(repositoryId)}
          loading={syncDeployments.isPending}
        >
          Import GitHub deployments
        </Button>
      </div>

      {/* --- health ------------------------------------------------------- */}
      {healthLoading ? (
        <ChartSkeleton height={260} />
      ) : healthError ? (
        <Card>
          <CardContent className="pt-5">
            <ErrorState error={healthErrorObject} onRetry={refetchHealth} />
          </CardContent>
        </Card>
      ) : health ? (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            {/* health score */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  Health score
                  <InfoTooltip
                    label={
                      "A product heuristic, not a model output. Starts at 100, then: up to 40 points off for average PR risk, 25 for the share of high-risk PRs, 20 for deployment failures, and up to 15 back for test discipline. Low-volume repositories are pulled toward 100 in proportion to how little evidence exists."
                    }
                  >
                    <Info className="size-3 text-muted-foreground" aria-hidden />
                  </InfoTooltip>
                </CardTitle>
                <CardDescription>Composite, over {days} days.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <HealthGauge
                  score={health.health.score}
                  confidence={health.health.confidence}
                  className="mx-auto"
                />

                {health.health.confidence === "low" && (
                  <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
                    Based on {fmtNumber(health.totals.analyses)} analys
                    {health.totals.analyses === 1 ? "is" : "es"} — too few to be
                    confident. The score is shrunk toward 100 to reflect that.
                  </p>
                )}

                {Object.keys(health.health.components).length > 0 && (
                  <dl className="space-y-1.5 border-t border-border pt-3 text-xs">
                    {[
                      { key: "riskPenalty", label: "Risk penalty", sign: "−" },
                      { key: "highRiskPenalty", label: "High-risk share", sign: "−" },
                      { key: "deploymentPenalty", label: "Deployment failures", sign: "−" },
                      { key: "testBonus", label: "Test discipline", sign: "+" },
                    ].map((row) => {
                      const value = health.health.components[row.key];
                      if (value === undefined) return null;
                      return (
                        <div key={row.key} className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">{row.label}</dt>
                          <dd
                            className={cn(
                              "tabular font-medium",
                              row.sign === "+" ? "text-risk-low" : "text-risk-high",
                            )}
                          >
                            {row.sign}
                            {value.toFixed(1)}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                )}
              </CardContent>
            </Card>

            {/* trend */}
            <Card>
              <CardHeader>
                <CardTitle>Risk trend</CardTitle>
                <CardDescription>
                  Average score per day over the last {days} days.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RiskTrendChart data={health.trend} height={228} />
              </CardContent>
            </Card>
          </div>

          {/* --- totals ---------------------------------------------------- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Average risk"
              value={
                health.totals.avgRiskScore === null
                  ? "—"
                  : String(Math.round(health.totals.avgRiskScore))
              }
              hint={
                health.totals.p90RiskScore !== null
                  ? `p90 ${Math.round(health.totals.p90RiskScore)}`
                  : undefined
              }
              accent={
                health.totals.avgRiskScore !== null && health.totals.avgRiskScore >= 60
              }
            />
            <Stat
              label="Test discipline"
              value={
                health.totals.testCoverageRatio === null
                  ? "—"
                  : percent(health.totals.testCoverageRatio)
              }
              hint="of analysed PRs touched tests"
              accent={
                health.totals.testCoverageRatio !== null &&
                health.totals.testCoverageRatio < 40
              }
            />
            <Stat
              label="Deployment failures"
              value={
                health.totals.deploymentFailureRate === null
                  ? "—"
                  : percent(health.totals.deploymentFailureRate)
              }
              hint={`${fmtNumber(health.totals.deploymentsFailed)} of ${fmtNumber(
                health.totals.deployments,
              )}`}
              accent={
                health.totals.deploymentFailureRate !== null &&
                health.totals.deploymentFailureRate >= 25
              }
            />
            <Stat
              label="High-risk overrides"
              value={fmtNumber(health.totals.highRiskOverrides)}
              hint={`of ${fmtNumber(health.totals.decisionsRecorded)} decisions`}
              accent={health.totals.highRiskOverrides > 0}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* --- distribution ------------------------------------------- */}
            <Card>
              <CardHeader>
                <CardTitle>Risk distribution</CardTitle>
                <CardDescription>
                  {fmtNumber(health.totals.analyses)} completed analyses.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RiskDistributionBar distribution={health.distribution} />
              </CardContent>
            </Card>

            {/* --- recurring ---------------------------------------------- */}
            <Card>
              <CardHeader>
                <CardTitle>Recurring risk factors</CardTitle>
                <CardDescription>
                  Signals that raised the score most often. A factor near the top is
                  a habit worth changing.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RecurringFactorsChart factors={health.recurringRiskFactors.slice(0, 7)} />
              </CardContent>
            </Card>
          </div>

          {/* --- contributors -------------------------------------------- */}
          {health.contributors.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Contributors</CardTitle>
                <CardDescription>
                  Pull request activity over the last {days} days.
                </CardDescription>
                <CardAction>
                  <InfoTooltip label="Shown to give context on where change is coming from. BugDNA deliberately does not rank or score individuals — the model assesses changes, not people.">
                    <Info className="size-3.5 text-muted-foreground" aria-hidden />
                  </InfoTooltip>
                </CardAction>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Author</TableHead>
                      <TableHead className="text-right">Pull requests</TableHead>
                      <TableHead className="text-right">Avg additions</TableHead>
                      <TableHead className="text-right">Avg files</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {health.contributors.map((contributor) => (
                      <TableRow key={contributor.login}>
                        <TableCell className="font-medium">{contributor.login}</TableCell>
                        <TableCell className="tabular text-right">
                          {fmtNumber(contributor.pullRequests)}
                        </TableCell>
                        <TableCell className="tabular text-right text-muted-foreground">
                          {contributor.avgAdditions === null
                            ? "—"
                            : Math.round(contributor.avgAdditions)}
                        </TableCell>
                        <TableCell className="tabular text-right text-muted-foreground">
                          {contributor.avgFilesChanged === null
                            ? "—"
                            : Math.round(contributor.avgFilesChanged)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* --- no data yet ------------------------------------------- */}
          {health.totals.analyses === 0 && (
            <Alert variant="info" icon>
              <AlertTitle>No analyses in this window</AlertTitle>
              <AlertDescription>
                Health metrics need completed analyses. Analyse a few open pull
                requests and this view fills in.
              </AlertDescription>
            </Alert>
          )}

          {health.totals.deployments === 0 && (
            <Alert variant="neutral" icon>
              <AlertTitle>No deployments recorded</AlertTitle>
              <AlertDescription>
                Deployment reliability, incident history and the timeline&apos;s
                correlation panel all need deployment outcomes. Import them from
                GitHub, or record them from the{" "}
                <Link
                  href={`/timeline?repositoryId=${repositoryId}`}
                  className="font-medium underline"
                >
                  timeline
                </Link>
                .
              </AlertDescription>
            </Alert>
          )}
        </>
      ) : null}
    </PageBody>
  );
}

function Stat({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {accent && (
          <TriangleAlert className="size-3 shrink-0 text-risk-moderate" aria-hidden />
        )}
      </div>
      <p
        className={cn(
          "tabular mt-2 text-2xl font-bold leading-none",
          accent && "text-risk-high",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
