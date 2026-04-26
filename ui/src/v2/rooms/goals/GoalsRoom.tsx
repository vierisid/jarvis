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
      {(mode === "inline" || activeTab === "constellation") && (
        <Constellation
          roots={data.roots.filter((g) => visibleIds.has(g.id))}
          childrenByParent={data.childrenByParent}
          visibleIds={visibleIds}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={data.loading}
        />
      )}
      {mode === "expanded" && activeTab === "timeline" && (
        <Timeline
          goals={filteredGoals.filter((g) => g.deadline !== null)}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}
      {mode === "expanded" && activeTab === "metrics" && data.metrics && (
        <Metrics metrics={data.metrics} overdue={data.overdue} onSelect={setSelectedId} />
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

/* ─────────── Timeline tab ─────────── */

function Timeline({
  goals,
  selectedId,
  onSelect,
}: {
  goals: Goal[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (goals.length === 0) {
    return <div className="v2-goals__empty">No deadlines in the current filter.</div>;
  }

  // Bucket by month for a simple horizontal-ish timeline.
  const buckets = useMemo(() => {
    const map = new Map<string, Goal[]>();
    const sorted = [...goals].sort((a, b) => (a.deadline ?? 0) - (b.deadline ?? 0));
    for (const g of sorted) {
      if (g.deadline === null) continue;
      const key = monthKey(g.deadline);
      const arr = map.get(key);
      if (arr) arr.push(g);
      else map.set(key, [g]);
    }
    return map;
  }, [goals]);

  return (
    <div className="v2-goals__timeline">
      {Array.from(buckets.entries()).map(([key, list]) => (
        <section key={key} className="v2-goals__time-band">
          <div className="v2-goals__time-band-head">{monthLabel(key)}</div>
          <ul className="v2-goals__time-list">
            {list.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  className="v2-goals__time-row"
                  data-selected={selectedId === g.id}
                  onClick={() => onSelect(selectedId === g.id ? null : g.id)}
                >
                  <span className="v2-goals__time-date">{shortDate(g.deadline!)}</span>
                  <span className="v2-goals__time-title">{g.title}</span>
                  <Chip tone={STATUS_TONE[g.status]} dot>
                    {g.status}
                  </Chip>
                  <Chip tone={HEALTH_TONE[g.health]} dot>
                    {g.health.replace(/_/g, " ")}
                  </Chip>
                  <ScoreBar score={g.score} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/* ─────────── Metrics tab ─────────── */

function Metrics({
  metrics,
  overdue,
  onSelect,
}: {
  metrics: NonNullable<ReturnType<typeof useGoalsData>["metrics"]>;
  overdue: Goal[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="v2-goals__metrics">
      <section className="v2-goals__metrics-section">
        <h3 className="v2-goals__metrics-title">Status breakdown</h3>
        <div className="v2-goals__metrics-grid">
          <MetricTile label="Total" value={metrics.total} />
          <MetricTile label="Active" value={metrics.active} tone="warn" />
          <MetricTile label="Completed" value={metrics.completed} tone="ok" />
          <MetricTile label="Failed" value={metrics.failed} tone="accent" />
          <MetricTile label="Killed" value={metrics.killed} tone="accent" />
          <MetricTile
            label="Avg score"
            value={`${Math.round(metrics.avg_score * 100)}%`}
          />
        </div>
      </section>

      <section className="v2-goals__metrics-section">
        <h3 className="v2-goals__metrics-title">Health</h3>
        <div className="v2-goals__metrics-grid">
          <MetricTile label="On track" value={metrics.on_track} tone="ok" />
          <MetricTile label="At risk" value={metrics.at_risk} tone="warn" />
          <MetricTile label="Behind" value={metrics.behind} tone="warn" />
          <MetricTile label="Critical" value={metrics.critical} tone="accent" />
        </div>
      </section>

      <section className="v2-goals__metrics-section">
        <h3 className="v2-goals__metrics-title">
          Overdue ({overdue.length})
        </h3>
        {overdue.length === 0 ? (
          <div className="v2-goals__empty-line">Nothing overdue. Nice.</div>
        ) : (
          <ul className="v2-goals__overdue-list">
            {overdue.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  className="v2-goals__overdue-row"
                  onClick={() => onSelect(g.id)}
                >
                  <Icon icon={AlertTriangle} size="sm" />
                  <span className="v2-goals__overdue-title">{g.title}</span>
                  <span className="v2-goals__overdue-due">
                    Due {shortDate(g.deadline ?? 0)}
                  </span>
                  <ScoreBar score={g.score} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function MetricTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "neutral" | "ok" | "warn" | "accent";
}) {
  return (
    <div className="v2-goals__metric-tile" data-tone={tone ?? "neutral"}>
      <div className="v2-goals__metric-label">{label}</div>
      <div className="v2-goals__metric-value">{value}</div>
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

/** Parse an `<input type="date">` value (YYYY-MM-DD) to local-time epoch ms.
 *  Returns undefined if the input is empty or malformed. */
function parseDeadlineInput(s: string): number | undefined {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const d = new Date(parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10), 23, 59, 0, 0);
  if (isNaN(d.getTime())) return undefined;
  return d.getTime();
}
