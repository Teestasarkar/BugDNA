"use client";

/**
 * Risk badge and score display.
 *
 * The most-repeated element in the product, so it has to answer the question at a
 * glance and survive being placed in a dense table row.
 *
 * Two decisions worth noting:
 *
 *  - **The number and the level travel together.** A bare "82" means nothing
 *    without knowing the scale, and a bare "CRITICAL" hides how far past the
 *    threshold it is. Showing both costs a few pixels and removes the ambiguity.
 *  - **A stale score is labelled, not hidden.** When the pull request has new
 *    commits since the analysis, the badge says so. Silently showing a score for
 *    a commit that no longer exists would be worse than showing nothing.
 */
import { AlertTriangle, FlaskConical, History, Minus } from "lucide-react";
import { RISK_PRESENTATION } from "@/lib/risk";
import { InfoTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { RiskLevel } from "@/types/api";

export interface RiskBadgeProps {
  level: RiskLevel | null | undefined;
  score?: number | null;
  size?: "sm" | "default" | "lg";
  /** Hide the numeric score, showing only the level. */
  hideScore?: boolean;
  /** Marks the score as belonging to an older commit. */
  stale?: boolean;
  /** The score came from the heuristic fallback rather than the trained model. */
  heuristic?: boolean;
  /** Some input was incomplete — the analysis says so. */
  degraded?: boolean;
  className?: string;
}

const SIZES = {
  sm: { wrap: "h-5 gap-1 px-1.5 text-[0.6875rem]", score: "text-[0.6875rem]", icon: "size-3" },
  default: { wrap: "h-6 gap-1.5 px-2 text-xs", score: "text-xs", icon: "size-3.5" },
  lg: { wrap: "h-8 gap-2 px-2.5 text-sm", score: "text-sm", icon: "size-4" },
} as const;

export function RiskBadge({
  level,
  score,
  size = "default",
  hideScore = false,
  stale = false,
  heuristic = false,
  degraded = false,
  className,
}: RiskBadgeProps) {
  const sizing = SIZES[size];

  // No level means no completed analysis. Say that, rather than rendering an
  // empty badge the user has to interpret.
  if (!level) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-md border border-dashed border-border",
          "font-medium text-muted-foreground",
          sizing.wrap,
          className,
        )}
      >
        <Minus className={sizing.icon} aria-hidden />
        Not analysed
      </span>
    );
  }

  const presentation = RISK_PRESENTATION[level];

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border font-semibold",
        presentation.className,
        stale && "opacity-70",
        sizing.wrap,
        className,
      )}
      // The visual encoding is colour; this makes it legible without it.
      title={`${presentation.label}${score !== null && score !== undefined ? ` — ${Math.round(score)} out of 100` : ""}`}
    >
      {!hideScore && score !== null && score !== undefined && (
        <span className={cn("tabular font-bold", sizing.score)}>{Math.round(score)}</span>
      )}

      <span className="font-medium">{level}</span>

      {stale && (
        <InfoTooltip label="This score is for an earlier commit. The pull request has changed since — re-analyse for a current assessment.">
          <History className={cn(sizing.icon, "opacity-80")} aria-label="Outdated score" />
        </InfoTooltip>
      )}

      {heuristic && (
        <InfoTooltip label="Scored by the transparent rule-based fallback, not the trained model — no model artifact was loaded.">
          <FlaskConical className={cn(sizing.icon, "opacity-80")} aria-label="Heuristic score" />
        </InfoTooltip>
      )}

      {degraded && !heuristic && (
        <InfoTooltip label="Some inputs were incomplete for this analysis. Open it to see what was missing.">
          <AlertTriangle className={cn(sizing.icon, "opacity-80")} aria-label="Degraded analysis" />
        </InfoTooltip>
      )}
    </span>
  );
}

/**
 * Large score readout, for the top of an analysis page.
 *
 * Deliberately not a circular gauge at this size — a big number with the band
 * beneath it is read faster, and a dial invites a false impression of precision
 * the model does not have.
 */
export function RiskScoreDisplay({
  score,
  level,
  className,
}: {
  score: number | null | undefined;
  level: RiskLevel | null | undefined;
  className?: string;
}) {
  const presentation = level ? RISK_PRESENTATION[level] : null;

  return (
    <div className={cn("flex items-baseline gap-2", className)}>
      <span
        className={cn(
          "tabular text-5xl font-bold leading-none tracking-tight",
          presentation?.textClass ?? "text-muted-foreground",
        )}
      >
        {score === null || score === undefined ? "—" : Math.round(score)}
      </span>
      <span className="text-lg font-medium text-muted-foreground">/ 100</span>
    </div>
  );
}

/**
 * Horizontal score meter with the four bands marked.
 *
 * The band boundaries are drawn on the track, so a score of 58 visibly sits just
 * below the HIGH threshold rather than floating without context. That framing is
 * the point — it is what turns a number into a judgement the reader can check.
 */
export function RiskMeter({
  score,
  level,
  showBands = true,
  className,
}: {
  score: number | null | undefined;
  level: RiskLevel | null | undefined;
  showBands?: boolean;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, score ?? 0));
  const presentation = level ? RISK_PRESENTATION[level] : null;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div
        className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Risk score ${Math.round(clamped)} out of 100`}
      >
        {/* Band boundaries at 35, 60 and 80. */}
        {showBands &&
          [35, 60, 80].map((boundary) => (
            <span
              key={boundary}
              className="absolute top-0 h-full w-px bg-background/70"
              style={{ left: `${boundary}%` }}
              aria-hidden
            />
          ))}

        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-700 ease-out",
            presentation?.bgClass ?? "bg-muted-foreground",
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>

      {showBands && (
        <div className="flex justify-between text-[0.625rem] text-muted-foreground/70">
          <span>0</span>
          <span className="translate-x-1/3">35</span>
          <span>60</span>
          <span className="-translate-x-1/3">80</span>
          <span>100</span>
        </div>
      )}
    </div>
  );
}
