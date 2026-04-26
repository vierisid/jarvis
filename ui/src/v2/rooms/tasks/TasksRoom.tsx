import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckSquare,
  Clock,
  KanbanSquare,
  List,
  Plus,
  RefreshCw,
  Search,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Chip, Icon } from "../../ui";
import { RoomShell } from "../RoomShell";
import { useRoomActions } from "../useRoomActionBus";
import { parseRelativeDate } from "../../../../../src/voice/parse-date";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  useTasksData,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "./useTasksData";
import "./TasksRoom.css";

type ViewMode = "kanban" | "list";

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Pending",
  active: "Active",
  completed: "Completed",
  failed: "Failed",
  escalated: "Escalated",
};

const STATUS_TONE: Record<TaskStatus, "ok" | "neutral" | "warn" | "accent"> = {
  pending: "neutral",
  active: "warn",
  completed: "ok",
  failed: "accent",
  escalated: "accent",
};

const PRIORITY_TONE: Record<TaskPriority, "ok" | "neutral" | "warn" | "accent"> = {
  low: "ok",
  normal: "neutral",
  high: "warn",
  critical: "accent",
};

const PRIORITY_RANK: Record<TaskPriority, number> = {
  critical: 0, high: 1, normal: 2, low: 3,
};

export type RoomBodyMode = "inline" | "expanded";

