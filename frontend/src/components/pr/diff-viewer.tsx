"use client";

/**
 * Diff viewer.
 *
 * Not a general-purpose code review tool — GitHub already is one. This exists to
 * answer a narrower question: *which of these files is the risk engine reacting
 * to, and why?*
 *
 * So each file carries the classification the feature extractor derived from it —
 * test, migration, dependency manifest, public API — because that classification
 * is literally what fed the score. A reviewer who disagrees with the assessment
 * can see the labels the model was given and judge whether they were right, which
 * is the difference between an explainable tool and an oracle.
 *
 * Other decisions:
 *
 *  - **Generated files are collapsed by default.** A 900-line lockfile diff
 *    buries the twelve lines that matter, and the extractor already discounts it.
 *  - **Files are sorted by churn, not alphabetically.** The biggest change is
 *    almost always the one worth reading first.
 *  - **A truncated patch says so.** Silently showing a partial hunk would let a
 *    reviewer conclude they had seen the whole change.
 */
import * as React from "react";
import {
  Beaker,
  Boxes,
  ChevronRight,
  Database,
  ExternalLink,
  FileCode2,
  FileText,
  Layers,
  Scissors,
  Server,
  Settings,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InfoTooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/states";
import { useUiStore } from "@/stores/ui.store";
import { diffStat, number as fmtNumber, truncatePath } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ChangedFile } from "@/types/api";

// ---------------------------------------------------------------------------
// Classification badges
// ---------------------------------------------------------------------------
// Order matters: the first match wins, so the most risk-relevant label is the one
// shown. A migration that is also YAML should read as a migration.

const CLASSIFICATIONS: Array<{
  key: keyof ChangedFile;
  label: string;
  hint: string;
  icon: typeof Beaker;
  className: string;
}> = [
  {
    key: "isMigration",
    label: "migration",
    hint: "A schema migration. Among the hardest changes to roll back, because the data has already moved.",
    icon: Database,
    className: "risk-critical",
  },
  {
    key: "isDependencyManifest",
    label: "dependency",
    hint: "A package manifest or lockfile. Upgrades pull in third-party code nobody on this pull request has read.",
    icon: Boxes,
    className: "risk-moderate",
  },
  {
    key: "isTest",
    label: "test",
    hint: "A test file. Changing behaviour and its tests together is the strongest protective signal there is.",
    icon: Beaker,
    className: "risk-low",
  },
  {
    key: "isInfra",
    label: "infra",
    hint: "Build or deployment configuration. A mistake here breaks the deploy itself, which also blocks the fix.",
    icon: Server,
    className: "risk-moderate",
  },
  {
    key: "isConfig",
    label: "config",
    hint: "Configuration. Takes effect the moment it deploys and is rarely covered by tests.",
    icon: Settings,
    className: "risk-moderate",
  },
  {
    key: "isDocs",
    label: "docs",
    hint: "Documentation. Carries effectively no deployment risk.",
    icon: FileText,
    className: "bg-muted text-muted-foreground border-border",
  },
  {
    key: "isGenerated",
    label: "generated",
    hint: "Build output or generated code. Inflates the apparent size of a change without adding reviewable logic.",
    icon: Sparkles,
    className: "bg-muted text-muted-foreground border-border",
  },
];

function classificationsFor(file: ChangedFile) {
  return CLASSIFICATIONS.filter((entry) => Boolean(file[entry.key]));
}

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  ADDED: { label: "added", className: "text-diff-add-text" },
  REMOVED: { label: "deleted", className: "text-diff-del-text" },
  RENAMED: { label: "renamed", className: "text-muted-foreground" },
  COPIED: { label: "copied", className: "text-muted-foreground" },
  MODIFIED: { label: "modified", className: "text-muted-foreground" },
  CHANGED: { label: "changed", className: "text-muted-foreground" },
  UNCHANGED: { label: "unchanged", className: "text-muted-foreground" },
};

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

