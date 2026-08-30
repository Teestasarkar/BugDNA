/**
 * Formatting helpers.
 *
 * Small, boring and centralised: dates and numbers appear in dozens of places,
 * and inconsistent formatting is one of the fastest ways to make an interface
 * feel unfinished.
 */
import { format, formatDistanceToNowStrict, isValid, parseISO } from "date-fns";

/** Parse an API date string, tolerating null. */
function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = typeof value === "string" ? parseISO(value) : value;
  return isValid(date) ? date : null;
}

/** "3 hours ago". Falls back to an em dash rather than "Invalid Date". */
export function relativeTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  return `${formatDistanceToNowStrict(date)} ago`;
}

/** Compact relative time for dense tables: "3h", "2d". */
export function shortRelativeTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d`;
  return `${Math.floor(seconds / 2592000)}mo`;
}

export function absoluteTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  return date ? format(date, "d MMM yyyy, HH:mm") : "—";
}

export function dateOnly(value: string | Date | null | undefined): string {
  const date = toDate(value);
  return date ? format(date, "d MMM yyyy") : "—";
}

/** Axis label for daily buckets. */
export function chartDate(value: string): string {
  const date = toDate(value);
  return date ? format(date, "d MMM") : value;
}

/** Milliseconds as a short human duration. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Thousands separators, and an em dash for nothing. */
export function number(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US");
}

/** Abbreviated counts for stat tiles: 1.2k, 3.4M. */
export function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (Math.abs(value) < 1000) return String(Math.round(value));
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
    .format(value);
}

export function percent(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(decimals)}%`;
}

/** A score rendered for display: one decimal only when it carries information. */
export function score(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return String(Math.round(value));
}

/** Signed delta, for comparisons: "+12", "-5", "no change". */
export function delta(value: number | null | undefined, unit = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return "no change";
  return `${rounded > 0 ? "+" : ""}${rounded}${unit}`;
}

/** Short commit SHA. */
export function sha(value: string | null | undefined, length = 7): string {
  if (!value) return "—";
  return value.slice(0, length);
}

/** Just the filename from a path. */
export function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/** The directory part of a path, without the filename. */
export function dirname(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

/**
 * Middle-truncate a long path, keeping both ends readable.
 *
 * `src/modules/analysis/features/extract.ts` -> `src/…/features/extract.ts`
 */
export function truncatePath(path: string, maxLength = 48): string {
  if (path.length <= maxLength) return path;
  const parts = path.split("/");
  if (parts.length <= 2) return `…${path.slice(-(maxLength - 1))}`;

  const file = parts[parts.length - 1] ?? "";
  const dir = parts[parts.length - 2] ?? "";
  const head = parts[0] ?? "";
  const tail = dir ? `${dir}/${file}` : file;

  return `${head}/…/${tail}`;
}

/** "+120 −45" for a diff stat. */
export function diffStat(additions: number, deletions: number): string {
  return `+${number(additions)} −${number(deletions)}`;
}

/** Pluralise a count with its noun. */
export function pluralise(count: number, singular: string, plural?: string): string {
  return `${number(count)} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** Sentence-case an ENUM_LIKE_VALUE. */
export function humaniseEnum(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Bytes as KB/MB. */
export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** GitHub rate-limit warning text, or null when there is nothing to say. */
export function rateLimitWarning(
  remaining: number | null,
  resetAt: string | null,
): string | null {
  if (remaining === null || remaining > 200) return null;
  const reset = resetAt ? relativeTime(resetAt).replace(" ago", "") : "shortly";
  return `${number(remaining)} GitHub API requests remaining. The limit resets in ${reset}.`;
}
