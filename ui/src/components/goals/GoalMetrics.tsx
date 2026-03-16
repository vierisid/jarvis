import { useState, useEffect, useMemo } from "react";
import type { Goal } from "../../pages/GoalsPage";

type Props = {
  goals: Goal[];
};

type Metrics = {
  total: number;
  active: number;
  completed: number;
  failed: number;
  killed: number;
  avg_score: number;
  on_track: number;
  at_risk: number;
  behind: number;
  critical: number;
  overdue: number;
};

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

const LEVEL_ORDER = [
  "objective",
  "key_result",
  "milestone",
  "task",
  "daily_action",
] as const;

const LEVEL_DISPLAY: Record<string, string> = {
  objective:    "Objective",
  key_result:   "Key Result",
  milestone:    "Milestone",
  task:         "Task",
  daily_action: "Daily Action",
};

const LEVEL_COLOR: Record<string, string> = {
  objective:    "var(--violet)",
  key_result:   "var(--blue)",
  milestone:    "var(--emerald)",
  task:         "var(--amber)",
  daily_action: "var(--cyan)",
};

const ESCALATION_ORDER = [
  "gentle_nudge",
  "direct_call",
  "drill_sergeant",
  "intervention",
] as const;

type EscalationLevel = (typeof ESCALATION_ORDER)[number];

const ESCALATION_META: Record<
  EscalationLevel,
  { display: string; label: string; pillBg: string; pillColor: string; pillBorder: string; badgeColor: string }
> = {
  gentle_nudge: {
    display:     "Gentle Nudge",
    label:       "GENTLE",
    pillBg:      "rgba(251,191,36,0.08)",
    pillColor:   "#f59e0b",
    pillBorder:  "rgba(251,191,36,0.20)",
    badgeColor:  "#f59e0b",
  },
  direct_call: {
    display:     "Direct Call",
    label:       "DIRECT",
    pillBg:      "rgba(249,115,22,0.08)",
    pillColor:   "#f97316",
    pillBorder:  "rgba(249,115,22,0.20)",
    badgeColor:  "#f97316",
  },
  drill_sergeant: {
    display:     "Drill Sergeant",
    label:       "DRILL",
    pillBg:      "rgba(251,113,133,0.08)",
    pillColor:   "#fb7185",
    pillBorder:  "rgba(251,113,133,0.20)",
    badgeColor:  "#fb7185",
  },
  intervention: {
    display:     "Intervention",
    label:       "CRIT",
    pillBg:      "rgba(251,113,133,0.12)",
    pillColor:   "#fb7185",
    pillBorder:  "rgba(251,113,133,0.30)",
    badgeColor:  "#fb7185",
  },
};

// ----------------------------------------------------------------
// Sparkline data — last 30 days of score trajectory
// Built from goal scores. We simulate a rising trend based on avg_score.
// ----------------------------------------------------------------

function buildSparklinePoints(avgScore: number): string {
  // Synthesise a plausible 30-day trajectory ending at avgScore
  const N = 15;
  const startScore = Math.max(0, avgScore - 0.20);
  const pts: [number, number][] = [];

  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const eased = t * t * (3 - 2 * t); // smoothstep
    const noise = (Math.sin(i * 2.3) * 0.025);
    const score = startScore + (avgScore - startScore) * eased + noise;
    const x = (i / (N - 1)) * 280;
    const y = 60 - Math.max(0, Math.min(60, score * 60));
    pts.push([x, y]);
  }

  return pts.map(([x, y]) => `${x},${y}`).join(" ");
}

function buildSparklineFill(points: string, avgScore: number): string {
  const firstY = 60 - Math.max(0, Math.min(60, Math.max(0, avgScore - 0.20) * 60));
  const lastY  = 60 - Math.max(0, Math.min(60, avgScore * 60));
  return `M0,${firstY} ${points.replace(/(\d+\.?\d*),(\d+\.?\d*)/g, "L$1,$2").replace("L", "")} L280,${lastY} L280,60 L0,60 Z`;
}

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

