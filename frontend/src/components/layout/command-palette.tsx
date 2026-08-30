"use client";

/**
 * Command palette — global search.
 *
 * Hand-rolled on a Radix Dialog rather than pulling in a palette library, because
 * the requirements are specific: results are grouped by kind, each carries a risk
 * badge, and quick actions sit alongside them. Wiring those into a generic
 * component is more work than the ~200 lines of keyboard handling below.
 *
 * Details that make it feel right:
 *
 *  - **Debounced.** Keystrokes do not each become a request.
 *  - **Full keyboard control.** Up/down move, Enter opens, Escape closes, and the
 *    active item scrolls itself into view.
 *  - **Recents when empty.** A palette that shows nothing until you type wastes
 *    the most common interaction, which is going back to something.
 *  - **Previous results stay visible while the next load.** No flash of empty on
 *    every keystroke.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowRight,
  CornerDownLeft,
  FolderGit2,
  GitPullRequest,
  Lightbulb,
  Loader2,
  Search,
  ShieldAlert,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { RiskBadge } from "@/components/risk/risk-badge";
import { useSearch } from "@/hooks/use-api";
import { useUiStore } from "@/stores/ui.store";
import { cn } from "@/lib/utils";
import type { RiskLevel, SearchCategory, SearchResultItem } from "@/types/api";

const CATEGORY_ICON: Record<SearchCategory, LucideIcon> = {
  repositories: FolderGit2,
  pullRequests: GitPullRequest,
  analyses: ShieldAlert,
  riskFactors: Sparkles,
  recommendations: Lightbulb,
};

/** Static destinations, always available. */
const QUICK_ACTIONS: Array<{ label: string; href: string; icon: LucideIcon; keywords: string }> = [
  { label: "Dashboard", href: "/dashboard", icon: Activity, keywords: "home overview" },
  { label: "Connect a repository", href: "/repositories/connect", icon: FolderGit2, keywords: "add new github" },
  { label: "All pull requests", href: "/pulls", icon: GitPullRequest, keywords: "prs open" },
  { label: "Analysis history", href: "/analyses", icon: ShieldAlert, keywords: "past results" },
  { label: "Deployment timeline", href: "/timeline", icon: Activity, keywords: "deploys incidents" },
  { label: "Teams", href: "/teams", icon: Users, keywords: "members" },
];

