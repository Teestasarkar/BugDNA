"use client";

/**
 * Analysis detail — the page the product is built around.
 *
 * Reading order is the argument it makes, so the layout follows it:
 *
 *   1. **the verdict** — score, band, one-paragraph summary
 *   2. **why** — SHAP factors, each traceable to files in the diff
 *   3. **what to do** — recommendations tied to those factors
 *   4. **the decision** — merge readiness, and recording the call
 *
 * The diff, the pipeline trace and the model provenance are available but
 * secondary: they are what you look at when you disagree with the verdict, not
 * what you read to understand it.
 */
import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Clock,
  Cpu,
  ExternalLink,
  FileCode2,
  FlaskConical,
  GitCommit,
  GitPullRequest,
  Info,
  Layers,
  Lightbulb,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { PageBody } from "../../page-header";
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
import { Avatar, AvatarFallback, AvatarImage, initialsOf } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { InfoTooltip } from "@/components/ui/tooltip";
import { RiskMeter, RiskScoreDisplay, RiskBadge } from "@/components/risk/risk-badge";
import {
  RiskCategoryBreakdown,
  RiskFactorList,
} from "@/components/risk/risk-factors";
import { RecommendationList } from "@/components/risk/recommendations";
import { MergeDecisionPanel } from "@/components/risk/merge-decision";
import {
  AnalysisProgress,
  AnalysisTimingTrace,
  useWatchAnalysis,
} from "@/components/risk/analysis-progress";
import { DiffViewer } from "@/components/pr/diff-viewer";
import { ScoreHistoryChart } from "@/components/charts";
import { ErrorState, LoadingState } from "@/components/states";
import {
  useAnalysis,
  useMergeReadiness,
  usePullRequestAnalyses,
  useRetryAnalysis,
} from "@/hooks/use-api";
import { RISK_PRESENTATION } from "@/lib/risk";
import {
  absoluteTime,
  diffStat,
  duration,
  number as fmtNumber,
  relativeTime,
  sha as shortSha,
} from "@/lib/format";
import { cn } from "@/lib/utils";

