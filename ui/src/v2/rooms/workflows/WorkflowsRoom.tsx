import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { Chip, Icon } from "../../ui";
import { RoomShell } from "../RoomShell";
import { useRoomActions } from "../useRoomActionBus";
import { useRovingTabs } from "../useRovingTabs";
import { useLiveData } from "../../shell/LiveDataContext";
import {
  useWorkflowsData,
  type Workflow,
  type WorkflowFilter,
} from "./useWorkflowsData";
import WorkflowCanvas from "../../../components/workflows/WorkflowCanvas";
import AgentBuilderView from "../../../components/office/AgentBuilderView";
// Pull legacy CSS so embedded WorkflowCanvas + AgentBuilderView render correctly.
import "../../../styles/workflows.css";
import "../../../styles/agents.css";
import "./WorkflowsRoom.css";

type TabId = "list" | "editor" | "builder";

const FILTER_ORDER: WorkflowFilter[] = ["all", "active", "paused"];
const FILTER_LABEL: Record<WorkflowFilter, string> = {
  all: "All",
  active: "Active",
  paused: "Paused",
};

const TAB_LABEL: Record<TabId, string> = {
  list: "List",
  editor: "Editor",
  builder: "Agent Builder",
};

const TAB_ICON: Record<TabId, LucideIcon> = {
  list: Network,
  editor: Sparkles,
  builder: Network,
};

export type RoomBodyMode = "inline" | "expanded";

/**
 * Workflows Room — three-tab surface (List / Editor / Agent Builder).
 *
 * - List: roster + filters + per-row actions; selecting flips to Editor.
 * - Editor: embeds the existing legacy WorkflowCanvas (xyflow) inside a
 *   v2 chrome bar. Empty state when no workflow selected.
 * - Agent Builder: relocated from Phase 6.3 (legacy SVG canvas, ephemeral
 *   state, no daemon persistence per legacy beta behavior).
 *
 * Inline mode collapses to the List tab only — the Editor + Builder canvases
 * need real estate that an inline RoomWindow can't comfortably provide.
 */
