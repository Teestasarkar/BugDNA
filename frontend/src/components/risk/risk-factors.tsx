"use client";

/**
 * Risk factors — the explainability view.
 *
 * This is the component the whole product exists to render. It takes the model's
 * SHAP output and answers, for a developer about to merge: *why does it think
 * that?*
 *
 * Design decisions, each of them load-bearing:
 *
 *  1. **Both directions are shown.** Factors that reduced the score are listed
 *     alongside those that raised it. A view that lists only problems makes a
 *     LOW score feel arbitrary; showing that tests were included and the author
 *     knows the module is what makes the assessment credible.
 *
 *  2. **Bars are centred on zero.** SHAP values are signed, so a diverging bar
 *     is the honest encoding: length is magnitude, side is direction. A pair of
 *     same-direction bars would hide the sign, which is the most important part.
 *
 *  3. **Evidence is one click away.** Each factor carries the files that made it
 *     fire, so "dependency manifest changed" becomes "package-lock.json,
 *     package.json" without leaving the page.
 *
 *  4. **The raw SHAP value is available but not prominent.** A developer who
 *     wants to check the arithmetic can; nobody is forced to read log-odds to
 *     use the product.
 */
import * as React from "react";
import { ChevronDown, FileCode2, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InfoTooltip } from "@/components/ui/tooltip";
import { FACTOR_CATEGORY_HINT, FACTOR_CATEGORY_LABEL } from "@/lib/risk";
import { truncatePath } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RiskFactor } from "@/types/api";

export function RiskFactorList({
  factors,
  /** Collapse to the strongest few, with a control to reveal the rest. */
  initialVisible = 6,
  className,
}: {
  factors: RiskFactor[];
  initialVisible?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = React.useState(false);

  if (factors.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No individual factor moved the score enough to report. Contributions below
        1.5% of the total are treated as noise and omitted.
      </p>
    );
  }

  // The largest absolute contribution sets the bar scale, so the strongest factor
  // fills its half and everything else is proportional to it.
  const maxContribution = Math.max(...factors.map((f) => f.contribution), 1);

  const visible = expanded ? factors : factors.slice(0, initialVisible);
  const hidden = factors.length - visible.length;

  return (
    <div className={cn("space-y-1", className)}>
      {visible.map((factor) => (
        <FactorRow key={factor.id ?? factor.key} factor={factor} scale={maxContribution} />
      ))}

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={cn(
            "mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed",
            "border-border py-2 text-xs font-medium text-muted-foreground",
            "transition-colors hover:bg-muted hover:text-foreground",
          )}
        >
          <ChevronDown className="size-3.5" />
          Show {hidden} more factor{hidden === 1 ? "" : "s"}
        </button>
      )}

      {expanded && factors.length > initialVisible && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-2 w-full py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Show less
        </button>
      )}
    </div>
  );
}

