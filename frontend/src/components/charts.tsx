"use client";

/**
 * Charts.
 *
 * Recharts, with a few rules applied consistently:
 *
 *  - **Risk series always use the risk palette.** A CRITICAL segment is the same
 *    colour as a CRITICAL badge, so a chart and a table agree at a glance.
 *  - **Non-risk series never use it.** A trend line is `--chart-1` (violet), so
 *    it cannot be mistaken for a severity.
 *  - **Axes carry units, tooltips carry exact values.** The chart is for the
 *    shape; the tooltip is for the number.
 *  - **Empty is a state, not a blank rectangle.** A chart with no data says so.
 *
 * Colours come from CSS variables so both themes work without a JS theme lookup.
 */
import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { RISK_LEVELS, RISK_PRESENTATION, riskChartColor } from "@/lib/risk";
import { chartDate, number as fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RiskDistribution, RiskLevel, TrendPoint } from "@/types/api";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const AXIS_STYLE = {
  fontSize: 11,
  fill: "var(--muted-foreground)",
} as const;

const GRID_STYLE = {
  stroke: "var(--border)",
  strokeDasharray: "3 3",
} as const;

/** Shared tooltip surface, so every chart's tooltip looks the same. */
function ChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number | string; color?: string; dataKey?: string }>;
  label?: string | number;
  formatter?: (entry: { name?: string; value?: number | string }) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-lg">
      {label !== undefined && (
        <p className="mb-1.5 text-xs font-medium text-popover-foreground">
          {typeof label === "string" && /^\d{4}-\d{2}-\d{2}$/.test(label)
            ? chartDate(label)
            : label}
        </p>
      )}
      <ul className="space-y-0.5">
        {payload
          .filter((entry) => entry.value !== undefined && entry.value !== null)
          .map((entry, index) => (
            <li key={index} className="flex items-center gap-2 text-xs">
              <span
                className="size-2 shrink-0 rounded-sm"
                style={{ backgroundColor: entry.color }}
                aria-hidden
              />
              <span className="text-muted-foreground">{entry.name}</span>
              <span className="tabular ml-auto font-medium text-popover-foreground">
                {formatter ? formatter(entry) : entry.value}
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}

function ChartEmpty({ message, height }: { message: string; height: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-dashed border-border"
      style={{ height }}
    >
      <p className="px-6 text-center text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Risk trend
// ---------------------------------------------------------------------------

/**
 * Average risk score over time.
 *
 * The 60 and 80 thresholds are drawn as reference lines, so a rising average is
 * read against the bands rather than in isolation — the difference between
 * "trending up" and "trending into HIGH".
 */
export function RiskTrendChart({
  data,
  height = 240,
  showThresholds = true,
  className,
}: {
  data: TrendPoint[];
  height?: number;
  showThresholds?: boolean;
  className?: string;
}) {
  const hasData = data.some((point) => point.analyses > 0);

  if (!hasData) {
    return (
      <ChartEmpty
        height={height}
        message="No completed analyses in this window yet. Analyse a pull request and its score will appear here."
      />
    );
  }

  return (
    <div className={className}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="riskTrendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid {...GRID_STYLE} vertical={false} />

          <XAxis
            dataKey="date"
            tickFormatter={chartDate}
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 35, 60, 80, 100]}
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            width={36}
          />

          {showThresholds && (
            <>
              <ReferenceLine
                y={60}
                stroke="var(--risk-high)"
                strokeDasharray="4 4"
                strokeOpacity={0.5}
                label={{
                  value: "HIGH",
                  position: "insideTopLeft",
                  fill: "var(--risk-high)",
                  fontSize: 9,
                }}
              />
              <ReferenceLine
                y={80}
                stroke="var(--risk-critical)"
                strokeDasharray="4 4"
                strokeOpacity={0.5}
                label={{
                  value: "CRITICAL",
                  position: "insideTopLeft",
                  fill: "var(--risk-critical)",
                  fontSize: 9,
                }}
              />
            </>
          )}

          <Tooltip
            content={
              <ChartTooltip
                formatter={(entry) =>
                  entry.value === null || entry.value === undefined
                    ? "no data"
                    : String(Math.round(Number(entry.value)))
                }
              />
            }
          />

          <Area
            type="monotone"
            dataKey="avgRiskScore"
            name="Average risk"
            stroke="var(--chart-1)"
            strokeWidth={2}
            fill="url(#riskTrendFill)"
            // Gaps are meaningful: no analyses that day, not a score of zero.
            connectNulls={false}
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Risk distribution
// ---------------------------------------------------------------------------

/** Stacked daily counts by band. Shows volume and mix together. */
export function RiskVolumeChart({
  data,
  height = 220,
  className,
}: {
  data: TrendPoint[];
  height?: number;
  className?: string;
}) {
  const hasData = data.some((point) => point.analyses > 0);

  if (!hasData) {
    return <ChartEmpty height={height} message="No analyses in this window." />;
  }

  return (
    <div className={className}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
          <CartesianGrid {...GRID_STYLE} vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={chartDate}
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <YAxis
            allowDecimals={false}
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
          <Legend
            iconType="square"
            iconSize={8}
            wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
          />

          {/* Stacked lowest-severity-first, so the eye lands on the worst on top. */}
          {RISK_LEVELS.map((level) => (
            <Bar
              key={level}
              dataKey={level}
              name={level}
              stackId="risk"
              fill={riskChartColor(level)}
              radius={level === "CRITICAL" ? [3, 3, 0, 0] : [0, 0, 0, 0]}
              maxBarSize={28}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Distribution as a single horizontal bar plus a legend.
 *
 * Preferred over a pie chart: proportions are easier to compare along a shared
 * baseline, and it fits in a card header where a pie would not.
 */
export function RiskDistributionBar({
  distribution,
  className,
  showCounts = true,
}: {
  distribution: RiskDistribution;
  className?: string;
  showCounts?: boolean;
}) {
  const total = RISK_LEVELS.reduce((sum, level) => sum + distribution[level], 0);

  if (total === 0) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        No completed analyses yet.
      </p>
    );
  }

  return (
    <div className={cn("space-y-2.5", className)}>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={RISK_LEVELS.map((level) => `${distribution[level]} ${level}`).join(", ")}
      >
        {RISK_LEVELS.map((level) => {
          const count = distribution[level];
          if (count === 0) return null;
          return (
            <span
              key={level}
              className="h-full transition-[width] duration-500"
              style={{
                width: `${(count / total) * 100}%`,
                backgroundColor: riskChartColor(level),
              }}
              title={`${count} ${level}`}
            />
          );
        })}
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {RISK_LEVELS.map((level) => (
          <li key={level} className="flex items-center gap-1.5 text-xs">
            <span
              className="size-2 rounded-sm"
              style={{ backgroundColor: riskChartColor(level) }}
              aria-hidden
            />
            <span className="text-muted-foreground">{level}</span>
            {showCounts && (
              <span className="tabular font-medium">{distribution[level]}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * Repository health dial.
 *
 * A semicircular gauge, and the only dial in the product — health is a composite
 * heuristic with a stated formula, so a dial is honest here in a way it would not
 * be for a model probability. The confidence label is part of the component
 * rather than optional: a score computed from three analyses must not look like
 * one computed from three hundred.
 */
export function HealthGauge({
  score,
  confidence,
  size = 148,
  className,
}: {
  score: number | null;
  confidence: "low" | "medium" | "high";
  size?: number;
  className?: string;
}) {
  const radius = size / 2 - 12;
  const circumference = Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score ?? 0));
  const dash = (clamped / 100) * circumference;

  // Health runs the opposite way to risk: high is good.
  const colour =
    score === null
      ? "var(--muted-foreground)"
      : clamped >= 75
        ? "var(--risk-low)"
        : clamped >= 50
          ? "var(--risk-moderate)"
          : clamped >= 30
            ? "var(--risk-high)"
            : "var(--risk-critical)";

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <svg
        width={size}
        height={size / 2 + 14}
        viewBox={`0 0 ${size} ${size / 2 + 14}`}
        role="img"
        aria-label={
          score === null
            ? "Health score unavailable"
            : `Health score ${Math.round(clamped)} out of 100, ${confidence} confidence`
        }
      >
        {/* track */}
        <path
          d={`M 12 ${size / 2} A ${radius} ${radius} 0 0 1 ${size - 12} ${size / 2}`}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={10}
          strokeLinecap="round"
        />
        {/* value */}
        {score !== null && (
          <path
            d={`M 12 ${size / 2} A ${radius} ${radius} 0 0 1 ${size - 12} ${size / 2}`}
            fill="none"
            stroke={colour}
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
            style={{ transition: "stroke-dasharray 700ms ease-out" }}
          />
        )}
      </svg>

      <div className="-mt-7 flex flex-col items-center">
        <span className="tabular text-3xl font-bold leading-none" style={{ color: colour }}>
          {score === null ? "—" : Math.round(clamped)}
        </span>
        <span className="mt-1 text-[0.6875rem] text-muted-foreground">
          {score === null ? "not enough data" : `${confidence} confidence`}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Score over successive analyses of one pull request.
 *
 * This is the chart that proves the product works: a reviewer sees 82 drop to 47
 * after tests were added. Deliberately a line with visible dots — each point is a
 * discrete analysis of a specific commit, not a continuous measurement.
 */
export function ScoreHistoryChart({
  data,
  height = 180,
  className,
}: {
  data: Array<{ label: string; score: number | null; level: RiskLevel | null }>;
  height?: number;
  className?: string;
}) {
  if (data.length < 2) {
    return (
      <ChartEmpty
        height={height}
        message="Only one analysis so far. Re-analyse after pushing a change and the comparison appears here."
      />
    );
  }

  return (
    <div className={className}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 10, right: 12, left: -20, bottom: 0 }}>
          <CartesianGrid {...GRID_STYLE} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 35, 60, 80, 100]}
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            width={34}
          />
          <ReferenceLine y={60} stroke="var(--risk-high)" strokeDasharray="4 4" strokeOpacity={0.4} />
          <Tooltip content={<ChartTooltip />} />

          <Line
            type="monotone"
            dataKey="score"
            name="Risk score"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={(props: { cx?: number; cy?: number; index?: number }) => {
              const point = data[props.index ?? 0];
              const fill = point?.level
                ? RISK_PRESENTATION[point.level].cssVar
                : "var(--muted-foreground)";
              return (
                <circle
                  key={props.index}
                  cx={props.cx}
                  cy={props.cy}
                  r={4}
                  fill={fill}
                  stroke="var(--background)"
                  strokeWidth={2}
                />
              );
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recurring factors
// ---------------------------------------------------------------------------

/**
 * Horizontal bars of the most frequent risk factors.
 *
 * Horizontal because the labels are prose ("Dependency manifest changed") and
 * would be unreadable rotated on a vertical axis.
 */
export function RecurringFactorsChart({
  factors,
  height,
  className,
}: {
  factors: Array<{ key: string; label: string; frequency: number; occurrences: number }>;
  height?: number;
  className?: string;
}) {
  const chartHeight = height ?? Math.max(120, factors.length * 34 + 20);

  if (factors.length === 0) {
    return (
      <ChartEmpty
        height={chartHeight}
        message="No recurring risk factors yet — that needs a few analyses to establish a pattern."
      />
    );
  }

  return (
    <div className={className}>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          data={factors}
          layout="vertical"
          margin={{ top: 0, right: 40, left: 0, bottom: 0 }}
        >
          <CartesianGrid {...GRID_STYLE} horizontal={false} />
          <XAxis
            type="number"
            domain={[0, 100]}
            unit="%"
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ ...AXIS_STYLE, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={168}
          />
          <Tooltip
            content={
              <ChartTooltip
                formatter={(entry) => `${entry.value}% of analyses`}
              />
            }
            cursor={{ fill: "var(--muted)", opacity: 0.4 }}
          />
          <Bar dataKey="frequency" name="Frequency" radius={[0, 3, 3, 0]} maxBarSize={18}>
            {factors.map((factor) => (
              <Cell
                key={factor.key}
                // Darker for more frequent — the tint carries the ranking too.
                fill={
                  factor.frequency >= 60
                    ? "var(--risk-high)"
                    : factor.frequency >= 30
                      ? "var(--risk-moderate)"
                      : "var(--chart-2)"
                }
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

/** Tiny inline trend, for stat tiles and table rows. */
export function Sparkline({
  data,
  width = 72,
  height = 22,
  className,
}: {
  data: Array<number | null>;
  width?: number;
  height?: number;
  className?: string;
}) {
  const points = data.filter((value): value is number => value !== null);
  if (points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;

  const path = data
    .map((value, index) => {
      if (value === null) return null;
      const x = (index / Math.max(1, data.length - 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" L ");

  const rising = (points[points.length - 1] ?? 0) > (points[0] ?? 0);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
      aria-hidden
    >
      <path
        d={`M ${path}`}
        fill="none"
        // Rising risk is bad, so the direction is coloured.
        stroke={rising ? "var(--risk-high)" : "var(--risk-low)"}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Formats a compact count for use in chart captions. */
export const chartNumber = fmtNumber;