export function DiffViewer({
  files,
  totals,
  modules,
  className,
}: {
  files: ChangedFile[];
  totals?: { files: number; additions: number; deletions: number; truncatedPatches: number };
  modules?: Array<{ module: string; churn: number; files: number }>;
  className?: string;
}) {
  const hideGenerated = useUiStore((state) => state.hideGeneratedFiles);
  const setHideGenerated = useUiStore((state) => state.setHideGeneratedFiles);

  const [openFiles, setOpenFiles] = React.useState<Set<string>>(() => {
    // Open the largest interesting file by default, so the view is not a wall of
    // collapsed rows — but never a generated one.
    const first = files.find((file) => !file.isGenerated && file.patch);
    return new Set(first ? [first.id] : []);
  });

  const visible = React.useMemo(
    () => (hideGenerated ? files.filter((file) => !file.isGenerated) : files),
    [files, hideGenerated],
  );

  const generatedCount = files.length - files.filter((file) => !file.isGenerated).length;

  if (files.length === 0) {
    return (
      <EmptyState
        icon={FileCode2}
        title="No changed files available"
        description="The diff has not been retrieved yet, or GitHub returned no file details for this pull request."
        compact
      />
    );
  }

  const toggle = (id: string) =>
    setOpenFiles((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={cn("space-y-3", className)}>
      {/* --- summary bar -------------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            <span className="font-medium text-foreground">
              {fmtNumber(totals?.files ?? files.length)}
            </span>{" "}
            files
          </span>
          <span className="font-mono">
            <span className="text-diff-add-text">
              +{fmtNumber(totals?.additions ?? 0)}
            </span>{" "}
            <span className="text-diff-del-text">
              −{fmtNumber(totals?.deletions ?? 0)}
            </span>
          </span>
          {modules && modules.length > 0 && (
            <span>
              <span className="font-medium text-foreground">{modules.length}</span> modules
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {generatedCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHideGenerated(!hideGenerated)}
              className="text-xs"
            >
              {hideGenerated
                ? `Show ${generatedCount} generated file${generatedCount === 1 ? "" : "s"}`
                : "Hide generated files"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setOpenFiles(
                openFiles.size > 0 ? new Set() : new Set(visible.map((file) => file.id)),
              )
            }
            className="text-xs"
          >
            {openFiles.size > 0 ? "Collapse all" : "Expand all"}
          </Button>
        </div>
      </div>

      {/* --- truncation notice ------------------------------------------- */}
      {totals && totals.truncatedPatches > 0 && (
        <p className="flex items-start gap-1.5 rounded-md border border-risk-moderate-border bg-risk-moderate-bg px-3 py-2 text-xs text-risk-moderate">
          <Scissors className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {totals.truncatedPatches} patch
          {totals.truncatedPatches === 1 ? " was" : "es were"} truncated because of size.
          Content-based signals for {totals.truncatedPatches === 1 ? "it" : "them"} were
          computed from the portion shown.
        </p>
      )}

      {/* --- blast radius ------------------------------------------------- */}
      {modules && modules.length > 1 && <ModuleBreakdown modules={modules} />}

      {/* --- files -------------------------------------------------------- */}
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {visible.map((file) => (
          <FileRow
            key={file.id}
            file={file}
            open={openFiles.has(file.id)}
            onToggle={() => toggle(file.id)}
          />
        ))}
      </ul>
    </div>
  );
}

function ModuleBreakdown({
  modules,
}: {
  modules: Array<{ module: string; churn: number; files: number }>;
}) {
  const total = modules.reduce((sum, entry) => sum + entry.churn, 0) || 1;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface/50 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Layers className="size-3.5 text-muted-foreground" aria-hidden />
        Blast radius
        <InfoTooltip label="Modules this change touches, by share of churn. A change spread thinly across many modules is harder to review and harder to revert cleanly than a concentrated one.">
          <span className="text-muted-foreground/60">(?)</span>
        </InfoTooltip>
      </p>

      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        {modules.slice(0, 8).map((entry, index) => (
          <span
            key={entry.module}
            className="h-full"
            style={{
              width: `${(entry.churn / total) * 100}%`,
              backgroundColor: `var(--chart-${(index % 5) + 1})`,
            }}
            title={`${entry.module}: ${entry.churn} lines across ${entry.files} files`}
          />
        ))}
      </div>

      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {modules.slice(0, 6).map((entry, index) => (
          <li key={entry.module} className="flex items-center gap-1.5 text-[0.6875rem]">
            <span
              className="size-2 rounded-sm"
              style={{ backgroundColor: `var(--chart-${(index % 5) + 1})` }}
              aria-hidden
            />
            <code className="font-mono text-muted-foreground">{entry.module}</code>
            <span className="tabular text-muted-foreground/70">{entry.churn}</span>
          </li>
        ))}
        {modules.length > 6 && (
          <li className="text-[0.6875rem] text-muted-foreground/70">
            +{modules.length - 6} more
          </li>
        )}
      </ul>
    </div>
  );
}