export default function AnalysisDetailPage() {
  const params = useParams<{ id: string }>();
  const analysisId = params.id;

  const { data: analysis, isLoading, isError, error, refetch, isFetching } =
    useAnalysis(analysisId);

  const inFlight =
    analysis?.status === "QUEUED" || analysis?.status === "RUNNING";

  // Follow live progress while this analysis is still running.
  useWatchAnalysis(analysisId, Boolean(inFlight));

  const { data: readiness } = useMergeReadiness(
    analysis?.status === "COMPLETED" ? analysisId : undefined,
  );

  const { data: history } = usePullRequestAnalyses(analysis?.pullRequest.id);
  const retry = useRetryAnalysis();

  if (isLoading) return <LoadingState label="Loading analysis" />;

  if (isError) {
    return (
      <PageBody>
        <ErrorState error={error} onRetry={refetch} isRetrying={isFetching} />
      </PageBody>
    );
  }

  if (!analysis) return null;

  const pr = analysis.pullRequest;
  const presentation = analysis.riskLevel ? RISK_PRESENTATION[analysis.riskLevel] : null;

  // A score for a commit the PR has moved past is still useful, but it must be
  // labelled — otherwise a reviewer reads it as current.
  const stale = analysis.headSha !== pr.headSha;

  const increasing = analysis.riskFactors.filter(
    (factor) => factor.direction === "INCREASES_RISK",
  );
  const decreasing = analysis.riskFactors.filter(
    (factor) => factor.direction === "DECREASES_RISK",
  );

  return (
    <PageBody>
      {/* --- breadcrumb + PR header -------------------------------------- */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href={`/pulls/${pr.id}`}>
              <ArrowLeft />
              Pull request
            </Link>
          </Button>
          <span aria-hidden>/</span>
          <Link
            href={`/repositories/${analysis.repository.id}`}
            className="font-mono text-xs transition-colors hover:text-foreground"
          >
            {analysis.repository.fullName}
          </Link>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <h1 className="flex flex-wrap items-baseline gap-2 text-xl font-bold tracking-tight sm:text-2xl">
              <span className="font-mono text-base text-muted-foreground">
                #{pr.number}
              </span>
              <span className="text-balance">{pr.title}</span>
            </h1>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Avatar className="size-4">
                  {pr.authorAvatarUrl && <AvatarImage src={pr.authorAvatarUrl} alt="" />}
                  <AvatarFallback>{initialsOf(pr.authorLogin)}</AvatarFallback>
                </Avatar>
                {pr.authorLogin}
              </span>

              <span className="flex items-center gap-1 font-mono">
                <GitCommit className="size-3" aria-hidden />
                {shortSha(analysis.headSha)}
              </span>

              <span className="font-mono">{diffStat(pr.additions, pr.deletions)}</span>
              <span>{fmtNumber(pr.changedFiles)} files</span>
              <span>{pr.baseRef} ← {pr.headRef}</span>

              <Badge variant="outline" className="font-normal">
                {pr.state.toLowerCase()}
              </Badge>
              {pr.draft && <Badge variant="muted">draft</Badge>}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {pr.htmlUrl && (
              <Button asChild variant="outline" size="sm">
                <a href={pr.htmlUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink />
                  GitHub
                </a>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => retry.mutate(analysisId)}
              loading={retry.isPending}
            >
              <RefreshCw />
              Re-analyse
            </Button>
          </div>
        </div>
      </div>

      {/* --- in-flight ---------------------------------------------------- */}
      {inFlight && (
        <AnalysisProgress
          analysisId={analysisId}
          initialStatus={analysis.status}
          initialStage={analysis.stage}
          initialProgress={analysis.progress}
        />
      )}

      {/* --- failed ------------------------------------------------------- */}
      {analysis.status === "FAILED" && (
        <Alert variant="danger" icon>
          <AlertTitle>This analysis failed</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{analysis.errorMessage}</p>
            <p className="font-mono text-xs opacity-70">
              {analysis.errorCode} · {analysis.attempts} attempt
              {analysis.attempts === 1 ? "" : "s"}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => retry.mutate(analysisId)}
              loading={retry.isPending}
            >
              <RefreshCw />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* --- stale -------------------------------------------------------- */}
      {stale && analysis.status === "COMPLETED" && (
        <Alert variant="warning" icon>
          <AlertTitle>This assessment is for an earlier commit</AlertTitle>
          <AlertDescription>
            It was computed for <code className="font-mono">{shortSha(analysis.headSha)}</code>,
            but the pull request head is now{" "}
            <code className="font-mono">{shortSha(pr.headSha)}</code>. Re-analyse for a
            current assessment.
          </AlertDescription>
        </Alert>
      )}

      {/* --- the verdict -------------------------------------------------- */}
      {analysis.status === "COMPLETED" && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card className={cn("overflow-hidden", stale && "opacity-90")}>
            <div className={cn("border-b px-5 py-5", presentation?.className)}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <ShieldAlert className="size-4" aria-hidden />
                    {presentation?.label}
                  </p>
                  <RiskScoreDisplay
                    score={analysis.riskScore}
                    level={analysis.riskLevel}
                    className="text-current"
                  />
                </div>

                <div className="flex flex-col items-end gap-1.5 text-xs">
                  {analysis.scoredBy === "HEURISTIC" ? (
                    <InfoTooltip label="No trained model artifact was loaded, so this was scored by BugDNA's transparent rule-based fallback. The attributions are exact, because that scorer is additive.">
                      <span className="flex items-center gap-1 font-medium">
                        <FlaskConical className="size-3" aria-hidden />
                        heuristic scorer
                      </span>
                    </InfoTooltip>
                  ) : (
                    <span className="flex items-center gap-1 font-medium">
                      <Cpu className="size-3" aria-hidden />
                      {analysis.modelName ?? "model"} {analysis.modelVersion}
                    </span>
                  )}
                  {analysis.confidence !== null && (
                    <InfoTooltip label="How far the prediction sits from the decision boundary. A measure of how decisive the signals were, not a calibrated confidence interval.">
                      <span className="opacity-80">
                        {Math.round((analysis.confidence ?? 0) * 100)}% decisiveness
                      </span>
                    </InfoTooltip>
                  )}
                </div>
              </div>

              <RiskMeter
                score={analysis.riskScore}
                level={analysis.riskLevel}
                className="mt-4"
              />
            </div>

            <CardContent className="space-y-4 pt-4">
              {/* the narrative */}
              {analysis.summary && (
                <p className="text-sm leading-relaxed">{analysis.summary}</p>
              )}

              {/* degradation disclosure */}
              {analysis.degraded && analysis.degradedReasons.length > 0 && (
                <Alert variant="neutral" icon>
                  <AlertTitle>Caveats on this assessment</AlertTitle>
                  <AlertDescription>
                    <ul className="mt-1 space-y-1">
                      {analysis.degradedReasons.map((reason, index) => (
                        <li key={index} className="text-xs leading-relaxed">
                          {reason}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock className="size-3" aria-hidden />
                  {duration(analysis.durationMs)}
                </span>
                <span>{relativeTime(analysis.completedAt)}</span>
                {analysis.requestedBy && <span>by {analysis.requestedBy.githubLogin}</span>}
                {analysis.featureSetVersion && (
                  <InfoTooltip label="Version of the feature contract used. Bumped whenever the set of extracted signals changes, so historical analyses stay interpretable.">
                    <span className="font-mono">features v{analysis.featureSetVersion}</span>
                  </InfoTooltip>
                )}
              </div>
            </CardContent>
          </Card>

          {/* --- category rollup + history -------------------------------- */}
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <Layers className="size-3.5 text-muted-foreground" aria-hidden />
                  Kind of risk
                </CardTitle>
                <CardDescription>
                  Where the score came from, by category.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RiskCategoryBreakdown factors={analysis.riskFactors} />
              </CardContent>
            </Card>

            {history && history.length > 1 && (
              <Card>
                <CardHeader>
                  <CardTitle>Score over time</CardTitle>
                  <CardDescription>
                    Every analysis of this pull request.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ScoreHistoryChart
                    data={history.map((entry) => ({
                      label: shortSha(entry.headSha, 7),
                      score: entry.riskScore,
                      level: entry.riskLevel,
                    }))}
                  />
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* --- why / what / diff -------------------------------------------- */}
      {analysis.status === "COMPLETED" && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <Tabs defaultValue="why">
              <TabsList>
                <TabsTrigger value="why">
                  Why ({analysis.riskFactors.length})
                </TabsTrigger>
                <TabsTrigger value="actions">
                  What to do ({analysis.recommendations.length})
                </TabsTrigger>
                <TabsTrigger value="diff">
                  Diff ({fmtNumber(pr.files.length)})
                </TabsTrigger>
                <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
              </TabsList>

              {/* --- why ---------------------------------------------------- */}
              <TabsContent value="why" className="mt-4 space-y-5">
                <Card>
                  <CardHeader>
                    <CardTitle>What drove the score</CardTitle>
                    <CardDescription>
                      SHAP attributions from the model, ranked by influence. Bars
                      diverge from centre: right raises risk, left reduces it.
                      Expand a factor to see the files that caused it.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <RiskFactorList factors={analysis.riskFactors} />
                  </CardContent>
                </Card>

                {/* Split view makes the protective factors impossible to miss. */}
                {decreasing.length > 0 && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-risk-high-border bg-risk-high-bg/40 p-3.5">
                      <p className="text-xs font-semibold text-risk-high">
                        Raised the score ({increasing.length})
                      </p>
                      <ul className="mt-2 space-y-1">
                        {increasing.slice(0, 5).map((factor) => (
                          <li key={factor.key} className="flex justify-between gap-2 text-xs">
                            <span className="truncate">{factor.label}</span>
                            <span className="tabular shrink-0 font-medium">
                              {factor.contribution.toFixed(0)}%
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="rounded-lg border border-risk-low-border bg-risk-low-bg/40 p-3.5">
                      <p className="text-xs font-semibold text-risk-low">
                        Reduced it ({decreasing.length})
                      </p>
                      <ul className="mt-2 space-y-1">
                        {decreasing.slice(0, 5).map((factor) => (
                          <li key={factor.key} className="flex justify-between gap-2 text-xs">
                            <span className="truncate">{factor.label}</span>
                            <span className="tabular shrink-0 font-medium">
                              {factor.contribution.toFixed(0)}%
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </TabsContent>

              {/* --- actions ---------------------------------------------- */}
              <TabsContent value="actions" className="mt-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-1.5">
                      <Lightbulb className="size-3.5 text-muted-foreground" aria-hidden />
                      Recommendations
                    </CardTitle>
                    <CardDescription>
                      Each one fired because of a specific signal in this diff — the
                      triggering factors are listed on the card.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <RecommendationList recommendations={analysis.recommendations} />
                  </CardContent>
                </Card>
              </TabsContent>

              {/* --- diff ------------------------------------------------- */}
              <TabsContent value="diff" className="mt-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-1.5">
                      <FileCode2 className="size-3.5 text-muted-foreground" aria-hidden />
                      Changed files
                    </CardTitle>
                    <CardDescription>
                      Each file carries the classification the extractor derived from
                      it — which is exactly what fed the score.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <DiffViewer
                      files={pr.files}
                      totals={{
                        files: pr.files.length,
                        additions: pr.additions,
                        deletions: pr.deletions,
                        truncatedPatches: pr.files.filter((f) => f.patchTruncated).length,
                      }}
                    />
                  </CardContent>
                </Card>
              </TabsContent>

              {/* --- pipeline --------------------------------------------- */}
              <TabsContent value="pipeline" className="mt-4 space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Where the time went</CardTitle>
                    <CardDescription>
                      Per-stage timings from this run.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <AnalysisTimingTrace
                      events={analysis.events}
                      totalMs={analysis.durationMs}
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Feature vector</CardTitle>
                    <CardDescription>
                      The exact input sent to the risk service, retained for
                      reproducibility.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <FeatureTable features={analysis.features} />
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>

          {/* --- decision column ----------------------------------------- */}
          <div className="space-y-4">
            {readiness && (
              <MergeDecisionPanel
                readiness={readiness}
                recommendations={analysis.recommendations}
              />
            )}

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <GitPullRequest className="size-3.5 text-muted-foreground" aria-hidden />
                  Pull request
                </CardTitle>
                <CardAction>
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/pulls/${pr.id}`}>Open</Link>
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <Row label="Opened" value={absoluteTime(pr.githubCreatedAt)} />
                <Row label="Updated" value={relativeTime(pr.githubUpdatedAt)} />
                {pr.mergedAt && <Row label="Merged" value={absoluteTime(pr.mergedAt)} />}
                <Row label="Commits" value={fmtNumber(pr.commits)} />
                <Row
                  label="Review comments"
                  value={fmtNumber(pr.reviewComments)}
                />
                {pr.labels.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {pr.labels.map((label) => (
                      <Badge key={label} variant="muted" className="font-normal">
                        {label}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* --- history --------------------------------------------- */}
            {history && history.length > 1 && (
              <Card>
                <CardHeader>
                  <CardTitle>Previous analyses</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1.5">
                    {history
                      .slice()
                      .reverse()
                      .map((entry) => (
                        <li key={entry.id}>
                          <Link
                            href={`/analyses/${entry.id}`}
                            className={cn(
                              "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs",
                              "transition-colors hover:bg-muted/50",
                              entry.id === analysisId && "bg-accent/50 font-medium",
                            )}
                          >
                            <span className="font-mono text-muted-foreground">
                              {shortSha(entry.headSha)}
                            </span>
                            <span className="text-muted-foreground">
                              {relativeTime(entry.createdAt)}
                            </span>
                            <RiskBadge
                              level={entry.riskLevel}
                              score={entry.riskScore}
                              size="sm"
                              hideScore={false}
                            />
                          </Link>
                        </li>
                      ))}
                  </ul>

                  {history.length > 1 && (
                    <Button asChild variant="outline" size="sm" className="mt-3 w-full">
                      <Link
                        href={`/analyses/compare?base=${history[0]?.id}&compare=${
                          history[history.length - 1]?.id
                        }`}
                      >
                        Compare first and latest
                      </Link>
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </PageBody>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

/**
 * The raw feature vector.
 *
 * Included because a reviewer who distrusts the score should be able to see
 * exactly what the model was given. Sorted with non-zero values first, since a
 * table of 43 rows mostly reading "0" buries the signal.
 */
function FeatureTable({ features }: { features: Record<string, number> | null }) {
  const [showAll, setShowAll] = React.useState(false);

  if (!features) {
    return (
      <p className="text-sm text-muted-foreground">
        No feature vector was retained for this analysis.
      </p>
    );
  }

  const entries = Object.entries(features).sort(([, a], [, b]) => {
    if (a === 0 && b !== 0) return 1;
    if (b === 0 && a !== 0) return -1;
    return Math.abs(b) - Math.abs(a);
  });

  const nonZero = entries.filter(([, value]) => value !== 0);
  const visible = showAll ? entries : nonZero;

  return (
    <div className="space-y-3">
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {visible.map(([key, value]) => (
          <div key={key} className="flex items-baseline justify-between gap-2 text-xs">
            <code className="truncate font-mono text-muted-foreground" title={key}>
              {key}
            </code>
            <span className="tabular shrink-0 font-medium">
              {Number.isInteger(value) ? value : value.toFixed(3)}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-2">
        <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>
          {showAll
            ? `Show only non-zero (${nonZero.length})`
            : `Show all ${entries.length} features`}
        </Button>
        <InfoTooltip label="Every feature is derived from the pull request diff, its GitHub metadata, or deployment outcomes you reported. See the methodology page for what each one means.">
          <Info className="size-3.5 text-muted-foreground" aria-hidden />
        </InfoTooltip>
      </div>
    </div>
  );
}
