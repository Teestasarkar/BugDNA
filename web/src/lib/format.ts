export const pct = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? "–" : `${(v * 100).toFixed(digits)}%`;

export const num = (v: number | null | undefined, digits = 2) => {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  if (Number.isInteger(v)) return v.toLocaleString();
  return Math.abs(v) >= 10 ? Math.round(v).toLocaleString() : v.toFixed(digits);
};

export const compact = (v: number) =>
  v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "")}K` : v.toLocaleString();

export const date = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "–";

export const bandLabel = { HIGH: "High risk", MEDIUM: "Medium", LOW: "Low" } as const;

export const outcomeLabel = {
  tp: "Flagged, and a later fix traced to it",
  fp: "Flagged, no fix traced",
  fn: "Missed: a later fix traced to it",
  tn: "Not flagged, no fix traced",
} as const;

export function fixLinks(repo: string, fixedBy: string): { label: string; href: string }[] {
  return fixedBy
    .split(/\s+/)
    .filter(Boolean)
    .map((ref) =>
      ref.startsWith("#")
        ? { label: ref, href: `https://github.com/${repo}/pull/${ref.slice(1)}` }
        : { label: ref.slice(0, 7), href: `https://github.com/${repo}/commit/${ref}` },
    );
}

/** Percentile as shown to people: floored, so 99.7 reads "99", never "riskier than 100%". */
export const score = (percentile: number) => Math.min(99, Math.floor(percentile));
