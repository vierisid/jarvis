import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  ChevronRight,
  Plus,
  RefreshCw,
  Search,
  Target,
  TrendingUp,
  X,
  type LucideIcon,
} from "lucide-react";
import { Chip, Icon } from "../../ui";
import { RoomShell } from "../RoomShell";
import { useRoomActions } from "../useRoomActionBus";
import { useRovingTabs } from "../useRovingTabs";
import {
  GOAL_HEALTHS,
  GOAL_LEVELS,
  GOAL_STATUSES,
  useGoalsData,
  type Goal,
  type GoalHealth,
  type GoalLevel,
  type GoalStatus,
} from "./useGoalsData";
import "./GoalsRoom.css";

type TabId = "constellation" | "timeline" | "metrics";

const TAB_LABEL: Record<TabId, string> = {
  constellation: "Constellation",
  timeline: "Timeline",
  metrics: "Metrics",
};

const TAB_ICON: Record<TabId, LucideIcon> = {
  constellation: Target,
  timeline: Calendar,
  metrics: TrendingUp,
};

const STATUS_TONE: Record<GoalStatus, "ok" | "neutral" | "warn" | "accent"> = {
  draft: "neutral",
  active: "warn",
  paused: "neutral",
  completed: "ok",
  failed: "accent",
  killed: "accent",
};

const HEALTH_TONE: Record<GoalHealth, "ok" | "neutral" | "warn" | "accent"> = {
  on_track: "ok",
  at_risk: "warn",
  behind: "warn",
  critical: "accent",
};

const LEVEL_INDENT_PX = 22;

export type RoomBodyMode = "inline" | "expanded";