export function WorkflowsRoomBody({ mode }: { mode: RoomBodyMode }) {
  const data = useWorkflowsData();
  const live = useLiveData();
  const [activeTab, setActiveTab] = useState<TabId>("list");
  const TAB_KEYS = useMemo(() => Object.keys(TAB_LABEL) as TabId[], []);
  const tabsApi = useRovingTabs<TabId>(TAB_KEYS, activeTab, setActiveTab, "v2-wf");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<WorkflowFilter>("all");
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  // Auto-clear toasts.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const filteredWorkflows = useMemo(() => {
    let list = data.workflows;
    if (filter === "active") list = list.filter((w) => w.enabled);
    else if (filter === "paused") list = list.filter((w) => !w.enabled);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (w) =>
          w.name.toLowerCase().includes(q) ||
          w.description.toLowerCase().includes(q) ||
          w.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [data.workflows, search, filter]);

  const selectedWorkflow = useMemo(
    () => (selectedId ? data.workflows.find((w) => w.id === selectedId) ?? null : null),
    [data.workflows, selectedId],
  );

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setActiveTab("editor");
  }, []);

  const handleRun = useCallback(
    async (id: string) => {
      const r = await data.execute(id);
      setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
    },
    [data],
  );

  const handleTogglePause = useCallback(
    async (wf: Workflow) => {
      const r = await data.setEnabled(wf.id, !wf.enabled);
      setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
    },
    [data],
  );

  const handleCreate = useCallback(async () => {
    const name = window.prompt("Workflow name:");
    if (!name?.trim()) return;
    setCreating(true);
    const r = await data.create(name.trim());
    setCreating(false);
    if (r.ok) {
      setToast({ text: `Created "${r.workflow.name}".`, tone: "ok" });
      handleSelect(r.workflow.id);
    } else {
      setToast({ text: r.message, tone: "warn" });
    }
  }, [data, handleSelect]);

  /**
   * Voice path: create a workflow from a natural-language prompt.
   *
   * Two flows:
   *  - With prompt → POST /api/workflows/nl-create (single LLM call,
   *    purpose-built `parseDescription` returns a full definition that
   *    gets persisted as v1). User lands in the editor with a populated
   *    graph, not a trigger-only stub.
   *  - Empty prompt → POST /api/workflows (existing trigger-only path)
   *    so "just make a new empty workflow" still works.
   *
   * The earlier two-step "create then nl-chat" path produced empty graphs
   * because /nl-chat's chat() is biased toward Q&A unless the user
   * explicitly says "add/remove/modify". parseDescription() doesn't have
   * that ambiguity.
   */
  const createFromNl = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      setCreating(true);

      try {
        if (!trimmed) {
          // Blank workflow path — same as the legacy create flow.
          const blankName = `Workflow ${formatHHMM(Date.now())}`;
          const created = await data.create(blankName);
          if (!created.ok) {
            setToast({ text: created.message, tone: "warn" });
            return;
          }
          handleSelect(created.workflow.id);
          setToast({ text: `Created "${created.workflow.name}".`, tone: "ok" });
          return;
        }

        // Populated workflow path.
        const name = deriveWorkflowName(trimmed);
        const resp = await fetch("/api/workflows/nl-create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            description: trimmed,
            prompt: trimmed,
          }),
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(text || `HTTP ${resp.status}`);
        }
        const body = (await resp.json()) as {
          workflow: Workflow;
          version: { version: number };
        };
        // Refresh list so the new workflow appears, then jump to editor.
        data.refresh();
        handleSelect(body.workflow.id);
        setToast({
          text: `Created "${body.workflow.name}" with the steps from your prompt.`,
          tone: "ok",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "NL create failed";
        setToast({
          text: `Couldn't build the workflow: ${msg}`,
          tone: "warn",
        });
      } finally {
        setCreating(false);
      }
    },
    [data, handleSelect],
  );

  // Phase 6.3.5 — voice-driven Room actions for Workflows.
  useRoomActions("workflows", (action, args) => {
    switch (action) {
      case "switch_tab": {
        const t = String(args.tab);
        if (t === "list" || t === "editor" || t === "builder" || t === "agent_builder") {
          setActiveTab(t === "agent_builder" ? "builder" : (t as TabId));
          return true;
        }
        return false;
      }
      case "search":
        setSearch(typeof args.query === "string" ? args.query : "");
        setActiveTab("list");
        return true;
      case "set_filter": {
        const f = String(args.filter);
        if (f === "all" || f === "active" || f === "paused") {
          setFilter(f);
          setActiveTab("list");
          return true;
        }
        return false;
      }
      case "select": {
        const name = typeof args.name === "string" ? args.name : "";
        const wf = data.findByName(name);
        if (!wf) return false;
        handleSelect(wf.id);
        return true;
      }
      case "run": {
        const name = typeof args.name === "string" ? args.name : "";
        const wf = name ? data.findByName(name) : selectedWorkflow;
        if (!wf) return false;
        handleRun(wf.id);
        return true;
      }
      case "pause": {
        const name = typeof args.name === "string" ? args.name : "";
        const wf = name ? data.findByName(name) : selectedWorkflow;
        if (!wf) return false;
        if (!wf.enabled) {
          setToast({ text: `${wf.name} is already paused.`, tone: "ok" });
          return true;
        }
        handleTogglePause(wf);
        return true;
      }
      case "enable": {
        const name = typeof args.name === "string" ? args.name : "";
        const wf = name ? data.findByName(name) : selectedWorkflow;
        if (!wf) return false;
        if (wf.enabled) {
          setToast({ text: `${wf.name} is already active.`, tone: "ok" });
          return true;
        }
        handleTogglePause(wf);
        return true;
      }
      case "create_from_nl": {
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        // Fire-and-forget so the synchronous handler can still return true.
        // The async chain creates a workflow then pushes the prompt
        // through the NL builder so the user gets a populated definition,
        // not an empty trigger-only graph.
        void createFromNl(prompt);
        return true;
      }
      default:
        return false;
    }
  });

  // Live event ping count, for the header stat.
  const recentEvents = live ? 0 : 0;
  void recentEvents;

  return (
    <div className={`v2-wf v2-wf--${mode}`}>
      {/* Stats — both modes */}
      <div className="v2-wf__stats">
        <StatCard label="Total" value={data.stats.total} sub={`${data.stats.active} active · ${data.stats.paused} paused`} />
        <StatCard label="Total runs" value={data.stats.executions.toLocaleString()} sub="across all workflows" />
        <StatCard
          label="Active"
          value={data.stats.active}
          sub={`${data.stats.total > 0 ? Math.round((data.stats.active / data.stats.total) * 100) : 0}% of total`}
        />
        <StatCard label="Selected" value={selectedWorkflow ? `v${selectedWorkflow.current_version}` : "—"} sub={selectedWorkflow?.name ?? "no selection"} />
      </div>

      {/* Tabs — expanded only */}
      {mode === "expanded" && (
        <div
          className="v2-wf__tabs"
          role="tablist"
          aria-label="Workflows view"
          ref={tabsApi.tablistRef}
        >
          {TAB_KEYS.map((t) => (
            <button
              key={t}
              type="button"
              className="v2-wf__tab"
              data-active={activeTab === t}
              {...tabsApi.getTabProps(t)}
            >
              <Icon icon={TAB_ICON[t]} size="sm" />
              <span>{TAB_LABEL[t]}</span>
              {t === "list" && (
                <span className="v2-wf__tab-badge">{filteredWorkflows.length}</span>
              )}
              {t === "editor" && selectedWorkflow && (
                <span className="v2-wf__tab-badge">{selectedWorkflow.name.slice(0, 18)}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Toolbar — only on list tab */}
      {(mode === "inline" || activeTab === "list") && (
        <div className="v2-wf__toolbar">
          <div className="v2-wf__search">
            <Icon icon={Search} size="sm" />
            <input
              className="v2-wf__search-input"
              type="text"
              placeholder="Search workflows…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search workflows"
            />
          </div>
          <div className="v2-wf__filter-row" role="tablist" aria-label="Filter by status">
            {FILTER_ORDER.map((f) => (
              <button
                key={f}
                type="button"
                className="v2-wf__filter-btn"
                data-active={filter === f}
                onClick={() => setFilter(f)}
                role="tab"
                aria-selected={filter === f}
              >
                {FILTER_LABEL[f]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="v2-wf__refresh"
            onClick={data.refresh}
            aria-label="Refresh"
            title="Refresh"
          >
            <Icon icon={RefreshCw} size="sm" />
          </button>
          <button
            type="button"
            className="v2-wf__new-btn"
            onClick={handleCreate}
            disabled={creating}
          >
            <Icon icon={Plus} size="sm" />
            New
          </button>
        </div>
      )}

      {data.error && <div className="v2-wf__error">{data.error}</div>}

      {/* Content */}
      {(mode === "inline" || activeTab === "list") && (
        <ListTab
          workflows={filteredWorkflows}
          loading={data.loading}
          onSelect={handleSelect}
          onRun={handleRun}
          onTogglePause={handleTogglePause}
        />
      )}

      {mode === "expanded" && activeTab === "editor" && (
        <EditorTab workflow={selectedWorkflow} />
      )}

      {mode === "expanded" && activeTab === "builder" && <BuilderTab />}

      {toast && (
        <div role="status" aria-live="polite" className="v2-wf__toast" data-tone={toast.tone}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

/** Overlay-mode wrapper — direct URL / palette Shift+Enter / explicit "expand". */
export function WorkflowsRoom() {
  return (
    <RoomShell
      title="Workflows"
      subtitle="list · editor · agent builder"
      breadcrumb={["Workflows"]}
    >
      <WorkflowsRoomBody mode="expanded" />
    </RoomShell>
  );
}

/* ─────────── Subcomponents ─────────── */

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: number | string;
  sub: string;
}) {
  return (
    <div className="v2-wf__stat">
      <div className="v2-wf__stat-label">{label}</div>
      <div className="v2-wf__stat-value">{value}</div>
      <div className="v2-wf__stat-sub">{sub}</div>
    </div>
  );
}

function ListTab({
  workflows,
  loading,
  onSelect,
  onRun,
  onTogglePause,
}: {
  workflows: Workflow[];
  loading: boolean;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
  onTogglePause: (wf: Workflow) => void;
}) {
  if (loading && workflows.length === 0) {
    return <div className="v2-wf__empty">Loading workflows…</div>;
  }
  if (workflows.length === 0) {
    return (
      <div className="v2-wf__empty">
        No workflows match the current filter. Use <strong>New</strong> to create one.
      </div>
    );
  }
  return (
    <ul className="v2-wf__list" role="list">
      {workflows.map((wf) => (
        <WorkflowRow
          key={wf.id}
          workflow={wf}
          onSelect={onSelect}
          onRun={onRun}
          onTogglePause={onTogglePause}
        />
      ))}
    </ul>
  );
}

function WorkflowRow({
  workflow,
  onSelect,
  onRun,
  onTogglePause,
}: {
  workflow: Workflow;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
  onTogglePause: (wf: Workflow) => void;
}) {
  const lastRun = workflow.last_executed_at
    ? formatRelative(workflow.last_executed_at)
    : "never";
  return (
    <li className="v2-wf__row" data-active={workflow.enabled}>
      <button
        type="button"
        className="v2-wf__row-main"
        onClick={() => onSelect(workflow.id)}
      >
        <span className="v2-wf__row-name">{workflow.name}</span>
        {workflow.description && (
          <span className="v2-wf__row-desc">{workflow.description}</span>
        )}
        <span className="v2-wf__row-meta">
          v{workflow.current_version} · {workflow.execution_count} runs · last: {lastRun}
          {workflow.tags.length > 0 && <> · {workflow.tags.join(", ")}</>}
        </span>
      </button>
      <Chip tone={workflow.enabled ? "ok" : "neutral"} dot>
        {workflow.enabled ? "Active" : "Paused"}
      </Chip>
      <button
        type="button"
        className="v2-wf__row-action"
        onClick={(e) => {
          e.stopPropagation();
          onTogglePause(workflow);
        }}
        aria-label={workflow.enabled ? "Pause workflow" : "Enable workflow"}
        title={workflow.enabled ? "Pause" : "Enable"}
      >
        <Icon icon={workflow.enabled ? Pause : Play} size="sm" />
      </button>
      <button
        type="button"
        className="v2-wf__row-action v2-wf__row-action--primary"
        onClick={(e) => {
          e.stopPropagation();
          onRun(workflow.id);
        }}
        aria-label="Run workflow"
        title="Run now"
      >
        <Icon icon={Play} size="sm" />
        Run
      </button>
    </li>
  );
}

function EditorTab({ workflow }: { workflow: Workflow | null }) {
  const live = useLiveData();
  // workflow_event isn't lifted into LiveDataContext yet — ExecutionMonitor
  // also subscribes to /api/workflows/:id/executions REST, so the canvas
  // remains functional. We pass an empty array; the canvas will animate
  // edges only on REST-backed completion, not live WS.
  const workflowEvents = useRef<never[]>([]).current;
  void live;

  if (!workflow) {
    return (
      <div className="v2-wf__editor-empty">
        <Icon icon={Sparkles} size="lg" />
        <h3>No workflow selected</h3>
        <p>Pick one from the List tab to open it in the editor.</p>
      </div>
    );
  }

  return (
    <div className="v2-wf__editor">
      <div className="v2-wf__editor-head">
        <span className="v2-wf__editor-title">{workflow.name}</span>
        <Chip tone={workflow.enabled ? "ok" : "neutral"} dot>
          {workflow.enabled ? "Active" : "Paused"}
        </Chip>
        <span className="v2-wf__editor-version">v{workflow.current_version}</span>
        <span className="v2-wf__editor-runs">{workflow.execution_count} runs</span>
      </div>
      <div className="v2-wf__editor-canvas">
        <WorkflowCanvas
          workflowId={workflow.id}
          workflowEvents={workflowEvents as never}
          sendMessage={() => {/* legacy chat hook unused inside Room */}}
        />
      </div>
    </div>
  );
}

function BuilderTab() {
  return (
    <div className="v2-wf__builder">
      <AgentBuilderView />
    </div>
  );
}

/* ─────────── helpers ─────────── */

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  return `${day}d ago`;
}

function formatHHMM(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Derive a short, sentence-cased workflow name from a free-form NL prompt.
 * Drops common stopwords up front ("create / make / a / new / workflow /
 * that / which") so "create a workflow that checks AI news every morning"
 * collapses to "Checks AI news every morning". Capped at ~50 chars.
 */
function deriveWorkflowName(prompt: string): string {
  const cleaned = prompt
    .trim()
    .replace(
      /^\s*(?:please\s+)?(?:can\s+you\s+)?(?:just\s+)?(?:make|create|build|set\s*up|add)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:workflow\s+)?(?:that\s+|which\s+|to\s+)?/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "New workflow";
  const capped = cleaned.slice(0, 50).replace(/[.,;!?\s]+$/, "");
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

// silence unused-import lints
void X;