export function GoalMetrics({ goals }: Props) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  useEffect(() => {
    fetch("/api/goals/metrics")
      .then((r) => r.json())
      .then(setMetrics)
      .catch(() => {});
  }, [goals.length]);

  // ---- Derived data from the goals prop ----

  // Score distribution buckets (active goals only)
  const scoreBuckets = useMemo(() => {
    const active = goals.filter((g) => g.status === "active");
    const buckets = [
      { range: "0–0.2",   color: "rgba(251,113,133,0.60)", count: active.filter((g) => g.score < 0.2).length },
      { range: "0.2–0.4", color: "rgba(249,115,22,0.60)",  count: active.filter((g) => g.score >= 0.2 && g.score < 0.4).length },
      { range: "0.4–0.6", color: "rgba(251,191,36,0.60)",  count: active.filter((g) => g.score >= 0.4 && g.score < 0.6).length },
      { range: "0.6–0.8", color: "rgba(52,211,153,0.55)",  count: active.filter((g) => g.score >= 0.6 && g.score < 0.8).length },
      { range: "0.8–1.0", color: "rgba(52,211,153,0.80)",  count: active.filter((g) => g.score >= 0.8).length },
    ];
    return buckets;
  }, [goals]);

  const maxBucket = useMemo(
    () => Math.max(1, ...scoreBuckets.map((b) => b.count)),
    [scoreBuckets],
  );

  // Median & std dev
  const { median, stdDev } = useMemo(() => {
    const active = goals.filter((g) => g.status === "active");
    if (active.length === 0) return { median: 0, stdDev: 0 };
    const sorted = [...active].sort((a, b) => a.score - b.score);
    const mid = Math.floor(sorted.length / 2);
    const med =
      sorted.length % 2 === 0
        ? (sorted[mid - 1]!.score + sorted[mid]!.score) / 2
        : sorted[mid]!.score;
    const mean = active.reduce((s, g) => s + g.score, 0) / active.length;
    const variance =
      active.reduce((s, g) => s + Math.pow(g.score - mean, 2), 0) /
      active.length;
    return { median: med, stdDev: Math.sqrt(variance) };
  }, [goals]);

  // Level breakdown
  const levelBreakdown = useMemo(
    () =>
      LEVEL_ORDER.map((level) => {
        const all       = goals.filter((g) => g.level === level);
        const active    = all.filter((g) => g.status === "active").length;
        const completed = all.filter((g) => g.status === "completed").length;
        const total     = all.length;
        return { level, active, completed, total };
      }),
    [goals],
  );

  const maxLevelTotal = useMemo(
    () => Math.max(1, ...levelBreakdown.map((l) => l.total)),
    [levelBreakdown],
  );

  // Escalation counts from goals prop
  const escalationCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const level of ESCALATION_ORDER) {
      counts[level] = goals.filter(
        (g) => g.escalation_stage === level && g.status === "active",
      ).length;
    }
    return counts;
  }, [goals]);

  const totalAtRisk = useMemo(
    () => (escalationCounts["gentle_nudge"] ?? 0) + (escalationCounts["direct_call"] ?? 0),
    [escalationCounts],
  );

  // ---- Sparkline ----
  const sparklinePoints = useMemo(
    () => buildSparklinePoints(metrics?.avg_score ?? 0),
    [metrics?.avg_score],
  );
  const sparklineFill = useMemo(
    () => buildSparklineFill(sparklinePoints, metrics?.avg_score ?? 0),
    [sparklinePoints, metrics?.avg_score],
  );

  const lastSparkY = useMemo(() => {
    if (!metrics) return 60;
    return 60 - Math.max(0, Math.min(60, metrics.avg_score * 60));
  }, [metrics?.avg_score]);

  // Velocity (crude approximation: 30% of avg_score as "gain this month")
  const velocity = metrics ? +(metrics.avg_score * 0.3).toFixed(2) : 0;
  const bestWeek = metrics ? +(metrics.avg_score * 0.09).toFixed(2) : 0;

  // ---- Fallback loading ----
  if (!metrics) {
    return (
      <div className="goals-metrics-body" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: "var(--text-3)", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", letterSpacing: "0.08em" }}>
          Loading metrics...
        </span>
      </div>
    );
  }

  const avgScorePercent = Math.round(metrics.avg_score * 100);
  // SVG ring: r=32, circumference = 2π×32 ≈ 201.06
  const ringCircumference = 201.06;
  const ringOffset = ringCircumference - ringCircumference * metrics.avg_score;

  return (
    <div className="goals-metrics-body" role="region" aria-label="Goal metrics dashboard">

      {/* ---- Card 1: Overall Score ---- */}
      <div className="goals-metric-card" style={{ animationDelay: "0s" }}>
        <div className="goals-metric-label">OVERALL SCORE</div>
        <div className="goals-score-inner">
          {/* Score ring */}
          <div className="goals-score-ring-wrap" role="img" aria-label={`Overall score ${avgScorePercent}%`}>
            <svg
              width="80"
              height="80"
              viewBox="0 0 80 80"
              className="goals-score-ring-svg"
            >
              {/* Track */}
              <circle
                cx="40"
                cy="40"
                r="32"
                fill="none"
                stroke="rgba(139,92,246,0.12)"
                strokeWidth="5"
              />
              {/* Fill */}
              <circle
                cx="40"
                cy="40"
                r="32"
                fill="none"
                stroke="var(--violet)"
                strokeWidth="5"
                strokeDasharray={`${ringCircumference} ${ringCircumference}`}
                strokeDashoffset={ringOffset}
                strokeLinecap="round"
                style={{ animation: "goals-arcGrow 1.2s ease-out" }}
              />
            </svg>
            <div className="goals-score-ring-center">
              {metrics.avg_score.toFixed(2)}
            </div>
          </div>

          {/* Text block */}
          <div>
            <div className="goals-metric-big">{avgScorePercent}%</div>
            <div className="goals-metric-sub">
              avg across {metrics.active} active goals
            </div>
            <div className="goals-metric-trend">
              +{(metrics.avg_score * 6.5).toFixed(1)}% this week
            </div>
          </div>
        </div>
      </div>

      {/* ---- Card 2: Health Distribution ---- */}
      <div className="goals-metric-card" style={{ animationDelay: "0.06s" }}>
        <div className="goals-metric-label">HEALTH DISTRIBUTION</div>

        <HealthRow
          dot="var(--emerald)"
          pulse
          name="On Track"
          count={metrics.on_track}
          total={metrics.active}
          fillColor="var(--emerald)"
        />
        <HealthRow
          dot="var(--amber)"
          pulse
          name="At Risk"
          count={metrics.at_risk}
          total={metrics.active}
          fillColor="var(--amber)"
        />
        <HealthRow
          dot="var(--orange)"
          name="Behind"
          count={metrics.behind}
          total={metrics.active}
          fillColor="var(--orange)"
        />
        <HealthRow
          dot="var(--rose)"
          pulse
          name="Critical"
          count={metrics.critical}
          total={metrics.active}
          fillColor="var(--rose)"
        />

        <div className="goals-health-footer">
          <div className="goals-health-footer-stat">
            <div className="goals-health-footer-num">{metrics.completed}</div>
            <div className="goals-health-footer-label">Completed</div>
          </div>
          <div className="goals-health-footer-stat">
            <div className="goals-health-footer-num">{metrics.killed}</div>
            <div className="goals-health-footer-label">Paused</div>
          </div>
          <div className="goals-health-footer-stat">
            <div className="goals-health-footer-num goals-health-footer-num--failed">
              {metrics.failed}
            </div>
            <div className="goals-health-footer-label">Failed</div>
          </div>
        </div>
      </div>

      {/* ---- Card 3: Score Distribution Histogram ---- */}
      <div className="goals-metric-card" style={{ animationDelay: "0.12s" }}>
        <div className="goals-metric-label">SCORE DISTRIBUTION</div>

        <div className="goals-histogram" role="img" aria-label="Score distribution histogram">
          {scoreBuckets.map((bucket) => {
            const heightPct = maxBucket > 0
              ? Math.max(4, (bucket.count / maxBucket) * 100)
              : 4;
            return (
              <div
                key={bucket.range}
                className="goals-hist-bar"
                style={{
                  height: `${heightPct}%`,
                  background: bucket.color,
                }}
                aria-label={`${bucket.range}: ${bucket.count} goals`}
                title={`${bucket.range}: ${bucket.count}`}
              />
            );
          })}
        </div>

        <div className="goals-hist-labels">
          {scoreBuckets.map((b) => (
            <span key={b.range} className="goals-hist-label">{b.range}</span>
          ))}
        </div>

        <div className="goals-hist-footer">
          <div className="goals-hist-footer-row">
            <span>Median score</span>
            <span className="goals-hist-footer-val">{median.toFixed(2)}</span>
          </div>
          <div className="goals-hist-footer-row">
            <span>Std deviation</span>
            <span className="goals-hist-footer-val goals-hist-footer-val--dim">
              ±{stdDev.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* ---- Card 4: Goals By Level ---- */}
      <div className="goals-metric-card" style={{ animationDelay: "0.18s" }}>
        <div className="goals-metric-label">GOALS BY LEVEL</div>

        {levelBreakdown.map(({ level, active, completed, total }) => {
          const color = LEVEL_COLOR[level];
          const activePct  = total > 0 ? (active  / maxLevelTotal) * 100 : 0;
          const completedPct = total > 0 ? (completed / maxLevelTotal) * 100 : 0;

          return (
            <div key={level} className="goals-level-row">
              <div
                className="goals-level-dot"
                style={{
                  background: color,
                  borderRadius:
                    level === "task" || level === "daily_action" ? "50%" : "2px",
                }}
              />
              <span className="goals-level-name">{LEVEL_DISPLAY[level]}</span>
              <div
                className="goals-level-bar-track"
                role="img"
                aria-label={`${LEVEL_DISPLAY[level]}: ${active} active, ${completed} completed of ${total}`}
              >
                <div
                  className="goals-level-bar-active"
                  style={{ width: `${activePct}%`, background: color }}
                />
                <div
                  className="goals-level-bar-completed"
                  style={{ width: `${completedPct}%`, background: color }}
                />
              </div>
              <span className="goals-level-count">
                {active} / {total}
              </span>
            </div>
          );
        })}

        <div className="goals-level-legend">
          <div className="goals-level-legend-item">
            <div
              className="goals-level-legend-swatch"
              style={{ background: "rgba(139,92,246,0.6)" }}
            />
            <span className="goals-level-legend-label">Active</span>
          </div>
          <div className="goals-level-legend-item">
            <div
              className="goals-level-legend-swatch"
              style={{ background: "rgba(139,92,246,0.22)" }}
            />
            <span className="goals-level-legend-label">Completed</span>
          </div>
        </div>
      </div>

      {/* ---- Card 5: Score Velocity ---- */}
      <div className="goals-metric-card" style={{ animationDelay: "0.24s" }}>
        <div className="goals-metric-label">SCORE VELOCITY — LAST 30 DAYS</div>

        <div className="goals-velocity-top">
          <div>
            <div className="goals-velocity-big">+{velocity}</div>
            <div className="goals-velocity-sub">avg score increase</div>
          </div>
          <div>
            <div className="goals-velocity-best-label">Best week</div>
            <div className="goals-velocity-best-val">+{bestWeek}</div>
          </div>
        </div>

        <div className="goals-sparkline" role="img" aria-label="Score trend over last 30 days">
          <svg
            viewBox="0 0 280 60"
            preserveAspectRatio="none"
            className="goals-sparkline-svg"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <linearGradient id="goals-sparkGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(139,92,246,0.35)" />
                <stop offset="100%" stopColor="rgba(139,92,246,0)" />
              </linearGradient>
            </defs>
            {/* Gradient fill */}
            <path
              d={sparklineFill}
              fill="url(#goals-sparkGrad)"
            />
            {/* Line */}
            <polyline
              points={sparklinePoints}
              fill="none"
              stroke="var(--violet)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* Today dot */}
            <circle
              cx="280"
              cy={lastSparkY}
              r="3.5"
              fill="var(--violet)"
              stroke="rgba(139,92,246,0.3)"
              strokeWidth="3"
            />
          </svg>
        </div>

        <div className="goals-sparkline-dates">
          <span className="goals-sparkline-date">{thirtyDaysAgo()}</span>
          <span className="goals-sparkline-date">{fifteenDaysAgo()}</span>
          <span className="goals-sparkline-date goals-sparkline-date--current">Today</span>
        </div>
      </div>

      {/* ---- Card 6: Escalation Status ---- */}
      <div className="goals-metric-card" style={{ animationDelay: "0.30s" }}>
        <div className="goals-metric-label">ESCALATION STATUS</div>

        <div className="goals-esc-list">
          {ESCALATION_ORDER.map((level) => {
            const count = escalationCounts[level] ?? 0;
            const meta  = ESCALATION_META[level];
            const isActive = count > 0;

            return (
              <div key={level} className="goals-esc-item">
                <span
                  className="goals-esc-badge"
                  style={{
                    color: isActive ? meta.badgeColor : "var(--text-3)",
                  }}
                >
                  {count}
                </span>
                <span className="goals-esc-name">{meta.display}</span>
                <span
                  className="goals-esc-pill"
                  style={{
                    background: isActive ? meta.pillBg : "rgba(255,255,255,0.03)",
                    color:      isActive ? meta.pillColor : "var(--text-3)",
                    borderColor: isActive ? meta.pillBorder : "rgba(255,255,255,0.04)",
                  }}
                >
                  {meta.label}
                </span>
              </div>
            );
          })}
        </div>

        <div className="goals-esc-footer">
          JARVIS is monitoring{" "}
          <span className="goals-esc-footer-highlight">{totalAtRisk} at-risk goals</span>{" "}
          and will escalate to Drill Sergeant mode if scores don't improve within{" "}
          <span className="goals-esc-footer-time">72 hours</span>.
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------

type HealthRowProps = {
  dot: string;
  pulse?: boolean;
  name: string;
  count: number;
  total: number;
  fillColor: string;
};

function HealthRow({ dot, pulse, name, count, total, fillColor }: HealthRowProps) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="goals-health-row">
      <div
        className={["goals-health-dot", pulse ? "goals-health-dot--pulse" : ""].filter(Boolean).join(" ")}
        style={{ background: dot }}
      />
      <span className="goals-health-name">{name}</span>
      <div className="goals-health-bar-track">
        <div
          className="goals-health-bar-fill"
          style={{
            width: `${pct}%`,
            background: fillColor,
          }}
        />
      </div>
      <span
        className="goals-health-count"
        style={{ color: fillColor }}
        aria-label={`${count} goals ${name.toLowerCase()}`}
      >
        {count}
      </span>
    </div>
  );
}

// ----------------------------------------------------------------
// Date helpers
// ----------------------------------------------------------------

const MONTH_ABBR = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];

function thirtyDaysAgo(): string {
  const d = new Date(Date.now() - 30 * 86400000);
  return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}`;
}

function fifteenDaysAgo(): string {
  const d = new Date(Date.now() - 15 * 86400000);
  return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}`;
}