function FileRow({
  file,
  open,
  onToggle,
}: {
  file: ChangedFile;
  open: boolean;
  onToggle: () => void;
}) {
  const classifications = classificationsFor(file);
  const status = STATUS_STYLE[file.status] ?? STATUS_STYLE.MODIFIED;
  const hasPatch = Boolean(file.patch);

  return (
    <li className={cn("bg-card", open && "bg-surface/40")}>
      <button
        type="button"
        onClick={onToggle}
        disabled={!hasPatch}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors",
          hasPatch ? "hover:bg-muted/40" : "cursor-default",
        )}
        aria-expanded={hasPatch ? open : undefined}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            !hasPatch && "opacity-0",
          )}
          aria-hidden
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <code
              className="truncate font-mono text-xs font-medium"
              title={file.filename}
            >
              {truncatePath(file.filename, 64)}
            </code>
            {file.touchesPublicApi && (
              <InfoTooltip label="This change touches an exported symbol or route handler. Callers outside this pull request may depend on the old shape.">
                <Badge variant="outline" className="shrink-0 border-risk-high-border text-risk-high">
                  public API
                </Badge>
              </InfoTooltip>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("text-[0.6875rem]", status?.className)}>{status?.label}</span>

            {file.previousFilename && (
              <span
                className="text-[0.6875rem] text-muted-foreground/70"
                title={`from ${file.previousFilename}`}
              >
                from {truncatePath(file.previousFilename, 32)}
              </span>
            )}

            {file.module && (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.625rem] text-muted-foreground">
                {file.module}
              </code>
            )}

            {classifications.map((entry) => (
              <InfoTooltip key={entry.label} label={entry.hint}>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded border px-1 py-0.5 text-[0.625rem] font-medium",
                    entry.className,
                  )}
                >
                  <entry.icon className="size-2.5" aria-hidden />
                  {entry.label}
                </span>
              </InfoTooltip>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="tabular font-mono text-[0.6875rem]">
            <span className="text-diff-add-text">+{file.additions}</span>{" "}
            <span className="text-diff-del-text">−{file.deletions}</span>
          </span>

          {file.blobUrl && (
            <a
              href={file.blobUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label={`View ${file.filename} on GitHub`}
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </button>

      {open && file.patch && <PatchBody patch={file.patch} truncated={file.patchTruncated} />}
    </li>
  );
}

/**
 * Renders a unified diff hunk.
 *
 * Line-based rather than token-based: this is a risk tool, and per-token syntax
 * highlighting would mean shipping a parser for every language BugDNA classifies
 * for a marginal readability gain. Added/removed/context colouring is what a
 * reviewer actually scans for.
 */
function PatchBody({ patch, truncated }: { patch: string; truncated: boolean }) {
  const lines = React.useMemo(() => patch.split("\n"), [patch]);

  return (
    <div className="border-t border-border">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[0.6875rem] leading-relaxed">
          <tbody>
            {lines.map((line, index) => {
              const kind = line.startsWith("+")
                ? "add"
                : line.startsWith("-")
                  ? "del"
                  : line.startsWith("@@")
                    ? "meta"
                    : line.startsWith("…")
                      ? "notice"
                      : "context";

              return (
                <tr
                  key={index}
                  className={cn(
                    kind === "add" && "bg-diff-add-bg",
                    kind === "del" && "bg-diff-del-bg",
                    kind === "meta" && "bg-muted/60",
                    kind === "notice" && "bg-risk-moderate-bg",
                  )}
                >
                  {/* Gutter: the marker, not a line number. GitHub's hunk headers
                      give ranges, and reconstructing exact numbers from a possibly
                      truncated patch would risk showing wrong ones. */}
                  <td
                    className={cn(
                      "w-6 select-none border-r border-border/50 px-1.5 text-center align-top",
                      kind === "add" && "bg-diff-add-gutter text-diff-add-text",
                      kind === "del" && "bg-diff-del-gutter text-diff-del-text",
                      kind !== "add" && kind !== "del" && "text-muted-foreground/40",
                    )}
                    aria-hidden
                  >
                    {kind === "add" ? "+" : kind === "del" ? "−" : ""}
                  </td>

                  <td
                    className={cn(
                      "whitespace-pre px-2.5 align-top",
                      kind === "add" && "text-diff-add-text",
                      kind === "del" && "text-diff-del-text",
                      kind === "meta" && "font-medium text-diff-meta",
                      kind === "notice" && "font-medium text-risk-moderate",
                      kind === "context" && "text-muted-foreground",
                    )}
                  >
                    {/* Drop the leading marker; the gutter carries it. */}
                    {kind === "add" || kind === "del" ? line.slice(1) : line}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {truncated && (
        <p className="flex items-center gap-1.5 border-t border-border bg-risk-moderate-bg px-3 py-1.5 text-[0.6875rem] text-risk-moderate">
          <Scissors className="size-3" aria-hidden />
          This patch was truncated. Open the file on GitHub for the full diff.
        </p>
      )}
    </div>
  );
}

/** Condensed file list, for the analysis sidebar. */
export function ChangedFileSummary({
  files,
  limit = 8,
  className,
}: {
  files: ChangedFile[];
  limit?: number;
  className?: string;
}) {
  const visible = files.slice(0, limit);

  return (
    <ul className={cn("space-y-1.5", className)}>
      {visible.map((file) => {
        const classifications = classificationsFor(file);
        return (
          <li key={file.id} className="flex items-baseline gap-2 text-xs">
            <code
              className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
              title={file.filename}
            >
              {truncatePath(file.filename, 40)}
            </code>
            {classifications[0] && (
              <span
                className={cn(
                  "shrink-0 rounded border px-1 text-[0.625rem]",
                  classifications[0].className,
                )}
              >
                {classifications[0].label}
              </span>
            )}
            <span className="tabular shrink-0 font-mono text-[0.6875rem] text-muted-foreground/70">
              {diffStat(file.additions, file.deletions)}
            </span>
          </li>
        );
      })}
      {files.length > limit && (
        <li className="text-xs text-muted-foreground/70">
          and {files.length - limit} more
        </li>
      )}
    </ul>
  );
}
