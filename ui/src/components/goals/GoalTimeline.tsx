import { useMemo } from "react";
import type { Goal } from "../../pages/GoalsPage";

type Props = {
  goals: Goal[];
  onSelect: (goal: Goal) => void;
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

const LEVEL_LABELS: Record<string, string> = {
  objective:    "OBJECTIVES",
  key_result:   "KEY RESULTS",
  milestone:    "MILESTONES",
  task:         "TASKS",
  daily_action: "DAILY ACTIONS",
};

const LEVEL_INDENT: Record<string, number> = {
  objective:    0,
  key_result:   1,
  milestone:    2,
  task:         3,
  daily_action: 4,
};

const LEVEL_DOT_COLORS: Record<string, string> = {
  objective:    "var(--violet)",
  key_result:   "var(--blue)",
  milestone:    "var(--emerald)",
  task:         "var(--amber)",
  daily_action: "var(--cyan)",
};

type HealthColors = { bg: string; fill: string; dot: string };

const HEALTH_COLORS: Record<string, HealthColors> = {
  on_track: {
    bg:   "rgba(52,211,153,0.10)",
    fill: "rgba(52,211,153,0.65)",
    dot:  "var(--emerald)",
  },
  at_risk: {
    bg:   "rgba(251,191,36,0.10)",
    fill: "rgba(251,191,36,0.55)",
    dot:  "var(--amber)",
  },
  behind: {
    bg:   "rgba(249,115,22,0.10)",
    fill: "rgba(249,115,22,0.55)",
    dot:  "var(--orange)",
  },
  critical: {
    bg:   "rgba(251,113,133,0.10)",
    fill: "rgba(251,113,133,0.55)",
    dot:  "var(--rose)",
  },
};

const FALLBACK_HEALTH: HealthColors = {
  bg:   "rgba(255,255,255,0.06)",
  fill: "rgba(255,255,255,0.30)",
  dot:  "var(--text-3)",
};

const MONTHS = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function isDead(goal: Goal): boolean {
  return goal.status === "killed" || goal.status === "failed";
}

function isPulsing(health: string): boolean {
  return health === "at_risk" || health === "critical";
}

/**
 * Build the ordered list of goals grouped by level.
 * Within each level group goals are sorted by sort_order.
 */
function buildLevelGroups(goals: Goal[]): Map<string, Goal[]> {
  const groups = new Map<string, Goal[]>();
  for (const level of LEVEL_ORDER) {
    const bucket = goals
      .filter((g) => g.level === level)
      .sort((a, b) => a.sort_order - b.sort_order);
    if (bucket.length > 0) {
      groups.set(level, bucket);
    }
  }
  return groups;
}

/** Generate month column data for the header. */
function buildMonthColumns(
  minTime: number,
  maxTime: number,
  totalDuration: number,
  nowMs: number,
) {
  const columns: {
    label: string;
    isCurrent: boolean;
    weeks: { label: string; isCurrent: boolean }[];
    flexGrow: number;
  }[] = [];

  const cursor = new Date(minTime);
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);

  const nowDate = new Date(nowMs);
  const nowMonth = nowDate.getMonth();
  const nowYear = nowDate.getFullYear();

  // Get ISO week number
  function isoWeek(d: Date): number {
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    return Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }

  while (cursor.getTime() < maxTime) {
    const monthStart = cursor.getTime();
    const nextMonth = new Date(cursor);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const monthEnd = Math.min(nextMonth.getTime(), maxTime);

    const monthDuration = monthEnd - monthStart;
    const flexGrow = monthDuration / totalDuration;

    const isCurrent =
      cursor.getMonth() === nowMonth && cursor.getFullYear() === nowYear;

    // Build week sub-labels for this month
    const weeks: { label: string; isCurrent: boolean }[] = [];
    const weekCursor = new Date(monthStart);
    // Align to Monday
    const day = weekCursor.getDay();
    const offsetToMonday = day === 0 ? -6 : 1 - day;
    weekCursor.setDate(weekCursor.getDate() + offsetToMonday);

    while (weekCursor.getTime() < monthEnd) {
      const wn = isoWeek(weekCursor);
      const nowWeek = isoWeek(nowDate);
      const isCurrentWeek =
        wn === nowWeek && weekCursor.getFullYear() === nowDate.getFullYear();
      weeks.push({ label: `w${wn}`, isCurrent: isCurrentWeek });
      weekCursor.setDate(weekCursor.getDate() + 7);
    }

    columns.push({
      label: `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`,
      isCurrent,
      weeks,
      flexGrow,
    });

    cursor.setMonth(cursor.getMonth() + 1);
  }

  return columns;
}

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