export function GoalsRoomBody({ mode }: { mode: RoomBodyMode }) {
  const data = useGoalsData();
  const [activeTab, setActiveTab] = useState<TabId>("constellation");
  const TAB_KEYS = useMemo(() => Object.keys(TAB_LABEL) as TabId[], []);
  const tabsApi = useRovingTabs<TabId>(TAB_KEYS, activeTab, setActiveTab, "v2-goals");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<GoalStatus | "all">("all");
  const [healthFilter, setHealthFilter] = useState<GoalHealth | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const filteredGoals = useMemo(() => {
    let list = data.goals;
    if (statusFilter !== "all") list = list.filter((g) => g.status === statusFilter);
    if (healthFilter !== "all") list = list.filter((g) => g.health === healthFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (g) =>
          g.title.toLowerCase().includes(q) ||
          g.description.toLowerCase().includes(q) ||
          g.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [data.goals, search, statusFilter, healthFilter]);

  const visibleIds = useMemo(() => new Set(filteredGoals.map((g) => g.id)), [filteredGoals]);

  const selectedGoal = useMemo(
    () => (selectedId ? data.goals.find((g) => g.id === selectedId) ?? null : null),
    [data.goals, selectedId],
  );

  // Phase 6.3.5 — voice room actions
  useRoomActions("goals", (action, args) => {
    switch (action) {
      case "switch_tab": {
        const t = String(args.tab);
        if (t === "constellation" || t === "timeline" || t === "metrics") {
          setActiveTab(t);
          return true;
        }
        return false;
      }
      case "search":
        setSearch(typeof args.query === "string" ? args.query : "");
        return true;
      case "set_filter": {
        const field = String(args.field);
        const value = String(args.value);
        if (field === "status") {
          if (value === "all" || (GOAL_STATUSES as readonly string[]).includes(value)) {
            setStatusFilter(value as GoalStatus | "all");
            return true;
          }
        } else if (field === "health") {
          if (value === "all" || (GOAL_HEALTHS as readonly string[]).includes(value)) {
            setHealthFilter(value as GoalHealth | "all");
            return true;
          }
        }
        return false;
      }
      case "select": {
        const name = typeof args.name === "string" ? args.name : "";
        const g = data.findByName(name);
        if (!g) return false;
        setSelectedId(g.id);
        return true;
      }
      case "create_goal": {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) return false;
        const level = (args.level as GoalLevel) ?? "task";
        // The classifier may pass deadline as a relative string; we accept
        // a numeric epoch ms only here (the schedule_event path covers
        // date parsing for calendar — for goals we let the user set the
        // deadline in the dialog if they want a fancy date).
        const deadline = typeof args.deadline === "number" ? args.deadline : undefined;
        (async () => {
          const r = await data.createQuick({ title, level, deadline });
          if (r.ok) {
            setSelectedId(r.goal.id);
            setToast({ text: `Created "${r.goal.title}".`, tone: "ok" });
          } else {
            setToast({ text: r.message, tone: "warn" });
          }
        })();
        return true;
      }
      default:
        return false;
    }
  });

  return (
    <div className={`v2-goals v2-goals--${mode}`}>
      {/* Stats */}
      <div className="v2-goals__stats">
        <StatCard
          label="Active"
          value={data.metrics?.active ?? 0}
          sub={`of ${data.metrics?.total ?? 0} total`}
        />
        <StatCard
          label="Avg score"
          value={
            data.metrics
              ? `${Math.round(data.metrics.avg_score * 100)}%`
              : "—"
          }
          sub="across all goals"
        />
        <StatCard
          label="Overdue"
          value={data.overdue.length}
          sub="active + past deadline"
          tone={data.overdue.length > 0 ? "warn" : "neutral"}
        />
        <StatCard
          label="Critical"
          value={data.metrics?.critical ?? 0}
          sub="health = critical"
          tone={(data.metrics?.critical ?? 0) > 0 ? "accent" : "neutral"}
        />
      </div>

      {/* Tabs */}
      {mode === "expanded" && (
        <div
          className="v2-goals__tabs"
          role="tablist"
          aria-label="Goals view"
          ref={tabsApi.tablistRef}
        >
          {TAB_KEYS.map((t) => (
            <button
              key={t}
              type="button"
              className="v2-goals__tab"
              data-active={activeTab === t}
              {...tabsApi.getTabProps(t)}
            >
              <Icon icon={TAB_ICON[t]} size="sm" />
              <span>{TAB_LABEL[t]}</span>
            </button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="v2-goals__toolbar">
        <div className="v2-goals__search">
          <Icon icon={Search} size="sm" />
          <input
            className="v2-goals__search-input"
            type="text"
            placeholder="Search goals…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search goals"
          />
        </div>
        <FilterPills
          label="Status"
          options={["all", ...GOAL_STATUSES]}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as GoalStatus | "all")}
        />
        {mode === "expanded" && (
          <FilterPills
            label="Health"
            options={["all", ...GOAL_HEALTHS]}
            value={healthFilter}
            onChange={(v) => setHealthFilter(v as GoalHealth | "all")}
          />
        )}
        <button
          type="button"
          className="v2-goals__refresh"
          onClick={data.refresh}
          aria-label="Refresh"
          title="Refresh"
        >
          <Icon icon={RefreshCw} size="sm" />
        </button>
        <button
          type="button"
          className="v2-goals__new-btn"
          onClick={() => setCreateOpen(true)}
        >
          <Icon icon={Plus} size="sm" />
          New
        </button>
      </div>

      {data.error && <div className="v2-goals__error">{data.error}</div>}

      {/* Content */}
      {mode === "inline" && (
        <Constellation
          roots={data.roots.filter((g) => visibleIds.has(g.id))}
          childrenByParent={data.childrenByParent}
          visibleIds={visibleIds}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={data.loading}
        />
      )}
      {mode === "expanded" && activeTab === "constellation" && (
        <ConstellationSky
          roots={data.roots.filter((g) => visibleIds.has(g.id))}
          childrenByParent={data.childrenByParent}
          visibleIds={visibleIds}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={data.loading}
        />
      )}
      {mode === "expanded" && activeTab === "timeline" && (
        <Timeline goals={filteredGoals} selectedId={selectedId} onSelect={setSelectedId} />
      )}
      {mode === "expanded" && activeTab === "metrics" && data.metrics && (
        <Metrics metrics={data.metrics} goals={filteredGoals} />
      )}

      {/* Detail panel — expanded mode only */}
      {mode === "expanded" && selectedGoal && (
        <DetailPanel
          goal={selectedGoal}
          allGoals={data.goals}
          childrenByParent={data.childrenByParent}
          onClose={() => setSelectedId(null)}
          onScore={async (score, reason) => {
            const r = await data.updateScore(selectedGoal.id, score, reason);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
          onStatus={async (status) => {
            const r = await data.updateStatus(selectedGoal.id, status);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
          onHealth={async (health) => {
            const r = await data.updateHealth(selectedGoal.id, health);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
        />
      )}

      {createOpen && (
        <CreateDialog
          onClose={() => setCreateOpen(false)}
          onCreate={async (input) => {
            const r = await data.createQuick(input);
            if (r.ok) {
              setSelectedId(r.goal.id);
              setToast({ text: `Created "${r.goal.title}".`, tone: "ok" });
              return true;
            }
            setToast({ text: r.message, tone: "warn" });
            return false;
          }}
        />
      )}

      {toast && (
        <div role="status" aria-live="polite" className="v2-goals__toast" data-tone={toast.tone}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

export function GoalsRoom() {
  return (
    <RoomShell
      title="Goals"
      subtitle="OKR hierarchy · check-ins · progress"
      breadcrumb={["Goals"]}
    >
      <GoalsRoomBody mode="expanded" />
    </RoomShell>
  );
}

/* ─────────── Subcomponents ─────────── */

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number | string;
  sub: string;
  tone?: "neutral" | "warn" | "accent";
}) {
  return (
    <div className="v2-goals__stat" data-tone={tone ?? "neutral"}>
      <div className="v2-goals__stat-label">{label}</div>
      <div className="v2-goals__stat-value">{value}</div>
      <div className="v2-goals__stat-sub">{sub}</div>
    </div>
  );
}

function FilterPills<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<T>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="v2-goals__filter-row" role="tablist" aria-label={`Filter by ${label}`}>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className="v2-goals__filter-btn"
          data-active={value === opt}
          onClick={() => onChange(opt)}
        >
          {opt.replace(/_/g, " ")}
        </button>
      ))}
    </div>
  );
}

/* ─────────── Constellation tab (OKR tree) ─────────── */

function Constellation({
  roots,
  childrenByParent,
  visibleIds,
  selectedId,
  onSelect,
  loading,
}: {
  roots: Goal[];
  childrenByParent: Map<string, Goal[]>;
  visibleIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  loading: boolean;
}) {
  if (loading && roots.length === 0) {
    return <div className="v2-goals__empty">Loading goals…</div>;
  }
  if (roots.length === 0) {
    return (
      <div className="v2-goals__empty">
        No goals match the current filters. Click <strong>New</strong> to create one.
      </div>
    );
  }
  return (
    <div className="v2-goals__tree">
      <ul className="v2-goals__tree-list" role="tree">
        {roots.map((root) => (
          <TreeNode
            key={root.id}
            goal={root}
            depth={0}
            childrenByParent={childrenByParent}
            visibleIds={visibleIds}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

function TreeNode({
  goal,
  depth,
  childrenByParent,
  visibleIds,
  selectedId,
  onSelect,
}: {
  goal: Goal;
  depth: number;
  childrenByParent: Map<string, Goal[]>;
  visibleIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const children = (childrenByParent.get(goal.id) ?? []).filter((c) => visibleIds.has(c.id));
  const [expanded, setExpanded] = useState(true);
  const isSelected = selectedId === goal.id;

  return (
    <li className="v2-goals__tree-item" role="treeitem">
      <div
        className="v2-goals__tree-row"
        data-selected={isSelected}
        style={{ paddingLeft: `${depth * LEVEL_INDENT_PX + 12}px` }}
        onClick={() => onSelect(isSelected ? null : goal.id)}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="v2-goals__tree-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            aria-label={expanded ? "Collapse" : "Expand"}
            data-expanded={expanded}
          >
            <Icon icon={ChevronRight} size="sm" />
          </button>
        ) : (
          <span className="v2-goals__tree-spacer" aria-hidden="true" />
        )}
        <span className="v2-goals__tree-level" data-level={goal.level}>
          {shortLevel(goal.level)}
        </span>
        <span className="v2-goals__tree-title">{goal.title}</span>
        <ScoreBar score={goal.score} />
        <Chip tone={STATUS_TONE[goal.status]} dot>
          {goal.status}
        </Chip>
        <Chip tone={HEALTH_TONE[goal.health]} dot>
          {goal.health.replace(/_/g, " ")}
        </Chip>
      </div>
      {expanded && children.length > 0 && (
        <ul className="v2-goals__tree-list" role="group">
          {children.map((c) => (
            <TreeNode
              key={c.id}
              goal={c}
              depth={depth + 1}
              childrenByParent={childrenByParent}
              visibleIds={visibleIds}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(1, score)) * 100;
  const tone = score >= 0.7 ? "ok" : score >= 0.4 ? "warn" : "accent";
  return (
    <div className="v2-goals__score-bar" title={`Score ${(score * 100).toFixed(0)}%`}>
      <div className="v2-goals__score-bar-fill" data-tone={tone} style={{ width: `${pct}%` }} />
      <span className="v2-goals__score-bar-label">{Math.round(pct)}%</span>
    </div>
  );
}

/* ─────────── Constellation sky (spatial OKR graph) ─────────── */

/** health → the single state hue the ring carries. at_risk and behind share
 *  amber deliberately (the word does the work); critical is the only red. */
function healthHue(health: GoalHealth): string {
  switch (health) {
    case "on_track":
      return "var(--ok)";
    case "critical":
      return "var(--listen)";
    default:
      return "var(--hold)"; // at_risk + behind
  }
}

/** ring diameter by level — size alone carries the ladder, so the old five
 *  level colours retire (design §01). */
function ringSize(level: GoalLevel): number {
  switch (level) {
    case "objective":
      return 58;
    case "key_result":
      return 42;
    case "milestone":
      return 32;
    case "task":
      return 26;
    default:
      return 20; // daily_action
  }
}

/** ".64" / "1.0" / ".00" — the OKR score, Google convention. */
function scoreLabel(score: number): string {
  if (score >= 1) return "1.0";
  return "." + String(Math.round(Math.max(0, score) * 100)).padStart(2, "0");
}

type SkyNode = { goal: Goal; depth: number; x: number; y: number; size: number };
type SkyEdge = { key: string; parentId: string; childId: string; x1: number; y1: number; x2: number; y2: number; depth: number };

/** Tidy-tree layout: objectives anchor the left column, children arc rightward
 *  and shrink with depth; a parent sits at the vertical mean of its children. */
function layoutConstellation(
  roots: Goal[],
  childrenByParent: Map<string, Goal[]>,
  visibleIds: Set<string>,
): { nodes: SkyNode[]; edges: SkyEdge[] } {
  const X_COLS = [14, 39, 62, 80, 91];
  const kidsOf = (g: Goal) => (childrenByParent.get(g.id) ?? []).filter((c) => visibleIds.has(c.id));
  const countLeaves = (g: Goal): number => {
    const k = kidsOf(g);
    return k.length === 0 ? 1 : k.reduce((s, c) => s + countLeaves(c), 0);
  };
  const totalLeaves = Math.max(1, roots.reduce((s, r) => s + countLeaves(r), 0));

  const nodes: SkyNode[] = [];
  const pos = new Map<string, { x: number; y: number }>();
  let leaf = 0;

  const place = (g: Goal, depth: number): number => {
    const k = kidsOf(g);
    let slot: number;
    if (k.length === 0) {
      slot = (leaf + 0.5) / totalLeaves;
      leaf += 1;
    } else {
      const ys = k.map((c) => place(c, depth + 1));
      slot = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
    const x = X_COLS[Math.min(depth, X_COLS.length - 1)]!;
    const y = 9 + slot * 82; // keep rings off the top/bottom edges
    nodes.push({ goal: g, depth, x, y, size: ringSize(g.level) });
    pos.set(g.id, { x, y });
    return slot;
  };
  roots.forEach((r) => place(r, 0));

  const edges: SkyEdge[] = [];
  for (const n of nodes) {
    const pid = n.goal.parent_id;
    if (pid && pos.has(pid)) {
      const p = pos.get(pid)!;
      edges.push({ key: `${pid}-${n.goal.id}`, parentId: pid, childId: n.goal.id, x1: p.x, y1: p.y, x2: n.x, y2: n.y, depth: n.depth });
    }
  }
  return { nodes, edges };
}

function ConstellationSky({
  roots,
  childrenByParent,
  visibleIds,
  selectedId,
  onSelect,
  loading,
}: {
  roots: Goal[];
  childrenByParent: Map<string, Goal[]>;
  visibleIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  loading: boolean;
}) {
  const { nodes, edges } = useMemo(
    () => layoutConstellation(roots, childrenByParent, visibleIds),
    [roots, childrenByParent, visibleIds],
  );

  if (loading && nodes.length === 0) {
    return <div className="v2-goals__empty">Loading goals…</div>;
  }
  if (nodes.length === 0) {
    return (
      <div className="v2-goals__empty">
        No goals match the current filters. Click <strong>New</strong> to create one.
      </div>
    );
  }

  return (
    <div className="v2-goals__sky">
      <svg className="v2-goals__edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {edges.map((e) => {
          const hot = selectedId === e.childId || selectedId === e.parentId;
          return (
            <line
              key={e.key}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              className={hot ? "hot" : ""}
              style={{ strokeWidth: e.depth >= 2 ? 0.8 : 1 }}
            />
          );
        })}
      </svg>
      {nodes.map((n) => (
        <button
          key={n.goal.id}
          type="button"
          className="v2-goals__gnode"
          data-level={n.goal.level}
          data-selected={selectedId === n.goal.id}
          data-critical={n.goal.health === "critical"}
          style={
            {
              left: `${n.x}%`,
              top: `${n.y}%`,
              ["--rs" as string]: `${n.size}px`,
              ["--sc" as string]: Math.round(Math.max(0, Math.min(1, n.goal.score)) * 100),
              ["--hl" as string]: healthHue(n.goal.health),
            } as React.CSSProperties
          }
          onClick={() => onSelect(selectedId === n.goal.id ? null : n.goal.id)}
          title={`${n.goal.title} · ${(n.goal.score * 100).toFixed(0)}%`}
          aria-label={`${n.goal.title}, ${n.goal.level.replace(/_/g, " ")}, score ${(n.goal.score * 100).toFixed(0)} percent`}
        >
          <span className="v2-goals__gring">
            {n.size >= 32 && <b className="v2-goals__scin">{scoreLabel(n.goal.score)}</b>}
          </span>
          <span className="v2-goals__glb">{n.goal.title}</span>
        </button>
      ))}
    </div>
  );
}

/* ─────────── Timeline tab (Gantt) ─────────── */

const GANTT_ORDER: ReadonlyArray<GoalLevel> = ["objective", "key_result", "milestone", "task", "daily_action"];
const GANTT_LEVEL_LABEL: Record<GoalLevel, string> = {
  objective: "Objectives",
  key_result: "Key results",
  milestone: "Milestones",
  task: "Tasks",
  daily_action: "Daily actions",
};
const RULER_H = 30;
const LVL_H = 22;
const ROW_H = 30;
const DAY = 86_400_000;

type GanttRow =
  | { kind: "header"; id: string; label: string; top: number }
  | { kind: "goal"; id: string; goal: Goal; start: number; end: number; dated: boolean; top: number };

function Timeline({
  goals,
  selectedId,
  onSelect,
}: {
  goals: Goal[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const now = Date.now();

  const model = useMemo(() => {
    const rows: GanttRow[] = [];
    let y = RULER_H;
    let minT = Infinity;
    let maxT = -Infinity;

    for (const level of GANTT_ORDER) {
      const inLevel = goals
        .filter((g) => g.level === level)
        .map((g) => {
          const start = g.started_at ?? g.created_at;
          const end = g.deadline ?? now + 14 * DAY;
          return { goal: g, start, end: Math.max(end, start + DAY), dated: g.deadline !== null };
        })
        .sort((a, b) => a.start - b.start);
      if (inLevel.length === 0) continue;

      rows.push({ kind: "header", id: `h-${level}`, label: GANTT_LEVEL_LABEL[level], top: y });
      y += LVL_H;
      for (const it of inLevel) {
        rows.push({ kind: "goal", id: it.goal.id, goal: it.goal, start: it.start, end: it.end, dated: it.dated, top: y });
        y += ROW_H;
        minT = Math.min(minT, it.start);
        maxT = Math.max(maxT, it.end);
      }
    }

    if (!Number.isFinite(minT)) return null;
    // Snap the domain to whole months so the ruler segments read as real months.
    const lo = startOfMonth(Math.min(minT, now));
    const hi = endOfMonth(Math.max(maxT, now));
    const months: number[] = [];
    for (let t = lo; t <= hi; t = startOfMonth(t + 32 * DAY)) months.push(t);

    return { rows, totalH: y, lo, hi, months };
  }, [goals, now]);

  if (!model) {
    return (
      <div className="v2-goals__empty">
        No goals to display. Create your first goal to see the timeline.
      </div>
    );
  }

  const span = Math.max(1, model.hi - model.lo);
  const pct = (t: number) => ((t - model.lo) / span) * 100;

  return (
    <div className="v2-goals__gantt" style={{ ["--gantt-h" as string]: `${model.totalH}px` } as React.CSSProperties}>
      {/* left: the ladder */}
      <div className="v2-goals__gantt-labels">
        <div className="v2-goals__gantt-spacer">goal tree</div>
        {model.rows.map((r) =>
          r.kind === "header" ? (
            <div key={r.id} className="v2-goals__glvl" style={{ top: r.top, height: LVL_H }}>
              {r.label}
            </div>
          ) : (
            <button
              key={r.id}
              type="button"
              className="v2-goals__grow"
              data-selected={selectedId === r.goal.id}
              data-dead={r.goal.status === "killed" || r.goal.status === "failed"}
              style={{ top: r.top, height: ROW_H }}
              onClick={() => onSelect(selectedId === r.goal.id ? null : r.goal.id)}
            >
              <span className="v2-goals__stdot" style={{ background: healthHue(r.goal.health) }} />
              <span className="v2-goals__grow-title">{r.goal.title}</span>
              <span className="v2-goals__grow-sc">{scoreLabel(r.goal.score)}</span>
            </button>
          ),
        )}
      </div>

      {/* right: the calendar */}
      <div className="v2-goals__gantt-bars">
        <div className="v2-goals__gmon">
          {model.months.map((m) => (
            <span key={m}>{monthShort(m)}</span>
          ))}
        </div>
        <div className="v2-goals__today" style={{ left: `${pct(now)}%` }}>
          <i>today</i>
        </div>
        {model.rows.map((r) =>
          r.kind === "goal" ? (
            <button
              key={r.id}
              type="button"
              className="v2-goals__gbar"
              data-selected={selectedId === r.goal.id}
              data-undated={!r.dated}
              style={
                {
                  top: r.top + 8,
                  left: `${pct(r.start)}%`,
                  width: `${Math.max(1.5, pct(r.end) - pct(r.start))}%`,
                  ["--sc" as string]: Math.round(Math.max(0, Math.min(1, r.goal.score)) * 100),
                  ["--hl" as string]: healthHue(r.goal.health),
                } as React.CSSProperties
              }
              onClick={() => onSelect(selectedId === r.goal.id ? null : r.goal.id)}
              aria-label={`${r.goal.title} timeline bar`}
            >
              <i />
              {r.dated && <span className="v2-goals__gbar-dl">{shortDate(r.goal.deadline!)}</span>}
            </button>
          ) : null,
        )}
      </div>
    </div>
  );
}

/* ─────────── Metrics tab ─────────── */

const HEALTH_ROWS: ReadonlyArray<{ health: GoalHealth; label: string; tx: string }> = [
  { health: "on_track", label: "On track", tx: "var(--ok-tx)" },
  { health: "at_risk", label: "At risk", tx: "var(--hold-tx)" },
  { health: "behind", label: "Behind", tx: "var(--hold-tx)" },
  { health: "critical", label: "Critical", tx: "var(--listen-tx)" },
];

const HISTO_COLORS = [
  "color-mix(in srgb, var(--listen) 55%, var(--panel))",
  "color-mix(in srgb, var(--hold) 55%, var(--panel))",
  "var(--panel)",
  "color-mix(in srgb, var(--ok) 40%, var(--panel))",
  "color-mix(in srgb, var(--ok) 70%, var(--panel))",
];

function Metrics({
  metrics,
  goals,
}: {
  metrics: NonNullable<ReturnType<typeof useGoalsData>["metrics"]>;
  goals: Goal[];
}) {
  const healthTotal = Math.max(1, metrics.on_track + metrics.at_risk + metrics.behind + metrics.critical);

  // Score histogram — five buckets on the tone ramp, computed from live scores.
  const histo = useMemo(() => {
    const scored = goals.filter((g) => g.status === "active" || g.status === "completed");
    const buckets = [0, 0, 0, 0, 0];
    for (const g of scored) {
      const i = Math.min(4, Math.floor(Math.max(0, Math.min(0.999, g.score)) / 0.2));
      buckets[i] = (buckets[i] ?? 0) + 1;
    }
    const max = Math.max(1, ...buckets);
    const sorted = scored.map((g) => g.score).sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
    return { buckets, max, median, n: scored.length };
  }, [goals]);

  // Goals by level — active vs total, live.
  const byLevel = useMemo(() => {
    return GANTT_ORDER.map((level) => {
      const all = goals.filter((g) => g.level === level);
      const active = all.filter((g) => g.status === "active").length;
      return { level, label: GANTT_LEVEL_LABEL[level], active, total: all.length };
    }).filter((r) => r.total > 0);
  }, [goals]);

  return (
    <div className="v2-goals__mgrid">
      {/* overall score */}
      <div className="v2-goals__mcard">
        <div className="v2-goals__mk">overall score</div>
        <div className="v2-goals__mscore">
          <span
            className="v2-goals__bigring"
            style={{ ["--sc" as string]: Math.round(metrics.avg_score * 100), ["--hl" as string]: "var(--ink)" } as React.CSSProperties}
          >
            <b>{scoreLabel(metrics.avg_score)}</b>
          </span>
          <div>
            <div className="v2-goals__mbig">{Math.round(metrics.avg_score * 100)}%</div>
            <div className="v2-goals__mnote">avg across {metrics.active} active goals · 0.7 is a good score</div>
          </div>
        </div>
      </div>

      {/* health distribution */}
      <div className="v2-goals__mcard">
        <div className="v2-goals__mk">health distribution</div>
        {HEALTH_ROWS.map((r) => {
          const count = metrics[r.health];
          return (
            <div key={r.health} className="v2-goals__hrow">
              <span className="v2-goals__stdot" style={{ background: healthHue(r.health) }} />
              <span className="v2-goals__hlabel">{r.label}</span>
              <span className="v2-goals__hbar">
                <i style={{ width: `${(count / healthTotal) * 100}%`, background: healthHue(r.health) }} />
              </span>
              <span className="v2-goals__hc" style={{ color: r.tx }}>{count}</span>
            </div>
          );
        })}
        <div className="v2-goals__mfoot">
          {metrics.completed} completed · {metrics.failed} failed · {metrics.killed} killed
        </div>
      </div>

      {/* score distribution */}
      <div className="v2-goals__mcard">
        <div className="v2-goals__mk">score distribution</div>
        <div className="v2-goals__histo">
          {histo.buckets.map((b, i) => (
            <i key={i} style={{ height: `${Math.max(4, (b / histo.max) * 100)}%`, background: HISTO_COLORS[i] }} />
          ))}
        </div>
        <div className="v2-goals__histo-axis">
          <span>0–.2</span><span>.2–.4</span><span>.4–.6</span><span>.6–.8</span><span>.8–1</span>
        </div>
        <div className="v2-goals__mfoot">median {histo.median.toFixed(2)} · {histo.n} scored</div>
      </div>

      {/* score velocity — honest: needs check-in history the metrics API doesn't expose yet */}
      <div className="v2-goals__mcard">
        <div className="v2-goals__mk">score velocity · 30 days</div>
        <div className="v2-goals__mbig" style={{ color: "var(--ink3)" }}>—</div>
        <svg className="v2-goals__spark" viewBox="0 0 280 48" width="100%" height="40" aria-hidden="true">
          <line x1="0" y1="40" x2="280" y2="40" stroke="var(--rule2)" strokeWidth="1.5" strokeDasharray="3 4" />
        </svg>
        <div className="v2-goals__mnote">Needs a check-in history the metrics API doesn't track yet.</div>
      </div>

      {/* goals by level */}
      <div className="v2-goals__mcard">
        <div className="v2-goals__mk">goals by level</div>
        {byLevel.map((r) => (
          <div key={r.level} className="v2-goals__hrow">
            <span className="v2-goals__hlabel v2-goals__hlabel--wide">{r.label}</span>
            <span className="v2-goals__hbar">
              <i style={{ width: `${(r.active / Math.max(1, r.total)) * 100}%`, background: "var(--ink2)" }} />
            </span>
            <span className="v2-goals__hc">{r.active}/{r.total}</span>
          </div>
        ))}
      </div>

      {/* escalation — derived from health (the drill-sergeant ladder is health-driven) */}
      <div className="v2-goals__mcard">
        <div className="v2-goals__mk">escalation status</div>
        <div className="v2-goals__esrow">Gentle nudge<span className="v2-goals__esb" data-tone="amb">{metrics.at_risk}</span></div>
        <div className="v2-goals__esrow">Direct call<span className="v2-goals__esb" data-tone="amb">{metrics.behind}</span></div>
        <div className="v2-goals__esrow">Drill sergeant<span className="v2-goals__esb" data-tone="mut">0</span></div>
        <div className="v2-goals__esrow">Intervention<span className="v2-goals__esb" data-tone="red">{metrics.critical}</span></div>
        <div className="v2-goals__mnote">
          Watching <b style={{ color: "var(--hold-tx)" }}>{metrics.at_risk} at-risk goals</b>; escalates if scores don't improve within <b style={{ color: "var(--ink)" }}>72 hours</b>.
        </div>
      </div>
    </div>
  );
}

/* ─────────── Detail panel ─────────── */

function DetailPanel({
  goal,
  allGoals,
  childrenByParent,
  onClose,
  onScore,
  onStatus,
  onHealth,
}: {
  goal: Goal;
  allGoals: Goal[];
  childrenByParent: Map<string, Goal[]>;
  onClose: () => void;
  onScore: (score: number, reason: string) => void;
  onStatus: (status: GoalStatus) => void;
  onHealth: (health: GoalHealth) => void;
}) {
  const parent = goal.parent_id ? allGoals.find((g) => g.id === goal.parent_id) : null;
  const children = childrenByParent.get(goal.id) ?? [];

  // Local score draft so the slider feels responsive without spamming the API.
  const [scoreDraft, setScoreDraft] = useState(goal.score);
  const [scoreReason, setScoreReason] = useState("");
  const lastIdRef = useRef(goal.id);
  useEffect(() => {
    if (lastIdRef.current !== goal.id) {
      setScoreDraft(goal.score);
      setScoreReason("");
      lastIdRef.current = goal.id;
    }
  }, [goal.id, goal.score]);

  return (
    <aside className="v2-goals__side">
      <header className="v2-goals__side-head">
        <div>
          <div className="v2-goals__side-eyebrow">{goal.level.replace(/_/g, " ")}</div>
          <h3 className="v2-goals__side-title">{goal.title}</h3>
          {parent && (
            <div className="v2-goals__side-parent">↑ {parent.title}</div>
          )}
        </div>
        <button
          type="button"
          className="v2-goals__icon-btn"
          onClick={onClose}
          aria-label="Close detail"
        >
          <Icon icon={X} size="sm" />
        </button>
      </header>

      <div className="v2-goals__side-body">
        {goal.description && (
          <p className="v2-goals__side-desc">{goal.description}</p>
        )}

        {goal.success_criteria && (
          <section className="v2-goals__side-section">
            <div className="v2-goals__side-label">Success criteria</div>
            <p className="v2-goals__side-text">{goal.success_criteria}</p>
          </section>
        )}

        <section className="v2-goals__side-section">
          <div className="v2-goals__side-label">Score · {(scoreDraft * 100).toFixed(0)}%</div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(scoreDraft * 100)}
            onChange={(e) => setScoreDraft(parseInt(e.target.value, 10) / 100)}
            className="v2-goals__score-slider"
          />
          <input
            type="text"
            className="v2-goals__input"
            placeholder="Reason for the change…"
            value={scoreReason}
            onChange={(e) => setScoreReason(e.target.value)}
          />
          <button
            type="button"
            className="v2-goals__btn v2-goals__btn--primary"
            disabled={Math.abs(scoreDraft - goal.score) < 0.005}
            onClick={() => onScore(scoreDraft, scoreReason || "Updated via dashboard")}
          >
            Save score
          </button>
        </section>

        <section className="v2-goals__side-section">
          <div className="v2-goals__side-label">Status</div>
          <div className="v2-goals__chip-row">
            {GOAL_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                className="v2-goals__chip"
                data-active={goal.status === s}
                onClick={() => onStatus(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </section>

        <section className="v2-goals__side-section">
          <div className="v2-goals__side-label">Health</div>
          <div className="v2-goals__chip-row">
            {GOAL_HEALTHS.map((h) => (
              <button
                key={h}
                type="button"
                className="v2-goals__chip"
                data-active={goal.health === h}
                onClick={() => onHealth(h)}
              >
                {h.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        </section>

        {goal.deadline && (
          <section className="v2-goals__side-section">
            <div className="v2-goals__side-label">Deadline</div>
            <div className="v2-goals__side-text">{fullDate(goal.deadline)}</div>
          </section>
        )}

        {children.length > 0 && (
          <section className="v2-goals__side-section">
            <div className="v2-goals__side-label">Children · {children.length}</div>
            <ul className="v2-goals__side-children">
              {children.map((c) => (
                <li key={c.id} className="v2-goals__side-child">
                  <span>{c.title}</span>
                  <Chip tone={STATUS_TONE[c.status]} dot>
                    {c.status}
                  </Chip>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}

/* ─────────── Create dialog ─────────── */

function CreateDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: { title: string; level: GoalLevel; deadline?: number }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [level, setLevel] = useState<GoalLevel>("task");
  const [deadlineStr, setDeadlineStr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    const deadlineMs = deadlineStr ? parseDeadlineInput(deadlineStr) : undefined;
    const ok = await onCreate({
      title: title.trim(),
      level,
      deadline: deadlineMs,
    });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div className="v2-goals__overlay" onClick={() => !busy && onClose()}>
      <div
        className="v2-goals__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="v2-goals-create-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="v2-goals__dialog-head">
          <div>
            <div id="v2-goals-create-title" className="v2-goals__dialog-title">
              New goal
            </div>
            <div className="v2-goals__dialog-subtitle">
              Quick create — full detail editable in the side panel after.
            </div>
          </div>
          <button
            type="button"
            className="v2-goals__icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <Icon icon={X} size="sm" />
          </button>
        </div>

        <div className="v2-goals__dialog-body">
          <label className="v2-goals__field">
            <span className="v2-goals__field-label">Title</span>
            <input
              type="text"
              className="v2-goals__input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What do you want to achieve?"
              autoFocus
            />
          </label>

          <label className="v2-goals__field">
            <span className="v2-goals__field-label">Level</span>
            <div className="v2-goals__chip-row">
              {GOAL_LEVELS.map((l) => (
                <button
                  key={l}
                  type="button"
                  className="v2-goals__chip"
                  data-active={level === l}
                  onClick={() => setLevel(l)}
                >
                  {l.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          </label>

          <label className="v2-goals__field">
            <span className="v2-goals__field-label">Deadline (optional)</span>
            <input
              type="date"
              className="v2-goals__input"
              value={deadlineStr}
              onChange={(e) => setDeadlineStr(e.target.value)}
            />
          </label>
        </div>

        <div className="v2-goals__dialog-foot">
          <button
            type="button"
            className="v2-goals__btn v2-goals__btn--secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="v2-goals__btn v2-goals__btn--primary"
            onClick={submit}
            disabled={busy || !title.trim()}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────── helpers ─────────── */

function shortLevel(level: GoalLevel): string {
  return level.replace(/_/g, " ");
}

function shortDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fullDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const d = new Date(parseInt(y!, 10), parseInt(m!, 10) - 1, 1);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function startOfMonth(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function endOfMonth(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).getTime();
}

function monthShort(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

/** Parse an `<input type="date">` value (YYYY-MM-DD) to local-time epoch ms.
 *  Returns undefined if the input is empty or malformed. */
function parseDeadlineInput(s: string): number | undefined {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const d = new Date(parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10), 23, 59, 0, 0);
  if (isNaN(d.getTime())) return undefined;
  return d.getTime();
}
