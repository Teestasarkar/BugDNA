"use client";

/**
 * Deployment timeline.
 *
 * Merges deployments, merged pull requests and high-risk assessments into one
 * chronological stream, so a reader can see that a CRITICAL-scored PR merged at
 * 14:02, deployed at 14:20, and was reported as causing an incident at 14:45.
 *
 * The correlation panel is the most carefully hedged thing in the product. It
 * reports the *observed* difference in shipped risk between deployments that
 * caused incidents and those that did not, along with the sample sizes — and the
 * API refuses to draw a conclusion below three samples per side. Overclaiming
 * here would be the easiest way to lose an engineer's trust permanently, so the
 * interpretation text comes from the backend rather than being composed in the UI.
 */
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  GitMerge,
  Info,
  Plus,
  Rocket,
  ShieldAlert,
  XCircle,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { InfoTooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FieldHint, Input, Label, Textarea } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RiskBadge } from "@/components/risk/risk-badge";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/states";
import {
  useDeployments,
  useRecordDeployment,
  useReportDeploymentOutcome,
  useRepositoryOptions,
  useTimeline,
} from "@/hooks/use-api";
import { absoluteTime, duration, number as fmtNumber, sha as shortSha } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Deployment, TimelineEvent } from "@/types/api";

export default function TimelinePage() {
  return (
    <React.Suspense fallback={<ListSkeleton rows={6} />}>
      <TimelineContent />
    </React.Suspense>
  );
}

