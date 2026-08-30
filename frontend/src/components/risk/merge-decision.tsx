"use client";

/**
 * Merge-readiness and decision panel.
 *
 * The end of the workflow, and the part that needed the most restraint. BugDNA
 * deliberately does **not** block a merge or issue a verdict. It states the
 * assessment, lists what is still outstanding, and records what the developer
 * decided.
 *
 * That is a product position, not a limitation. A tool that says "you may not
 * merge this" on the strength of a probability gets switched off within a week.
 * A tool that says "here is what I found, here is what you did about it, and
 * here is the record" is one a team can actually adopt — and the record is what
 * makes the assessment reviewable after an incident.
 *
 * The one piece of friction: overriding a HIGH or CRITICAL assessment requires a
 * written reason. Not to obstruct, but because that is precisely the decision a
 * team will want to read six weeks later.
 */
import * as React from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  FlaskConical,
  GitMerge,
  Info,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldHint, Label, Textarea } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { RiskMeter } from "./risk-badge";
import { RecommendationSummary } from "./recommendations";
import { MERGE_DECISION_PRESENTATION, RISK_PRESENTATION, describeScore, isElevated } from "@/lib/risk";
import { absoluteTime } from "@/lib/format";
import { useRecordMergeDecision } from "@/hooks/use-api";
import { cn } from "@/lib/utils";
import type { MergeDecisionType, MergeReadiness, Recommendation } from "@/types/api";

const DECISION_OPTIONS: Array<{
  value: MergeDecisionType;
  label: string;
  description: string;
  icon: typeof GitMerge;
  /** Requires a reason when the assessment is elevated. */
  isOverride: boolean;
}> = [
  {
    value: "APPROVED_MERGE",
    label: "Merge it",
    description: "Reviewed the assessment and satisfied it is safe to ship.",
    icon: GitMerge,
    isOverride: true,
  },
  {
    value: "BLOCKED",
    label: "Hold it back",
    description: "Not merging until the flagged risks are dealt with.",
    icon: XCircle,
    isOverride: false,
  },
  {
    value: "DEFERRED",
    label: "Defer",
    description: "Waiting on something — a review, a backfill, a release window.",
    icon: Clock,
    isOverride: false,
  },
  {
    value: "CLOSED_WITHOUT_MERGE",
    label: "Close it",
    description: "Abandoning this change.",
    icon: XCircle,
    isOverride: false,
  },
];

