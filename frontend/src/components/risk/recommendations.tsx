"use client";

/**
 * Recommendations.
 *
 * The "what should I do about it" half of the product. Each recommendation was
 * produced by a rule that fired on a specific detected signal, and this component
 * keeps that link visible: the factor keys that triggered it are shown, so a
 * developer can see the advice is a consequence of their diff rather than a
 * generic checklist.
 *
 * The checkbox is not cosmetic. Ticking an item records it as addressed when the
 * merge decision is submitted, which is what lets the team dashboard distinguish
 * "merged a high-risk PR having done the work" from "merged it anyway".
 */
import {
  Beaker,
  Boxes,
  CheckCircle2,
  Circle,
  Database,
  Eye,
  FileText,
  GitPullRequest,
  Layers,
  Rocket,
  Settings,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EFFORT_LABEL, PRIORITY_PRESENTATION, RECOMMENDATION_CATEGORY_LABEL } from "@/lib/risk";
import { truncatePath } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Recommendation, RecommendationCategory } from "@/types/api";

const CATEGORY_ICON: Record<RecommendationCategory, LucideIcon> = {
  TESTING: Beaker,
  CODE_REVIEW: GitPullRequest,
  DEPENDENCY: Boxes,
  DATABASE: Database,
  API_CONTRACT: Layers,
  CONFIGURATION: Settings,
  SECURITY: ShieldAlert,
  OBSERVABILITY: Eye,
  ROLLOUT: Rocket,
  SCOPE: Layers,
  DOCUMENTATION: FileText,
};

export function RecommendationList({
  recommendations,
  /** Ids the user has ticked. Omit to render read-only. */
  addressed,
  onToggle,
  className,
}: {
  recommendations: Recommendation[];
  addressed?: Set<string>;
  onToggle?: (id: string) => void;
  className?: string;
}) {
  if (recommendations.length === 0) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-risk-low-border bg-risk-low-bg px-4 py-3">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-risk-low" aria-hidden />
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-risk-low">Nothing to action</p>
          <p className="text-xs leading-relaxed text-risk-low/80">
            No rule fired on this change. BugDNA emits recommendations only when it
            detects a specific signal, so an empty list is a real result rather
            than a gap.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ul className={cn("space-y-2.5", className)}>
      {recommendations.map((recommendation) => (
        <RecommendationCard
          key={recommendation.id}
          recommendation={recommendation}
          checked={addressed?.has(recommendation.id) ?? false}
          {...(onToggle ? { onToggle: () => onToggle(recommendation.id) } : {})}
        />
      ))}
    </ul>
  );
}

function RecommendationCard({
  recommendation,
  checked,
  onToggle,
}: {
  recommendation: Recommendation;
  checked: boolean;
  onToggle?: () => void;
}) {
  const Icon = CATEGORY_ICON[recommendation.category] ?? Layers;
  const priority = PRIORITY_PRESENTATION[recommendation.priority];

  const files = recommendation.targets?.files ?? [];
  const modules = recommendation.targets?.modules ?? [];

  return (
    <li
      className={cn(
        "rounded-lg border border-border bg-card p-4 transition-opacity",
        checked && "opacity-60",
      )}
    >
      <div className="flex gap-3">
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            className="mt-0.5 shrink-0 rounded-full text-muted-foreground transition-colors hover:text-foreground"
            aria-pressed={checked}
            aria-label={
              checked
                ? `Mark "${recommendation.title}" as not addressed`
                : `Mark "${recommendation.title}" as addressed`
            }
          >
            {checked ? (
              <CheckCircle2 className="size-5 text-risk-low" />
            ) : (
              <Circle className="size-5" />
            )}
          </button>
        )}

        <div className="min-w-0 flex-1 space-y-2.5">
          {/* --- header ---------------------------------------------------- */}
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h4
              className={cn(
                "flex items-baseline gap-2 text-sm font-semibold leading-snug",
                checked && "line-through",
              )}
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              {recommendation.title}
            </h4>

            <div className="flex shrink-0 items-center gap-1.5">
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[0.6875rem] font-semibold",
                  priority.className,
                )}
              >
                {priority.label}
              </span>
            </div>
          </div>

          {/* --- what to do ------------------------------------------------ */}
          <p className="text-sm leading-relaxed text-muted-foreground">
            {recommendation.description}
          </p>

          {/* --- why it matters -------------------------------------------- */}
          {recommendation.rationale && (
            <p className="border-l-2 border-border pl-3 text-xs italic leading-relaxed text-muted-foreground/80">
              {recommendation.rationale}
            </p>
          )}

          {/* --- targets --------------------------------------------------- */}
          {(files.length > 0 || modules.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {modules.slice(0, 5).map((module) => (
                <code
                  key={module}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground"
                >
                  {module}
                </code>
              ))}
              {files.slice(0, 4).map((file) => (
                <code
                  key={file}
                  title={file}
                  className="max-w-[18rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground"
                >
                  {truncatePath(file, 44)}
                </code>
              ))}
              {files.length > 4 && (
                <span className="text-[0.6875rem] text-muted-foreground">
                  +{files.length - 4} more
                </span>
              )}
            </div>
          )}

          {/* --- provenance ------------------------------------------------ */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[0.6875rem] text-muted-foreground/70">
            <span>{RECOMMENDATION_CATEGORY_LABEL[recommendation.category]}</span>
            <span>·</span>
            <span>{EFFORT_LABEL[recommendation.effort]}</span>

            {recommendation.triggeredByFactorKeys.length > 0 && (
              <>
                <span>·</span>
                {/* The audit trail from "why is this risky" to "what should I do". */}
                <span
                  title={`Triggered by: ${recommendation.triggeredByFactorKeys.join(", ")}`}
                  className="font-mono"
                >
                  triggered by {recommendation.triggeredByFactorKeys.slice(0, 2).join(", ")}
                  {recommendation.triggeredByFactorKeys.length > 2 &&
                    ` +${recommendation.triggeredByFactorKeys.length - 2}`}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/** Priority rollup, for the merge-readiness summary. */
export function RecommendationSummary({
  recommendations,
  className,
}: {
  recommendations: Array<{ priority: string }>;
  className?: string;
}) {
  if (recommendations.length === 0) return null;

  const counts = recommendations.reduce<Record<string, number>>((acc, item) => {
    acc[item.priority] = (acc[item.priority] ?? 0) + 1;
    return acc;
  }, {});

  const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {order.map((priority) => {
        const count = counts[priority];
        if (!count) return null;
        return (
          <Badge
            key={priority}
            variant="outline"
            className={cn("font-medium", PRIORITY_PRESENTATION[priority].className)}
          >
            {count} {PRIORITY_PRESENTATION[priority].label.toLowerCase()}
          </Badge>
        );
      })}
    </div>
  );
}