export function CommandPalette() {
  const router = useRouter();
  const open = useUiStore((state) => state.commandPaletteOpen);
  const setOpen = useUiStore((state) => state.setCommandPaletteOpen);

  const [rawQuery, setRawQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);

  const listRef = React.useRef<HTMLDivElement>(null);

  // ---- debounce ----------------------------------------------------------
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(rawQuery.trim()), 180);
    return () => clearTimeout(timer);
  }, [rawQuery]);

  // Reset when reopened, so the palette never opens showing a stale query.
  React.useEffect(() => {
    if (open) {
      setRawQuery("");
      setDebounced("");
      setActiveIndex(0);
    }
  }, [open]);

  const { data: results, isFetching } = useSearch(debounced, open);

  // ---- flatten for keyboard navigation ----------------------------------
  const matchedActions = React.useMemo(() => {
    const needle = rawQuery.trim().toLowerCase();
    if (needle.length === 0) return QUICK_ACTIONS.slice(0, 4);
    return QUICK_ACTIONS.filter(
      (action) =>
        action.label.toLowerCase().includes(needle) ||
        action.keywords.includes(needle),
    );
  }, [rawQuery]);

  type Row =
    | { kind: "action"; action: (typeof QUICK_ACTIONS)[number] }
    | { kind: "result"; item: SearchResultItem };

  const rows = React.useMemo<Row[]>(() => {
    const out: Row[] = matchedActions.map((action) => ({ kind: "action", action }));
    for (const group of results?.groups ?? []) {
      for (const item of group.items) out.push({ kind: "result", item });
    }
    return out;
  }, [matchedActions, results]);

  // Clamp the cursor when the result set shrinks under it.
  React.useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const navigate = React.useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      setOpen(false);
      router.push(row.kind === "action" ? row.action.href : row.item.href);
    },
    [router, setOpen],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % Math.max(1, rows.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + rows.length) % Math.max(1, rows.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      navigate(rows[activeIndex]);
    }
  };

  // Keep the active row visible when navigating with the keyboard.
  React.useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  let cursor = 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="top-[12%] max-w-xl translate-y-0 p-0"
        showClose={false}
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">Search BugDNA</DialogTitle>

        {/* --- input ------------------------------------------------------- */}
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          {isFetching ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
          ) : (
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <input
            autoFocus
            value={rawQuery}
            onChange={(event) => setRawQuery(event.target.value)}
            placeholder="Search repositories, pull requests, risk findings…"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            aria-label="Search"
            role="combobox"
            aria-expanded
            aria-controls="command-results"
          />
          <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground">
            esc
          </kbd>
        </div>

        {/* --- results ---------------------------------------------------- */}
        <div
          ref={listRef}
          id="command-results"
          role="listbox"
          className="max-h-[22rem] overflow-y-auto p-2"
        >
          {/* quick actions */}
          {matchedActions.length > 0 && (
            <Group label="Go to">
              {matchedActions.map((action) => {
                const index = cursor++;
                return (
                  <Row
                    key={action.href}
                    index={index}
                    active={index === activeIndex}
                    onSelect={() => navigate({ kind: "action", action })}
                    onHover={() => setActiveIndex(index)}
                    icon={action.icon}
                    title={action.label}
                  />
                );
              })}
            </Group>
          )}

          {/* search results */}
          {(results?.groups ?? []).map((group) => (
            <Group
              key={group.category}
              label={debounced.length >= 2 ? group.label : "Recent"}
            >
              {group.items.map((item) => {
                const index = cursor++;
                const riskLevel = item.meta.riskLevel as RiskLevel | null | undefined;
                const riskScore = item.meta.riskScore as number | null | undefined;

                return (
                  <Row
                    key={`${item.category}-${item.id}`}
                    index={index}
                    active={index === activeIndex}
                    onSelect={() => navigate({ kind: "result", item })}
                    onHover={() => setActiveIndex(index)}
                    icon={CATEGORY_ICON[item.category] ?? Search}
                    title={item.title}
                    subtitle={item.subtitle}
                    trailing={
                      riskLevel ? (
                        <RiskBadge level={riskLevel} score={riskScore ?? null} size="sm" />
                      ) : null
                    }
                  />
                );
              })}
            </Group>
          ))}

          {/* --- empty ---------------------------------------------------- */}
          {debounced.length >= 2 &&
            !isFetching &&
            (results?.totalMatches ?? 0) === 0 &&
            matchedActions.length === 0 && (
              <div className="px-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  Nothing matched <span className="font-medium">{debounced}</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground/70">
                  Search covers connected repositories, their pull requests,
                  analyses, risk findings and recommendations.
                </p>
              </div>
            )}

          {debounced.length > 0 && debounced.length < 2 && (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              Keep typing — at least two characters.
            </p>
          )}
        </div>

        {/* --- footer ----------------------------------------------------- */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-[0.6875rem] text-muted-foreground">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-muted px-1 font-mono">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-muted px-1 font-mono">
                <CornerDownLeft className="size-2.5" />
              </kbd>
              open
            </span>
          </span>
          {results?.truncated && <span>showing top matches</span>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 last:mb-0">
      <p className="px-2 py-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground/60">
        {label}
      </p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({
  index,
  active,
  onSelect,
  onHover,
  icon: Icon,
  title,
  subtitle,
  trailing,
}: {
  index: number;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
  icon: LucideIcon;
  title: string;
  subtitle?: string | null;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-index={index}
      role="option"
      aria-selected={active}
      onClick={onSelect}
      onMouseMove={onHover}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/50",
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        {subtitle && (
          <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
        )}
      </span>

      {trailing}

      {active && (
        <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </button>
  );
}