export function GoalTimeline({ goals, onSelect }: Props) {
  const nowMs = Date.now();

  // Build level-grouped structure
  const levelGroups = useMemo(() => buildLevelGroups(goals), [goals]);

  // Time range computation
  const { minTime, maxTime, totalDuration } = useMemo(() => {
    if (goals.length === 0) {
      const now = nowMs;
      return {
        minTime: now - 14 * 86400000,
        maxTime: now + 60 * 86400000,
        totalDuration: 74 * 86400000,
      };
    }

    const starts = goals.map((g) => g.started_at ?? g.created_at);
    const ends = goals.map(
      (g) => g.deadline ?? g.completed_at ?? nowMs + 30 * 86400000,
    );

    // Pad by ~1 week on each side
    const rawMin = Math.min(...starts, nowMs - 7 * 86400000);
    const rawMax = Math.max(...ends, nowMs + 14 * 86400000);

    // Snap minTime to the 1st of its month
    const snapMin = new Date(rawMin);
    snapMin.setDate(1);
    snapMin.setHours(0, 0, 0, 0);

    // Snap maxTime to end of its month
    const snapMax = new Date(rawMax);
    snapMax.setMonth(snapMax.getMonth() + 1);
    snapMax.setDate(0);
    snapMax.setHours(23, 59, 59, 999);

    const mn = snapMin.getTime();
    const mx = snapMax.getTime();
    return { minTime: mn, maxTime: mx, totalDuration: mx - mn };
  }, [goals, nowMs]);

  const toPercent = (t: number) =>
    Math.max(0, Math.min(100, ((t - minTime) / totalDuration) * 100));

  const nowPercent = toPercent(nowMs);

  // Month header columns
  const monthColumns = useMemo(
    () => buildMonthColumns(minTime, maxTime, totalDuration, nowMs),
    [minTime, maxTime, totalDuration, nowMs],
  );

  // Empty state
  if (goals.length === 0) {
    return (
      <div className="goals-tl-wrap">
        <div className="goals-tl-empty">
          No goals to display. Create your first goal to see the timeline.
        </div>
      </div>
    );
  }

  return (
    <div className="goals-tl-wrap">
      {/* ================================================================
          ROW 1: Fixed header — label spacer (left) + month/week header (right)
          Both columns are in a single flex row so they align precisely.
          ================================================================ */}
      <div className="goals-tl-header-row">
        {/* Left spacer aligned with the label column width */}
        <div className="goals-tl-header-spacer">GOAL TREE</div>

        {/* Right: month + week two-row header */}
        <div className="goals-tl-month-header">
          {monthColumns.map((col, i) => (
            <div
              key={i}
              className={[
                "goals-tl-month-col",
                col.isCurrent ? "goals-tl-month-col--current" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ flex: col.flexGrow }}
            >
              <div
                className={[
                  "goals-tl-month-name",
                  col.isCurrent ? "goals-tl-month-name--current" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {col.label}
              </div>
              {col.weeks.length > 0 && (
                <div className="goals-tl-month-weeks">
                  {col.weeks.map((w, wi) => (
                    <span
                      key={wi}
                      className={[
                        "goals-tl-week-label",
                        w.isCurrent ? "goals-tl-week-label--current" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      {w.isCurrent ? `${w.label}▾` : w.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ================================================================
          ROW 2: Scrollable body — label column (left) + gantt chart (right)
          Both sides are siblings inside one scrollable container, so
          vertical scrolling keeps them perfectly synchronized and the
          content fills the full remaining height.
          ================================================================ */}
      <div className="goals-tl-body">
        {/* ---- LEFT: Label column ---- */}
        <div className="goals-tl-labels">
          {LEVEL_ORDER.map((level) => {
            const group = levelGroups.get(level);
            if (!group) return null;

            const dotColor = LEVEL_DOT_COLORS[level];
            const indent = LEVEL_INDENT[level];

            return (
              <div key={level}>
                {/* Group header */}
                <div className="goals-tl-group-header">
                  <div
                    className="goals-tl-group-dot"
                    style={{ background: dotColor }}
                  />
                  {LEVEL_LABELS[level]}
                </div>

                {/* Goal rows */}
                {group.map((goal) => {
                  const dead = isDead(goal);
                  const hc = HEALTH_COLORS[goal.health] ?? FALLBACK_HEALTH;

                  return (
                    <div
                      key={goal.id}
                      role="button"
                      tabIndex={0}
                      className={[
                        "goals-tl-label-row",
                        `goals-tl-indent-${indent}`,
                        `goals-tl-label-${level}`,
                        dead ? "goals-tl-label-row--dead" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => onSelect(goal)}
                      onKeyDown={(e) => e.key === "Enter" && onSelect(goal)}
                      aria-label={`Select goal: ${goal.title}`}
                    >
                      <div
                        className="goals-tl-label-dot"
                        style={{ background: hc.dot }}
                      />
                      <span
                        className={[
                          "goals-tl-label-text",
                          dead ? "goals-tl-label-text--dead" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        {goal.title}
                      </span>
                      <span className="goals-tl-label-score">
                        {goal.score.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* ---- RIGHT: Gantt chart ---- */}
        <div className="goals-tl-chart">
          {/* Today line — positioned relative to the chart area.
              The label sits at top:4px (well below the fixed header row
              above, so it cannot overlap the "Mar 2026" month text). */}
          <div
            className="goals-today-line"
            style={{ left: `${nowPercent}%` }}
            aria-hidden="true"
          >
            <div className="goals-today-label">TODAY</div>
          </div>

          {/* Gantt rows, grouped by level */}
          {LEVEL_ORDER.map((level) => {
            const group = levelGroups.get(level);
            if (!group) return null;

            return (
              <div key={level}>
                {/* Spacer matching the group header in the label column */}
                <div className="goals-gantt-group-header" />

                {group.map((goal) => {
                  const dead = isDead(goal);
                  const hc = HEALTH_COLORS[goal.health] ?? FALLBACK_HEALTH;

                  // Always show a bar: fall back to created_at → now if no
                  // started_at / deadline so goals without dates are visible.
                  const startMs = goal.started_at ?? goal.created_at;
                  const endMs =
                    goal.deadline ??
                    goal.completed_at ??
                    nowMs + 14 * 86400000;

                  const leftPct = toPercent(startMs);
                  const rightPct = toPercent(endMs);
                  // Minimum bar width of 1.5% so very short spans are still visible
                  const widthPct = Math.max(1.5, rightPct - leftPct);

                  // Score progress fill width relative to track
                  const fillWidthPct = Math.max(
                    0,
                    Math.min(100, goal.score * 100),
                  );

                  // Deadline label: position just past the right edge of the bar
                  const deadlineLabelLeft = leftPct + widthPct + 0.5;

                  // Format deadline date
                  const deadlineLabel = goal.deadline
                    ? formatDate(goal.deadline)
                    : null;

                  const pulsing = isPulsing(goal.health);

                  return (
                    <div
                      key={goal.id}
                      role="button"
                      tabIndex={0}
                      className={[
                        "goals-gantt-row",
                        dead ? "goals-gantt-row--dead" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => onSelect(goal)}
                      onKeyDown={(e) => e.key === "Enter" && onSelect(goal)}
                      aria-label={`Goal: ${goal.title}, score ${goal.score.toFixed(2)}`}
                    >
                      {/* Bar track */}
                      <div
                        className="goals-gantt-bar-track"
                        style={{
                          left: `${leftPct}%`,
                          width: `${widthPct}%`,
                          background: hc.bg,
                        }}
                      >
                        {/* Progress fill */}
                        <div
                          className="goals-gantt-bar-fill"
                          style={{
                            width: `${fillWidthPct}%`,
                            background: hc.fill,
                          }}
                        />
                        {/* Health dot */}
                        <div
                          className={[
                            "goals-gantt-bar-health",
                            pulsing ? "goals-gantt-bar-health--pulse" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          style={{ background: hc.dot }}
                        />
                      </div>

                      {/* Deadline label */}
                      {deadlineLabel && !dead && (
                        <span
                          className="goals-gantt-deadline-label"
                          style={{ left: `${deadlineLabelLeft}%` }}
                        >
                          {deadlineLabel}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------
// Utility
// ----------------------------------------------------------------

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
