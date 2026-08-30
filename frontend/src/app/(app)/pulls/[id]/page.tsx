"use client";

/**
 * Pull request detail.
 *
 * The step between "found the PR" and "read the assessment". Its job is to make
 * running an analysis obvious, and to show the diff with the risk engine's own
 * classifications so a reviewer can form their own view first.
 */
import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  GitCommit,
  MessageSquare,
  RefreshCw,
  Sparkles,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { RiskBadge } from "@/components/risk/risk-badge";
import { AnalysisProgress } from "@/components/risk/analysis-progress";
import { DiffViewer } from "@/components/pr/diff-viewer";
import { ScoreHistoryChart } from "@/components/charts";
import { ErrorState, InlineError, LoadingState } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import {
  usePullRequest,
  usePullRequestDiff,
  useRequestAnalysis,
} from "@/hooks/use-api";
import {
  absoluteTime,
  diffStat,
  number as fmtNumber,
  relativeTime,
  sha as shortSha,
} from "@/lib/format";

export default function PullRequestDetailPage() {
  const params = useParams<{ id: string }>();
  const pullRequestId = params.id;

  const { data: pr, isLoading, isError, error, refetch, isFetching } =
    usePullRequest(pullRequestId);

  const {
    data: diff,
    isLoading: diffLoading,
    isError: diffError,
    error: diffErrorObject,
    refetch: refetchDiff,
  } = usePullRequestDiff(pullRequestId, Boolean(pr));

  const analyse = useRequestAnalysis();

  if (isLoading) return <LoadingState label="Loading pull request" />;

  if (isError) {
    return (
      <PageBody>
        <ErrorState error={error} onRetry={refetch} isRetrying={isFetching} />
      </PageBody>
    );
  }

  if (!pr) return null;

  const latest = pr.analyses[0];
  const inFlight = latest?.status === "QUEUED" || latest?.status === "RUNNING";
  const completed = pr.analyses.filter((a) => a.status === "COMPLETED");

  return (
    <PageBody>
      {/* --- header ------------------------------------------------------- */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href={`/pulls?repositoryId=${pr.repository.id}`}>
              <ArrowLeft />
              Pull requests
            </Link>
          </Button>
          <span aria-hidden>/</span>
          <Link
            href={`/repositories/${pr.repository.id}`}
            className="font-mono text-xs transition-colors hover:text-foreground"
          >
            {pr.repository.fullName}
          </Link>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <h1 className="flex flex-wrap items-baseline gap-2 text-xl font-bold tracking-tight sm:text-2xl">
              <span className="font-mono text-base text-muted-foreground">#{pr.number}</span>
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
              <Badge variant="outline" className="font-normal">
                {pr.state.toLowerCase()}
              </Badge>
              {pr.draft && <Badge variant="muted">draft</Badge>}
              <span className="font-mono">
                {pr.baseRef} ← {pr.headRef}
              </span>
              <span className="flex items-center gap-1 font-mono">
                <GitCommit className="size-3" aria-hidden />
                {shortSha(pr.headSha)}
              </span>
              <span>opened {relativeTime(pr.githubCreatedAt)}</span>
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

            {latest && !inFlight ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    analyse.mutate({ pullRequestId: pr.id, force: true })
                  }
                  loading={analyse.isPending}
                >
                  <RefreshCw />
                  Re-analyse
                </Button>
                <Button asChild size="sm">
                  <Link href={`/analyses/${latest.id}`}>
                    View assessment
                    <ArrowRight />
                  </Link>
                </Button>
              </>
            ) : !inFlight ? (
              <Button
                size="sm"
                onClick={() => analyse.mutate({ pullRequestId: pr.id })}
                loading={analyse.isPending}
              >
                <Sparkles />
                Analyse this pull request
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* --- in-flight ---------------------------------------------------- */}
      {inFlight && latest && (
        <AnalysisProgress
          analysisId={latest.id}
          initialStatus={latest.status}
          initialStage={latest.stage}
          initialProgress={latest.progress}
        />
      )}

      {/* --- latest assessment summary ------------------------------------ */}
      {latest?.status === "COMPLETED" && (
        <Card>
          <CardHeader>
            <CardTitle>Latest assessment</CardTitle>
            <CardDescription>
              {latest.headSha === pr.headSha
                ? "For the current head commit."
                : `For ${shortSha(latest.headSha)} — the pull request has changed since.`}
            </CardDescription>
            <CardAction>
              <Button asChild variant="ghost" size="sm">
                <Link href={`/analyses/${latest.id}`}>
                  Full analysis
                  <ArrowRight />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>

          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <RiskBadge
                level={latest.riskLevel}
                score={latest.riskScore}
                size="lg"
                stale={latest.headSha !== pr.headSha}
                heuristic={latest.scoredBy === "HEURISTIC"}
                degraded={latest.degraded}
              />
              <span className="text-xs text-muted-foreground">
                {relativeTime(latest.completedAt)}
              </span>
            </div>

            {latest.summary && (
              <p className="text-sm leading-relaxed text-muted-foreground">
                {latest.summary}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* --- never analysed ----------------------------------------------- */}
      {!latest && (
        <Alert variant="info" icon>
          <AlertTitle>This pull request has not been analysed</AlertTitle>
          <AlertDescription>
            Running an analysis fetches the diff, extracts risk signals, scores it
            and explains the result. It usually takes a few seconds.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* --- diff ------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Changed files</CardTitle>
            <CardDescription>
              With the classifications the risk engine derives from each path and
              patch.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {diffLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-11 w-full" />
                ))}
              </div>
            ) : diffError ? (
              <InlineError error={diffErrorObject} onRetry={refetchDiff} />
            ) : diff ? (
              <DiffViewer files={diff.files} totals={diff.totals} modules={diff.modules} />
            ) : null}
          </CardContent>
        </Card>

        {/* --- sidebar ---------------------------------------------------- */}
        <div className="space-y-4">
          {pr.body && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <MessageSquare className="size-3.5 text-muted-foreground" aria-hidden />
                  Description
                </CardTitle>
              </CardHeader>
              <CardContent>
                {/* Rendered as plain text rather than markdown: this is untrusted
                    author content, and a markdown renderer here would be an XSS
                    surface for no real benefit. */}
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                  {pr.body.slice(0, 2000)}
                  {pr.body.length > 2000 && "…"}
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <Row label="Additions" value={`+${fmtNumber(pr.additions)}`} />
              <Row label="Deletions" value={`−${fmtNumber(pr.deletions)}`} />
              <Row label="Files" value={fmtNumber(pr.changedFiles)} />
              <Row label="Commits" value={fmtNumber(pr.commits)} />
              <Row label="Review comments" value={fmtNumber(pr.reviewComments)} />
              <Row label="Opened" value={absoluteTime(pr.githubCreatedAt)} />
              {pr.mergedAt && <Row label="Merged" value={absoluteTime(pr.mergedAt)} />}
              {pr.mergeable !== null && (
                <Row
                  label="Mergeable"
                  value={pr.mergeable ? "yes" : "has conflicts"}
                />
              )}
              <Row label="Last synced" value={relativeTime(pr.lastSyncedAt)} />

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

          {/* --- risk over time ------------------------------------------ */}
          {completed.length > 1 && (
            <Card>
              <CardHeader>
                <CardTitle>Risk over time</CardTitle>
                <CardDescription>
                  How the score moved as this pull request changed.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ScoreHistoryChart
                  data={completed
                    .slice()
                    .reverse()
                    .map((entry) => ({
                      label: shortSha(entry.headSha, 7),
                      score: entry.riskScore,
                      level: entry.riskLevel,
                    }))}
                />
              </CardContent>
            </Card>
          )}

          {/* --- analysis history ---------------------------------------- */}
          {pr.analyses.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Analyses ({pr.analyses.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1">
                  {pr.analyses.map((entry) => (
                    <li key={entry.id}>
                      <Link
                        href={`/analyses/${entry.id}`}
                        className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/50"
                      >
                        <span className="font-mono text-muted-foreground">
                          {shortSha(entry.headSha)}
                        </span>
                        <span className="text-muted-foreground">
                          {relativeTime(entry.createdAt)}
                        </span>
                        {entry.status === "COMPLETED" ? (
                          <RiskBadge
                            level={entry.riskLevel}
                            score={entry.riskScore}
                            size="sm"
                          />
                        ) : (
                          <Badge variant="muted">{entry.status.toLowerCase()}</Badge>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
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