export function MergeDecisionPanel({
  readiness,
  recommendations,
  className,
}: {
  readiness: MergeReadiness;
  recommendations: Recommendation[];
  className?: string;
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<MergeDecisionType | null>(null);
  const [reason, setReason] = React.useState("");
  const [addressed, setAddressed] = React.useState<Set<string>>(new Set());

  const record = useRecordMergeDecision();

  const elevated = isElevated(readiness.riskLevel);
  const presentation = readiness.riskLevel ? RISK_PRESENTATION[readiness.riskLevel] : null;
  const existing = readiness.decision;

  // A reason is required only when overriding an elevated assessment.
  const option = DECISION_OPTIONS.find((o) => o.value === selected);
  const reasonRequired = Boolean(elevated && option?.isOverride);
  const canSubmit = selected !== null && (!reasonRequired || reason.trim().length >= 10);

  const openDialog = (decision: MergeDecisionType) => {
    setSelected(decision);
    setReason("");
    setAddressed(new Set(readiness.decision?.addressedRecommendationIds ?? []));
    setDialogOpen(true);
  };

  const submit = () => {
    if (!selected || !canSubmit) return;

    record.mutate(
      {
        analysisId: readiness.analysisId,
        decision: selected,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        addressedRecommendationIds: [...addressed],
      },
      { onSuccess: () => setDialogOpen(false) },
    );
  };

  // ---- not yet scored ----------------------------------------------------
  if (readiness.status !== "COMPLETED") {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Merge readiness</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Available once the analysis completes.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn("overflow-hidden", className)}>
      {/* --- assessment header, tinted by risk band --------------------- */}
      <div className={cn("border-b px-5 py-4", presentation?.className)}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-sm font-semibold">
              {elevated ? (
                <ShieldAlert className="size-4" aria-hidden />
              ) : (
                <ShieldCheck className="size-4" aria-hidden />
              )}
              {presentation?.label ?? "Not assessed"}
            </p>
            <p className="text-xs leading-relaxed opacity-90">
              {describeScore(readiness.riskScore, readiness.highRiskThreshold)}
            </p>
          </div>

          <span className="tabular shrink-0 text-3xl font-bold leading-none">
            {readiness.riskScore === null ? "—" : Math.round(readiness.riskScore)}
          </span>
        </div>

        <RiskMeter
          score={readiness.riskScore}
          level={readiness.riskLevel}
          showBands={false}
          className="mt-3"
        />
      </div>

      <CardContent className="space-y-4 pt-4">
        {/* --- how it was scored ---------------------------------------- */}
        {readiness.scoredBy === "HEURISTIC" && (
          <Alert variant="warning" icon>
            <AlertTitle>Scored without a trained model</AlertTitle>
            <AlertDescription>
              No model artifact was loaded, so this came from BugDNA&apos;s
              transparent rule-based scorer. The factors are still exact — the
              scorer is additive — but treat the number as a structured heuristic
              rather than a prediction.
            </AlertDescription>
          </Alert>
        )}

        {/* --- degradation ---------------------------------------------- */}
        {readiness.degraded && readiness.degradedReasons.length > 0 && (
          <Alert variant="neutral" icon>
            <AlertTitle className="flex items-center gap-1.5">
              <FlaskConical className="size-3.5" />
              Some inputs were incomplete
            </AlertTitle>
            <AlertDescription>
              <ul className="mt-1 space-y-1">
                {readiness.degradedReasons.map((reasonText, index) => (
                  <li key={index} className="text-xs leading-relaxed">
                    {reasonText}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {/* --- outstanding work ----------------------------------------- */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Outstanding
            </p>
            {readiness.outstandingRecommendations.length > 0 && (
              <RecommendationSummary
                recommendations={readiness.outstandingRecommendations}
              />
            )}
          </div>

          {readiness.outstandingRecommendations.length === 0 ? (
            <p className="flex items-center gap-1.5 text-sm text-risk-low">
              <CheckCircle2 className="size-4" aria-hidden />
              Nothing outstanding.
            </p>
          ) : (
            <ul className="space-y-1">
              {readiness.outstandingRecommendations.slice(0, 4).map((item) => (
                <li key={item.id} className="flex items-start gap-2 text-sm">
                  <ArrowRight
                    className="mt-1 size-3 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="leading-snug text-muted-foreground">{item.title}</span>
                </li>
              ))}
              {readiness.outstandingRecommendations.length > 4 && (
                <li className="pl-5 text-xs text-muted-foreground/70">
                  and {readiness.outstandingRecommendations.length - 4} more
                </li>
              )}
            </ul>
          )}
        </div>

        {/* --- GitHub state -------------------------------------------- */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
          <span>
            Pull request:{" "}
            <span className="font-medium text-foreground">
              {readiness.alreadyMerged ? "merged" : readiness.pullRequestState.toLowerCase()}
            </span>
          </span>
          {readiness.isDraft && <span>draft</span>}
          {readiness.githubMergeable === false && (
            <span className="text-risk-moderate">has conflicts on GitHub</span>
          )}
        </div>

        {/* --- the decision -------------------------------------------- */}
        {existing ? (
          <RecordedDecision readiness={readiness} onChange={() => openDialog(existing.decision)} />
        ) : (
          <div className="space-y-2.5 border-t border-border pt-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">What did you decide?</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                BugDNA does not block merges. Recording the decision is what makes
                the assessment reviewable later — and it is the signal a future
                model would learn from.
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {DECISION_OPTIONS.map((decisionOption) => (
                <button
                  key={decisionOption.value}
                  type="button"
                  onClick={() => openDialog(decisionOption.value)}
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg border border-border p-3 text-left",
                    "transition-colors hover:border-primary/40 hover:bg-accent/40",
                    "focus-visible:ring-2 focus-visible:ring-ring outline-none",
                  )}
                >
                  <decisionOption.icon
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 space-y-0.5">
                    <span className="block text-sm font-medium">{decisionOption.label}</span>
                    <span className="block text-xs leading-snug text-muted-foreground">
                      {decisionOption.description}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      {/* --- confirmation dialog ---------------------------------------- */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {DECISION_OPTIONS.find((o) => o.value === selected)?.label ?? "Record decision"}
            </DialogTitle>
            <DialogDescription>
              {presentation?.label} · {Math.round(readiness.riskScore ?? 0)}/100. This is
              recorded against the analysis and appears in the repository history and
              team rollups.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {reasonRequired && (
              <Alert variant="warning" icon>
                <AlertTitle>A reason is required</AlertTitle>
                <AlertDescription>
                  You are approving a {readiness.riskLevel?.toLowerCase()}-risk change.
                  Say why — it is the first thing anyone reads if this turns into an
                  incident.
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="decision-reason">
                {reasonRequired ? "Justification" : "Note"}
                {!reasonRequired && (
                  <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
                )}
              </Label>
              <Textarea
                id="decision-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={4}
                placeholder={
                  reasonRequired
                    ? "e.g. Shipping behind a feature flag, on-call watching the payments dashboard, rollback tested on staging."
                    : "Anything worth remembering about this decision."
                }
                aria-invalid={reasonRequired && reason.trim().length > 0 && reason.trim().length < 10}
              />
              {reasonRequired && (
                <FieldHint error={reason.trim().length > 0 && reason.trim().length < 10}>
                  {reason.trim().length < 10
                    ? `At least 10 characters (${reason.trim().length}/10).`
                    : "Thank you — this will be readable in the audit trail."}
                </FieldHint>
              )}
            </div>

            {/* --- what was addressed ----------------------------------- */}
            {recommendations.length > 0 && (
              <div className="space-y-2">
                <Label>Which recommendations did you address?</Label>
                <p className="text-xs text-muted-foreground">
                  Optional, but it is what separates &ldquo;did the work&rdquo; from
                  &ldquo;merged anyway&rdquo; in the team rollup.
                </p>
                <ul className="space-y-1.5">
                  {recommendations.map((recommendation) => {
                    const checked = addressed.has(recommendation.id);
                    return (
                      <li key={recommendation.id}>
                        <label className="flex cursor-pointer items-start gap-2.5 rounded-md p-1.5 hover:bg-muted/50">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setAddressed((previous) => {
                                const next = new Set(previous);
                                if (next.has(recommendation.id)) next.delete(recommendation.id);
                                else next.add(recommendation.id);
                                return next;
                              })
                            }
                            className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                          />
                          <span className="text-sm leading-snug">{recommendation.title}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </DialogBody>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!canSubmit} loading={record.isPending}>
              Record decision
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function RecordedDecision({
  readiness,
  onChange,
}: {
  readiness: MergeReadiness;
  onChange: () => void;
}) {
  const decision = readiness.decision;
  if (!decision) return null;

  const presentation = MERGE_DECISION_PRESENTATION[decision.decision];

  return (
    <div className="space-y-2.5 border-t border-border pt-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold",
              presentation.className,
            )}
          >
            <Info className="size-3" aria-hidden />
            {presentation.label}
          </span>
          <p className="text-xs text-muted-foreground">
            Recorded {absoluteTime(decision.createdAt)}
          </p>
        </div>

        <Button variant="outline" size="sm" onClick={onChange}>
          Change
        </Button>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {presentation.description}
      </p>

      {decision.addressedRecommendationIds.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-risk-low">
          <CheckCircle2 className="size-3.5" aria-hidden />
          {decision.addressedRecommendationIds.length} recommendation
          {decision.addressedRecommendationIds.length === 1 ? "" : "s"} marked addressed
        </p>
      )}
    </div>
  );
}

/** Compact decision badge for list rows. */
export function MergeDecisionBadge({
  decision,
  className,
}: {
  decision: MergeDecisionType;
  className?: string;
}) {
  const presentation = MERGE_DECISION_PRESENTATION[decision];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.6875rem] font-medium",
        presentation.className,
        className,
      )}
      title={presentation.description}
    >
      {decision === "OVERRIDDEN" && <AlertTriangle className="size-3" aria-hidden />}
      {presentation.label}
    </span>
  );
}