function FactorRow({ factor, scale }: { factor: RiskFactor; scale: number }) {
  const [open, setOpen] = React.useState(false);

  const increases = factor.direction === "INCREASES_RISK";
  const neutral = factor.direction === "NEUTRAL";

  const width = Math.max(2, (factor.contribution / scale) * 100);

  const evidenceFiles = factor.evidence?.files ?? [];
  const evidenceNote = factor.evidence?.note;
  const hasDetail = Boolean(factor.description || evidenceFiles.length > 0 || evidenceNote);

  const Icon = neutral ? Minus : increases ? TrendingUp : TrendingDown;
  const accent = neutral
    ? "text-muted-foreground"
    : increases
      ? "text-risk-high"
      : "text-risk-low";

  return (
    <div
      className={cn(
        "rounded-lg border border-transparent transition-colors",
        hasDetail && "hover:border-border hover:bg-muted/30",
        open && "border-border bg-muted/30",
      )}
    >
      <button
        type="button"
        onClick={() => hasDetail && setOpen((value) => !value)}
        disabled={!hasDetail}
        className={cn(
          "flex w-full items-center gap-3 px-2.5 py-2 text-left",
          hasDetail ? "cursor-pointer" : "cursor-default",
        )}
        aria-expanded={hasDetail ? open : undefined}
      >
        {/* --- diverging bar, centred on zero ------------------------------ */}
        <div className="hidden w-32 shrink-0 sm:block" aria-hidden>
          <div className="relative flex h-5 items-center">
            <span className="absolute left-1/2 h-full w-px -translate-x-1/2 bg-border" />

            <div className="flex w-full items-center">
              {/* Reducing risk: grows leftward from centre. */}
              <div className="flex w-1/2 justify-end">
                {!increases && !neutral && (
                  <span
                    className="h-2 rounded-l-sm bg-risk-low"
                    style={{ width: `${width}%` }}
                  />
                )}
              </div>
              {/* Increasing risk: grows rightward from centre. */}
              <div className="w-1/2">
                {increases && (
                  <span
                    className="block h-2 rounded-r-sm bg-risk-high"
                    style={{ width: `${width}%` }}
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* --- label and value --------------------------------------------- */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium leading-snug">{factor.label}</span>

            {factor.displayValue && (
              <span className="font-mono text-xs text-muted-foreground">
                {factor.displayValue}
              </span>
            )}
          </div>

          <div className="mt-0.5 flex items-center gap-2">
            <InfoTooltip label={FACTOR_CATEGORY_HINT[factor.category]}>
              <span className="text-[0.6875rem] text-muted-foreground/80">
                {FACTOR_CATEGORY_LABEL[factor.category]}
              </span>
            </InfoTooltip>
          </div>
        </div>

        {/* --- contribution share ----------------------------------------- */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Icon className={cn("size-3.5", accent)} aria-hidden />
          <span className={cn("tabular text-sm font-semibold", accent)}>
            {factor.contribution.toFixed(1)}%
          </span>
        </div>

        {hasDetail && (
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
            aria-hidden
          />
        )}
      </button>

      {/* --- expanded detail --------------------------------------------- */}
      {open && hasDetail && (
        <div className="space-y-3 border-t border-border/60 px-2.5 py-3">
          {factor.description && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {factor.description}
            </p>
          )}

          {evidenceNote && (
            <p className="text-xs leading-relaxed text-muted-foreground">{evidenceNote}</p>
          )}

          {evidenceFiles.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground/70">
                Evidence
              </p>
              <ul className="space-y-1">
                {evidenceFiles.map((file) => (
                  <li key={file} className="flex items-center gap-1.5">
                    <FileCode2 className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
                    <code
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={file}
                    >
                      {truncatePath(file, 60)}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* The raw number, for anyone who wants to check the arithmetic. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-[0.6875rem] text-muted-foreground/70">
            <span className="font-mono">key: {factor.key}</span>
            <span className="font-mono" title="SHAP value in the model's log-odds space">
              shap: {factor.shapValue >= 0 ? "+" : ""}
              {factor.shapValue.toFixed(4)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Compact factor chips, for list rows and cards.
 *
 * Shows only what raised the score — in a one-line summary the reducing factors
 * are noise, and the full picture is one click away on the analysis page.
 */
export function RiskFactorChips({
  factors,
  limit = 3,
  className,
}: {
  factors: Array<{ key: string; label: string; contribution: number }>;
  limit?: number;
  className?: string;
}) {
  if (factors.length === 0) return null;

  const visible = factors.slice(0, limit);
  const hidden = factors.length - visible.length;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {visible.map((factor) => (
        <Badge key={factor.key} variant="muted" className="font-normal">
          {factor.label}
          <span className="tabular opacity-70">{factor.contribution.toFixed(0)}%</span>
        </Badge>
      ))}
      {hidden > 0 && (
        <span className="text-xs text-muted-foreground">+{hidden} more</span>
      )}
    </div>
  );
}

/**
 * Category rollup.
 *
 * Groups contributions by category, which answers a different question from the
 * factor list: not "which signal mattered most" but "what *kind* of risk is
 * this?" A change can be 60% blast radius or 60% data layer, and those call for
 * different reviewers.
 */
export function RiskCategoryBreakdown({
  factors,
  className,
}: {
  factors: RiskFactor[];
  className?: string;
}) {
  const byCategory = React.useMemo(() => {
    const totals = new Map<string, number>();

    for (const factor of factors) {
      if (factor.direction !== "INCREASES_RISK") continue;
      totals.set(
        factor.category,
        (totals.get(factor.category) ?? 0) + factor.contribution,
      );
    }

    return [...totals.entries()]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total);
  }, [factors]);

  if (byCategory.length === 0) return null;

  const grandTotal = byCategory.reduce((sum, entry) => sum + entry.total, 0) || 1;

  return (
    <div className={cn("space-y-2", className)}>
      {byCategory.map(({ category, total }) => (
        <div key={category} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium">
              {FACTOR_CATEGORY_LABEL[category as keyof typeof FACTOR_CATEGORY_LABEL] ?? category}
            </span>
            <span className="tabular text-xs text-muted-foreground">
              {total.toFixed(0)}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-risk-high/70"
              style={{ width: `${(total / grandTotal) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
