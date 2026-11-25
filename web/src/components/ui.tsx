import type { ReactNode } from "react";
import type { Band } from "../lib/api";
import { bandLabel, score } from "../lib/format";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="var(--series-1)" strokeWidth="2" />
      <circle cx="12" cy="12" r="5.5" fill="none" stroke="var(--series-1)" strokeWidth="2" opacity="0.55" />
      <path d="M12 12 L19 6" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="16.5" cy="8.2" r="2" fill="var(--critical)" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BandBadge({ band }: { band: Band }) {
  const icon = band === "HIGH" ? "▲" : band === "MEDIUM" ? "●" : "▼";
  return (
    <span className={`badge ${band.toLowerCase()}`} title={bandLabel[band]}>
      <span className="dot" aria-hidden="true" />
      <span aria-hidden="true" style={{ fontSize: 9 }}>{icon}</span>
      {bandLabel[band]}
    </span>
  );
}

export function OutcomeBadge({ label }: { label: 0 | 1 }) {
  return label ? (
    <span className="badge outcome-bug">
      <span className="dot" aria-hidden="true" />
      Fix traced
    </span>
  ) : (
    <span className="badge outcome-clean">
      <span className="dot" aria-hidden="true" />
      No fix traced
    </span>
  );
}

export function MiniMeter({ value, band }: { value: number; band: Band }) {
  return (
    <div className="mini-meter" role="img" aria-label={`Risk score ${score(value)} of 100`}>
      <span className="v">{score(value)}</span>
      <div className={`meter ${band.toLowerCase()}`}>
        <span style={{ width: `${Math.max(2, value)}%` }} />
      </div>
    </div>
  );
}

export function StatTile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="row muted" role="status">
      <span className="spinner" aria-hidden="true" /> {label}…
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="callout error" role="alert">{message}</div>;
}