function TimelineContent() {
  const params = useSearchParams();
  const initialRepository = params.get("repositoryId") ?? undefined;

  const [repositoryId, setRepositoryId] = React.useState<string | undefined>(
    initialRepository,
  );
  const [days, setDays] = React.useState(30);

  const { data: repositories } = useRepositoryOptions();
  const { data, isLoading, isError, error, refetch, isFetching } = useTimeline({
    days,
    ...(repositoryId ? { repositoryId } : {}),
  });

  const { data: deploymentsPage } = useDeployments({
    ...(repositoryId ? { repositoryId } : {}),
  });

  return (
    <PageBody>
      <PageHeader
        title="Deployment timeline"
        description="What shipped, when, and what happened next."
        action={
          <>
            <Select
              value={repositoryId ?? "all"}
              onValueChange={(value) =>
                setRepositoryId(value === "all" ? undefined : value)
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

            <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
              <SelectTrigger size="sm" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
              </SelectContent>
            </Select>

            <RecordDeploymentDialog
              repositories={repositories ?? []}
              defaultRepositoryId={repositoryId}
            />
          </>
        }
      />

      {isLoading ? (
        <ListSkeleton rows={6} />
      ) : isError ? (
        <Card>
          <CardContent className="pt-5">
            <ErrorState error={error} onRetry={refetch} isRetrying={isFetching} />
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* --- correlation ---------------------------------------------- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                Shipped risk against outcomes
                <InfoTooltip label="Deployments are linked to pull requests by matching the deployed commit against the PR's merge or head commit — a factual join, not an inference. The comparison below is an association observed in your own history; it is not evidence of causation, and BugDNA will say so until there is enough data to say anything at all.">
                  <Info className="size-3 text-muted-foreground" aria-hidden />
                </InfoTooltip>
              </CardTitle>
              <CardDescription>
                Whether the risk BugDNA reported has tracked what actually went
                wrong.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-4">
                <CorrelationStat
                  label="Deployments"
                  value={fmtNumber(data.correlation.deploymentsTotal)}
                  hint={`${fmtNumber(data.correlation.deploymentsWithLinkedPr)} linked to a PR`}
                />
                <CorrelationStat
                  label="Incidents reported"
                  value={fmtNumber(data.correlation.incidentsReported)}
                  accent={data.correlation.incidentsReported > 0}
                />
                <CorrelationStat
                  label="Avg risk — incidents"
                  value={
                    data.correlation.avgRiskWhenIncident === null
                      ? "—"
                      : String(Math.round(data.correlation.avgRiskWhenIncident))
                  }
                  hint={`n=${data.correlation.incidentSampleSize}`}
                />
                <CorrelationStat
                  label="Avg risk — clean"
                  value={
                    data.correlation.avgRiskWhenClean === null
                      ? "—"
                      : String(Math.round(data.correlation.avgRiskWhenClean))
                  }
                  hint={`n=${data.correlation.cleanSampleSize}`}
                />
              </div>

              {/* The backend composes this sentence, hedged to the evidence. */}
              <p className="rounded-lg border border-border bg-surface/50 px-3.5 py-3 text-sm leading-relaxed text-muted-foreground">
                {data.correlation.interpretation}
              </p>
            </CardContent>
          </Card>

          {/* --- deployments awaiting an outcome -------------------------- */}
          {deploymentsPage?.data && (
            <PendingOutcomes deployments={deploymentsPage.data} />
          )}

          {/* --- the stream ---------------------------------------------- */}
          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
              <CardDescription>
                Deployments, merges and high-risk assessments over the last {days}{" "}
                days.
              </CardDescription>
            </CardHeader>

            <CardContent>
              {data.events.length === 0 ? (
                <EmptyState
                  icon={Activity}
                  title="Nothing in this window"
                  description="Deployments, merged pull requests and high-risk assessments appear here as they happen. Record a deployment to start building the picture."
                  compact
                />
              ) : (
                <ol className="relative space-y-0">
                  {/* the spine */}
                  <span
                    className="absolute left-[0.6875rem] top-2 bottom-2 w-px bg-border"
                    aria-hidden
                  />
                  {data.events.map((event) => (
                    <TimelineRow key={event.id} event={event} />
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </PageBody>
  );
}

function CorrelationStat({
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
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "tabular mt-1.5 text-xl font-bold leading-none",
          accent && "text-risk-high",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-[0.6875rem] text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline row
// ---------------------------------------------------------------------------

const EVENT_STYLE = {
  DEPLOYMENT: { icon: Rocket, ring: "border-chart-2 bg-chart-2/10 text-chart-2" },
  PULL_REQUEST_MERGED: { icon: GitMerge, ring: "border-primary/40 bg-primary/10 text-primary" },
  ANALYSIS: { icon: ShieldAlert, ring: "border-risk-high-border bg-risk-high-bg text-risk-high" },
} as const;

function TimelineRow({ event }: { event: TimelineEvent }) {
  const style = EVENT_STYLE[event.type];
  const causedIncident = event.meta.causedIncident === true;
  const unanalysed = event.meta.unanalysed === true;

  return (
    <li className="relative flex gap-3 py-3 pl-0">
      {/* node */}
      <span
        className={cn(
          "relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border",
          causedIncident
            ? "border-risk-critical-border bg-risk-critical-bg text-risk-critical"
            : style.ring,
        )}
      >
        {causedIncident ? (
          <XCircle className="size-3" aria-hidden />
        ) : (
          <style.icon className="size-3" aria-hidden />
        )}
      </span>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium leading-snug">
            {event.href ? (
              <Link href={event.href} className="hover:underline">
                {event.title}
              </Link>
            ) : (
              event.title
            )}
          </p>

          <div className="flex shrink-0 items-center gap-2">
            {event.riskLevel && (
              <RiskBadge level={event.riskLevel} score={event.riskScore} size="sm" />
            )}
            <span className="text-xs text-muted-foreground">
              {absoluteTime(event.at)}
            </span>
          </div>
        </div>

        {event.subtitle && (
          <p className="truncate text-xs text-muted-foreground">{event.subtitle}</p>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-muted-foreground/80">
          <span className="font-mono">{event.repositoryFullName}</span>

          {typeof event.meta.environment === "string" && (
            <Badge variant="muted" className="font-normal">
              {event.meta.environment.toLowerCase()}
            </Badge>
          )}

          {typeof event.meta.sha === "string" && (
            <span className="font-mono">{event.meta.sha}</span>
          )}

          {typeof event.meta.status === "string" && (
            <span
              className={cn(
                event.meta.status === "SUCCESS" && "text-risk-low",
                (event.meta.status === "FAILURE" || event.meta.status === "ROLLED_BACK") &&
                  "text-risk-critical",
              )}
            >
              {event.meta.status.toLowerCase().replace("_", " ")}
            </span>
          )}

          {typeof event.meta.durationMs === "number" && (
            <span>{duration(event.meta.durationMs)}</span>
          )}

          {typeof event.meta.authorLogin === "string" && (
            <span>{event.meta.authorLogin}</span>
          )}

          {/* Merged without ever being analysed — worth surfacing. */}
          {unanalysed && (
            <span className="flex items-center gap-1 text-risk-moderate">
              <AlertTriangle className="size-2.5" aria-hidden />
              merged unanalysed
            </span>
          )}
        </div>

        {/* incident detail */}
        {causedIncident && typeof event.meta.incidentSummary === "string" && (
          <p className="rounded-md border border-risk-critical-border bg-risk-critical-bg px-2.5 py-1.5 text-xs leading-relaxed text-risk-critical">
            {typeof event.meta.incidentSeverity === "string" && (
              <span className="font-semibold">{event.meta.incidentSeverity} · </span>
            )}
            {event.meta.incidentSummary}
          </p>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Outcome reporting
// ---------------------------------------------------------------------------

/**
 * Deployments with no reported outcome.
 *
 * Prompted for, because this is the only ground truth BugDNA ever receives —
 * `module_incident_history` and the correlation panel are both built on it. A
 * timeline of deployments with no outcomes cannot say anything useful.
 */
function PendingOutcomes({ deployments }: { deployments: Deployment[] }) {
  const pending = deployments.filter((deployment) => deployment.causedIncident === null);
  if (pending.length === 0) return null;

  return (
    <Alert variant="info" icon>
      <AlertTitle>
        {pending.length} deployment{pending.length === 1 ? "" : "s"} awaiting an outcome
      </AlertTitle>
      <AlertDescription className="space-y-2.5">
        <p>
          Reporting whether a deployment caused a problem is the only ground truth
          BugDNA gets. It feeds the incident-history signal and the correlation
          above.
        </p>
        <ul className="space-y-1.5">
          {pending.slice(0, 3).map((deployment) => (
            <li key={deployment.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono">{shortSha(deployment.sha)}</span>
              <span className="text-muted-foreground">
                {deployment.repository.fullName}
              </span>
              {deployment.pullRequest && (
                <span className="text-muted-foreground">
                  #{deployment.pullRequest.number}
                </span>
              )}
              <ReportOutcomeDialog deployment={deployment} />
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function ReportOutcomeDialog({ deployment }: { deployment: Deployment }) {
  const [open, setOpen] = React.useState(false);
  const [causedIncident, setCausedIncident] = React.useState<boolean | null>(null);
  const [summary, setSummary] = React.useState("");
  const [severity, setSeverity] = React.useState<"SEV1" | "SEV2" | "SEV3" | "SEV4">("SEV3");

  const report = useReportDeploymentOutcome();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-6 text-[0.6875rem]">
          Report outcome
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>How did this deployment go?</DialogTitle>
          <DialogDescription>
            {deployment.repository.fullName} · {shortSha(deployment.sha)}
            {deployment.pullRequest && ` · #${deployment.pullRequest.number}`}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setCausedIncident(false)}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
                causedIncident === false
                  ? "border-risk-low-border bg-risk-low-bg"
                  : "border-border hover:bg-muted/40",
              )}
            >
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-risk-low" aria-hidden />
              <span>
                <span className="block text-sm font-medium">No problems</span>
                <span className="block text-xs text-muted-foreground">
                  Shipped cleanly.
                </span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => setCausedIncident(true)}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
                causedIncident === true
                  ? "border-risk-critical-border bg-risk-critical-bg"
                  : "border-border hover:bg-muted/40",
              )}
            >
              <XCircle className="mt-0.5 size-4 shrink-0 text-risk-critical" aria-hidden />
              <span>
                <span className="block text-sm font-medium">Caused an incident</span>
                <span className="block text-xs text-muted-foreground">
                  Errors, degradation or a rollback.
                </span>
              </span>
            </button>
          </div>

          {causedIncident === true && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="severity">Severity</Label>
                <Select
                  value={severity}
                  onValueChange={(value) => setSeverity(value as typeof severity)}
                >
                  <SelectTrigger id="severity" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SEV1">SEV1 — total outage</SelectItem>
                    <SelectItem value="SEV2">SEV2 — major degradation</SelectItem>
                    <SelectItem value="SEV3">SEV3 — partial or contained</SelectItem>
                    <SelectItem value="SEV4">SEV4 — minor</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="incident-summary">What happened?</Label>
                <Textarea
                  id="incident-summary"
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  rows={3}
                  placeholder="e.g. 5xx rate on the payments API rose to 12% within four minutes; rolled back."
                />
                <FieldHint>
                  This is stored against the deployment and shown on the timeline.
                </FieldHint>
              </div>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={causedIncident === null}
            loading={report.isPending}
            onClick={() =>
              report.mutate(
                {
                  deploymentId: deployment.id,
                  causedIncident: causedIncident === true,
                  ...(causedIncident ? { incidentSeverity: severity } : {}),
                  ...(summary.trim() ? { incidentSummary: summary.trim() } : {}),
                  status: causedIncident ? "ROLLED_BACK" : "SUCCESS",
                },
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            Record outcome
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecordDeploymentDialog({
  repositories,
  defaultRepositoryId,
}: {
  repositories: Array<{ id: string; fullName: string }>;
  defaultRepositoryId?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [repositoryId, setRepositoryId] = React.useState(
    defaultRepositoryId ?? repositories[0]?.id ?? "",
  );
  const [sha, setSha] = React.useState("");
  const [environment, setEnvironment] = React.useState<
    "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT"
  >("PRODUCTION");
  const [description, setDescription] = React.useState("");

  const record = useRecordDeployment();

  const validSha = /^[0-9a-f]{7,40}$/i.test(sha.trim());

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          Record deployment
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a deployment</DialogTitle>
          <DialogDescription>
            BugDNA links it to the pull request that shipped it by matching the
            commit, so the timeline can show what risk went out.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="deploy-repository">Repository</Label>
            <Select value={repositoryId} onValueChange={setRepositoryId}>
              <SelectTrigger id="deploy-repository" className="w-full">
                <SelectValue placeholder="Select a repository" />
              </SelectTrigger>
              <SelectContent>
                {repositories.map((repository) => (
                  <SelectItem key={repository.id} value={repository.id}>
                    {repository.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="deploy-sha">Deployed commit</Label>
            <Input
              id="deploy-sha"
              value={sha}
              onChange={(event) => setSha(event.target.value)}
              placeholder="a1b2c3d"
              className="font-mono"
              aria-invalid={sha.length > 0 && !validSha}
            />
            <FieldHint error={sha.length > 0 && !validSha}>
              {sha.length > 0 && !validSha
                ? "Must be 7-40 hexadecimal characters."
                : "The merge or head commit that shipped. 7 characters is enough."}
            </FieldHint>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="deploy-environment">Environment</Label>
            <Select
              value={environment}
              onValueChange={(value) => setEnvironment(value as typeof environment)}
            >
              <SelectTrigger id="deploy-environment" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PRODUCTION">Production</SelectItem>
                <SelectItem value="STAGING">Staging</SelectItem>
                <SelectItem value="PREVIEW">Preview</SelectItem>
                <SelectItem value="DEVELOPMENT">Development</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="deploy-description">Description</Label>
            <Input
              id="deploy-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional"
            />
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!validSha || !repositoryId}
            loading={record.isPending}
            onClick={() =>
              record.mutate(
                {
                  repositoryId,
                  sha: sha.trim(),
                  environment,
                  ...(description.trim() ? { description: description.trim() } : {}),
                },
                {
                  onSuccess: () => {
                    setOpen(false);
                    setSha("");
                    setDescription("");
                  },
                },
              )
            }
          >
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