export function TasksRoomBody({ mode }: { mode: RoomBodyMode }) {
  const data = useTasksData();
  const [view, setView] = useState<ViewMode>("kanban");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "all">("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const filteredTasks = useMemo(() => {
    let list = data.tasks;
    if (statusFilter !== "all") list = list.filter((t) => t.status === statusFilter);
    if (priorityFilter !== "all") list = list.filter((t) => t.priority === priorityFilter);
    if (assigneeFilter !== "all") {
      list = list.filter((t) => (t.assigned_to ?? "unassigned") === assigneeFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (t) =>
          t.what.toLowerCase().includes(q) ||
          (t.context ?? "").toLowerCase().includes(q) ||
          (t.assigned_to ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [data.tasks, search, statusFilter, priorityFilter, assigneeFilter]);

  const filteredByStatus = useMemo(() => {
    const map = new Map<TaskStatus, Task[]>();
    for (const s of TASK_STATUSES) map.set(s, []);
    for (const t of filteredTasks) map.get(t.status)?.push(t);
    return map;
  }, [filteredTasks]);

  const assigneeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of data.tasks) set.add(t.assigned_to ?? "unassigned");
    return ["all", ...Array.from(set).sort()];
  }, [data.tasks]);

  // Phase 6.3.5 — voice room actions for Tasks.
  useRoomActions("tasks", (action, args) => {
    switch (action) {
      case "switch_view": {
        const v = String(args.view);
        if (v === "kanban" || v === "list") {
          setView(v);
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
          if (value === "all" || (TASK_STATUSES as readonly string[]).includes(value)) {
            setStatusFilter(value as TaskStatus | "all");
            return true;
          }
        } else if (field === "priority") {
          if (value === "all" || (TASK_PRIORITIES as readonly string[]).includes(value)) {
            setPriorityFilter(value as TaskPriority | "all");
            return true;
          }
        } else if (field === "assigned_to") {
          setAssigneeFilter(value);
          return true;
        }
        return false;
      }
      case "select": {
        const name = typeof args.name === "string" ? args.name : "";
        const t = data.findByName(name);
        if (!t) return false;
        // No detail panel in Tasks Room; surface via toast.
        setToast({
          text: `Found: "${t.what}" — ${t.status}, ${t.priority}.`,
          tone: "ok",
        });
        return true;
      }
      case "create_task": {
        const what = typeof args.title === "string" ? args.title.trim() : "";
        if (!what) return false;
        const whenStr = typeof args.when === "string" ? args.when : "";
        const parsed = whenStr ? parseRelativeDate(whenStr) : null;
        const priority = (args.priority as TaskPriority) ?? undefined;
        const assigned = typeof args.assigned_to === "string" ? args.assigned_to : undefined;
        (async () => {
          const r = await data.createTask({
            what,
            when_due: parsed?.ts,
            priority,
            assigned_to: assigned,
          });
          if (r.ok) {
            setToast({
              text: `Created task "${r.task.what}".`,
              tone: "ok",
            });
          } else {
            setToast({ text: r.message, tone: "warn" });
          }
        })();
        return true;
      }
      case "complete_task": {
        const name = typeof args.name === "string" ? args.name : "";
        const t = data.findByName(name);
        if (!t) return false;
        (async () => {
          const r = await data.updateStatus(t.id, "completed");
          setToast({ text: r.ok ? `Marked "${t.what}" complete.` : r.message, tone: r.ok ? "ok" : "warn" });
        })();
        return true;
      }
      case "update_priority": {
        const name = typeof args.name === "string" ? args.name : "";
        const level = (args.level as TaskPriority) ?? "normal";
        const t = data.findByName(name);
        if (!t) return false;
        if (!(TASK_PRIORITIES as readonly string[]).includes(level)) return false;
        (async () => {
          const r = await data.updatePriority(t.id, level);
          setToast({ text: r.ok ? `Set "${t.what}" to ${level}.` : r.message, tone: r.ok ? "ok" : "warn" });
        })();
        return true;
      }
      case "reassign": {
        const name = typeof args.name === "string" ? args.name : "";
        const agent = typeof args.agent === "string" ? args.agent : null;
        const t = data.findByName(name);
        if (!t) return false;
        (async () => {
          const r = await data.reassign(t.id, agent);
          setToast({ text: r.ok ? `Reassigned "${t.what}" to ${agent ?? "no one"}.` : r.message, tone: r.ok ? "ok" : "warn" });
        })();
        return true;
      }
      default:
        return false;
    }
  });

  return (
    <div className={`v2-tasks v2-tasks--${mode}`}>
      {/* Stats */}
      <div className="v2-tasks__stats">
        <StatCard label="Active" value={data.stats.active} sub="pending + active" />
        <StatCard
          label="Completed today"
          value={data.stats.completedToday}
          sub="since midnight"
          tone="ok"
        />
        <StatCard
          label="Overdue"
          value={data.stats.overdue}
          sub="past due, not done"
          tone={data.stats.overdue > 0 ? "warn" : "neutral"}
        />
        <StatCard label="Total" value={data.stats.total} sub="all statuses" />
      </div>

      {/* Toolbar */}
      <div className="v2-tasks__toolbar">
        <div className="v2-tasks__search">
          <Icon icon={Search} size="sm" />
          <input
            className="v2-tasks__search-input"
            type="text"
            placeholder="Search tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search tasks"
          />
        </div>

        <FilterPills
          label="Status"
          options={["all", ...TASK_STATUSES]}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as TaskStatus | "all")}
        />
        <FilterPills
          label="Priority"
          options={["all", ...TASK_PRIORITIES]}
          value={priorityFilter}
          onChange={(v) => setPriorityFilter(v as TaskPriority | "all")}
        />

        {mode === "expanded" && (
          <div className="v2-tasks__view-row" role="tablist" aria-label="View">
            <button
              type="button"
              className="v2-tasks__view-btn"
              data-active={view === "kanban"}
              onClick={() => setView("kanban")}
              aria-label="Kanban view"
              title="Kanban"
            >
              <Icon icon={KanbanSquare} size="sm" />
            </button>
            <button
              type="button"
              className="v2-tasks__view-btn"
              data-active={view === "list"}
              onClick={() => setView("list")}
              aria-label="List view"
              title="List"
            >
              <Icon icon={List} size="sm" />
            </button>
          </div>
        )}

        {assigneeOptions.length > 1 && (
          <select
            className="v2-tasks__select"
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            aria-label="Filter by assignee"
          >
            {assigneeOptions.map((a) => (
              <option key={a} value={a}>
                {a === "all" ? "All assignees" : a === "unassigned" ? "Unassigned" : a}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          className="v2-tasks__refresh"
          onClick={data.refresh}
          aria-label="Refresh"
          title="Refresh"
        >
          <Icon icon={RefreshCw} size="sm" />
        </button>
        <button
          type="button"
          className="v2-tasks__new-btn"
          onClick={() => setCreateOpen(true)}
        >
          <Icon icon={Plus} size="sm" />
          New
        </button>
      </div>

      {data.error && <div className="v2-tasks__error">{data.error}</div>}

      {/* Content */}
      {view === "kanban" || mode === "inline" ? (
        <Kanban
          tasksByStatus={filteredByStatus}
          loading={data.loading}
          onComplete={async (id) => {
            const r = await data.updateStatus(id, "completed");
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
          onFail={async (id) => {
            const r = await data.updateStatus(id, "failed");
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
          onPriority={async (id, level) => {
            const r = await data.updatePriority(id, level);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
        />
      ) : (
        <ListView
          tasks={[...filteredTasks].sort((a, b) => {
            const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
            if (p !== 0) return p;
            return (a.when_due ?? Number.MAX_SAFE_INTEGER) - (b.when_due ?? Number.MAX_SAFE_INTEGER);
          })}
          loading={data.loading}
          onComplete={async (id) => {
            const r = await data.updateStatus(id, "completed");
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
          onFail={async (id) => {
            const r = await data.updateStatus(id, "failed");
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
        />
      )}

      {createOpen && (
        <CreateDialog
          onClose={() => setCreateOpen(false)}
          onCreate={async (input) => {
            const parsed = input.when ? parseRelativeDate(input.when) : null;
            const r = await data.createTask({
              what: input.what,
              when_due: parsed?.ts,
              priority: input.priority,
              assigned_to: input.assigned_to || undefined,
              context: input.context || undefined,
            });
            if (r.ok) {
              setToast({ text: `Created task "${r.task.what}".`, tone: "ok" });
              return true;
            }
            setToast({ text: r.message, tone: "warn" });
            return false;
          }}
        />
      )}

      {toast && (
        <div role="status" aria-live="polite" className="v2-tasks__toast" data-tone={toast.tone}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

export function TasksRoom() {
  return (
    <RoomShell
      title="Tasks"
      subtitle="kanban · due dates · priority"
      breadcrumb={["Tasks"]}
    >
      <TasksRoomBody mode="expanded" />
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
  tone?: "neutral" | "ok" | "warn" | "accent";
}) {
  return (
    <div className="v2-tasks__stat" data-tone={tone ?? "neutral"}>
      <div className="v2-tasks__stat-label">{label}</div>
      <div className="v2-tasks__stat-value">{value}</div>
      <div className="v2-tasks__stat-sub">{sub}</div>
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
    <div className="v2-tasks__filter-row" role="tablist" aria-label={`Filter by ${label}`}>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className="v2-tasks__filter-btn"
          data-active={value === opt}
          onClick={() => onChange(opt)}
        >
          {opt.replace(/_/g, " ")}
        </button>
      ))}
    </div>
  );
}

/* ─────────── Kanban view ─────────── */

function Kanban({
  tasksByStatus,
  loading,
  onComplete,
  onFail,
  onPriority,
}: {
  tasksByStatus: Map<TaskStatus, Task[]>;
  loading: boolean;
  onComplete: (id: string) => void;
  onFail: (id: string) => void;
  onPriority: (id: string, level: TaskPriority) => void;
}) {
  if (loading && Array.from(tasksByStatus.values()).every((arr) => arr.length === 0)) {
    return <div className="v2-tasks__empty">Loading tasks…</div>;
  }

  return (
    <div className="v2-tasks__kanban">
      {TASK_STATUSES.map((status) => {
        const tasks = tasksByStatus.get(status) ?? [];
        return (
          <Column
            key={status}
            status={status}
            tasks={tasks}
            onComplete={onComplete}
            onFail={onFail}
            onPriority={onPriority}
          />
        );
      })}
    </div>
  );
}

function Column({
  status,
  tasks,
  onComplete,
  onFail,
  onPriority,
}: {
  status: TaskStatus;
  tasks: Task[];
  onComplete: (id: string) => void;
  onFail: (id: string) => void;
  onPriority: (id: string, level: TaskPriority) => void;
}) {
  return (
    <section className="v2-tasks__col" data-status={status}>
      <header className="v2-tasks__col-head">
        <span className="v2-tasks__col-label">{STATUS_LABEL[status]}</span>
        <span className="v2-tasks__col-count">{tasks.length}</span>
      </header>
      {tasks.length === 0 ? (
        <div className="v2-tasks__col-empty">—</div>
      ) : (
        <ul className="v2-tasks__col-list">
          {tasks.map((t) => (
            <li key={t.id}>
              <TaskCard
                task={t}
                onComplete={() => onComplete(t.id)}
                onFail={() => onFail(t.id)}
                onPriority={(p) => onPriority(t.id, p)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskCard({
  task,
  onComplete,
  onFail,
  onPriority,
}: {
  task: Task;
  onComplete: () => void;
  onFail: () => void;
  onPriority: (p: TaskPriority) => void;
}) {
  const isTerminal = task.status === "completed" || task.status === "failed";
  const isOverdue =
    !isTerminal && task.when_due !== null && task.when_due < Date.now();
  return (
    <article
      className="v2-tasks__card"
      data-priority={task.priority}
      data-overdue={isOverdue}
    >
      <div className="v2-tasks__card-head">
        <span className="v2-tasks__pip" data-priority={task.priority} aria-hidden="true" />
        <span className="v2-tasks__card-what">{task.what}</span>
      </div>
      {task.context && <div className="v2-tasks__card-context">{task.context}</div>}
      <div className="v2-tasks__card-meta">
        {task.when_due && (
          <span className="v2-tasks__card-due" data-overdue={isOverdue}>
            <Icon icon={Clock} size="sm" />
            {formatDue(task.when_due)}
          </span>
        )}
        {task.assigned_to && (
          <span className="v2-tasks__card-assignee">{task.assigned_to}</span>
        )}
        <Chip tone={PRIORITY_TONE[task.priority]} dot>
          {task.priority}
        </Chip>
      </div>
      {!isTerminal && (
        <div className="v2-tasks__card-actions">
          <select
            className="v2-tasks__priority-select"
            value={task.priority}
            onChange={(e) => onPriority(e.target.value as TaskPriority)}
            aria-label="Set priority"
            title="Set priority"
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="v2-tasks__icon-btn"
            onClick={onFail}
            aria-label="Mark failed"
            title="Mark failed"
          >
            <Icon icon={XCircle} size="sm" />
          </button>
          <button
            type="button"
            className="v2-tasks__icon-btn v2-tasks__icon-btn--primary"
            onClick={onComplete}
            aria-label="Mark complete"
            title="Mark complete"
          >
            <Icon icon={Check} size="sm" />
          </button>
        </div>
      )}
      {task.result && (
        <div className="v2-tasks__card-result">
          <span className="v2-tasks__card-result-label">Result</span>
          {task.result}
        </div>
      )}
    </article>
  );
}

/* ─────────── List view ─────────── */

function ListView({
  tasks,
  loading,
  onComplete,
  onFail,
}: {
  tasks: Task[];
  loading: boolean;
  onComplete: (id: string) => void;
  onFail: (id: string) => void;
}) {
  if (loading && tasks.length === 0) {
    return <div className="v2-tasks__empty">Loading tasks…</div>;
  }
  if (tasks.length === 0) {
    return <div className="v2-tasks__empty">No tasks match the current filters.</div>;
  }
  return (
    <ul className="v2-tasks__list" role="list">
      {tasks.map((t) => {
        const isTerminal = t.status === "completed" || t.status === "failed";
        const isOverdue =
          !isTerminal && t.when_due !== null && t.when_due < Date.now();
        return (
          <li key={t.id} className="v2-tasks__list-row" data-overdue={isOverdue}>
            <span className="v2-tasks__pip" data-priority={t.priority} aria-hidden="true" />
            <span className="v2-tasks__list-what">{t.what}</span>
            {t.when_due && (
              <span className="v2-tasks__list-due" data-overdue={isOverdue}>
                {formatDue(t.when_due)}
              </span>
            )}
            <Chip tone={PRIORITY_TONE[t.priority]} dot>
              {t.priority}
            </Chip>
            <Chip tone={STATUS_TONE[t.status]} dot>
              {t.status}
            </Chip>
            {t.assigned_to && (
              <span className="v2-tasks__list-assignee">{t.assigned_to}</span>
            )}
            {!isTerminal && (
              <div className="v2-tasks__list-actions">
                <button
                  type="button"
                  className="v2-tasks__icon-btn"
                  onClick={() => onFail(t.id)}
                  aria-label="Mark failed"
                >
                  <Icon icon={XCircle} size="sm" />
                </button>
                <button
                  type="button"
                  className="v2-tasks__icon-btn v2-tasks__icon-btn--primary"
                  onClick={() => onComplete(t.id)}
                  aria-label="Mark complete"
                >
                  <Icon icon={Check} size="sm" />
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ─────────── Create dialog ─────────── */

function CreateDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: {
    what: string;
    when?: string;
    priority?: TaskPriority;
    assigned_to?: string;
    context?: string;
  }) => Promise<boolean>;
}) {
  const [what, setWhat] = useState("");
  const [when, setWhen] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [assignedTo, setAssignedTo] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => (when.trim() ? parseRelativeDate(when) : null), [when]);

  const submit = async () => {
    if (!what.trim()) return;
    setBusy(true);
    const ok = await onCreate({
      what: what.trim(),
      when: when.trim() || undefined,
      priority,
      assigned_to: assignedTo.trim() || undefined,
      context: context.trim() || undefined,
    });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div className="v2-tasks__overlay" onClick={() => !busy && onClose()}>
      <div
        className="v2-tasks__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="v2-tasks-create-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="v2-tasks__dialog-head">
          <div>
            <div id="v2-tasks-create-title" className="v2-tasks__dialog-title">
              New task
            </div>
            <div className="v2-tasks__dialog-subtitle">
              Quick create — appears in the Pending column.
            </div>
          </div>
          <button
            type="button"
            className="v2-tasks__icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <Icon icon={X} size="sm" />
          </button>
        </div>

        <div className="v2-tasks__dialog-body">
          <label className="v2-tasks__field">
            <span className="v2-tasks__field-label">Task</span>
            <input
              type="text"
              className="v2-tasks__input"
              value={what}
              onChange={(e) => setWhat(e.target.value)}
              placeholder="What needs to happen?"
              autoFocus
            />
          </label>

          <label className="v2-tasks__field">
            <span className="v2-tasks__field-label">When (optional)</span>
            <input
              type="text"
              className="v2-tasks__input"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              placeholder="e.g. tomorrow at 3pm, friday, in 2 days"
            />
            <span className="v2-tasks__field-hint">
              {when.trim()
                ? parsed
                  ? `→ ${formatFullDate(parsed.ts)}`
                  : "Couldn't parse — task will have no due date."
                : "Leave blank for an undated task."}
            </span>
          </label>

          <label className="v2-tasks__field">
            <span className="v2-tasks__field-label">Priority</span>
            <div className="v2-tasks__chip-row">
              {TASK_PRIORITIES.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="v2-tasks__chip"
                  data-active={priority === p}
                  onClick={() => setPriority(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </label>

          <label className="v2-tasks__field">
            <span className="v2-tasks__field-label">Assignee (optional)</span>
            <input
              type="text"
              className="v2-tasks__input"
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
              placeholder="you / jarvis / agent name"
            />
          </label>

          <label className="v2-tasks__field">
            <span className="v2-tasks__field-label">Context (optional)</span>
            <textarea
              className="v2-tasks__textarea"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={2}
              placeholder="Background or notes."
            />
          </label>
        </div>

        <div className="v2-tasks__dialog-foot">
          <button
            type="button"
            className="v2-tasks__btn v2-tasks__btn--secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="v2-tasks__btn v2-tasks__btn--primary"
            onClick={submit}
            disabled={busy || !what.trim()}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────── helpers ─────────── */

function formatDue(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const dayStart = new Date(d);
  dayStart.setHours(0, 0, 0, 0);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (dayStart.getTime() === today.getTime()) return `Today ${time}`;
  if (dayStart.getTime() === tomorrow.getTime()) return `Tomorrow ${time}`;
  if (ts < now.getTime()) {
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} (overdue)`;
  }
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatFullDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// silence unused-import lints
void AlertTriangle;
void CheckSquare;
