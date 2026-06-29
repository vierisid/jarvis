import React, { useCallback, useMemo, useRef, useState } from "react";
import { openRoom, type RoomKey } from "../router";
import { useLiveData, type LiveData } from "./LiveDataContext";
import type { ConnectionState } from "./Header";

/**
 * Now — the home surface you compose. A grid of widgets, each a room's
 * headline. Arrange enters editing: drag to reorder, resize between half
 * and full width, remove, or add from the catalog (one+ widget per room).
 * Layout (order + sizes + which are present) persists per user.
 *
 * waiting-on-you can't be removed while it's amber — safety outranks taste.
 */

type WSize = 1 | 2;
type LayoutItem = { id: string; size: WSize };
type RenderCtx = { live: LiveData; onApprove: (id: string) => void; onCancel: (id: string) => void };
type WidgetDef = {
  id: string;
  group: "run" | "know" | "guard" | "build" | "system";
  dot?: string;
  desc: string;
  defaultSize: WSize;
  render: (ctx: RenderCtx) => React.ReactNode;
};

const LAYOUT_KEY = "jarvis-now-layout-v2";

function rel(ts: number): string {
  const d = Date.now() - ts;
  if (d < 0) return "";
  const m = Math.floor(d / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/* ── shared header + empty-state helpers ── */
function WHeader({ label, room, tone }: { label: string; room?: RoomKey; tone?: "hold" }) {
  return (
    <div className={`rs-ch${tone ? " " + tone : ""}`}>
      {label}
      {room && <button className="lnk" onClick={() => openRoom(room)}>{room} →</button>}
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rs-empty">{children}</div>;
}
function Row({ dot, room, children, tm }: { dot: string; room: RoomKey; children: React.ReactNode; tm?: string }) {
  return (
    <button className="rs-row" onClick={() => openRoom(room)}>
      <span className="rs-dot" style={{ background: dot }} />
      <span className="tx">{children}</span>
      {tm != null && <span className="tm">{tm}</span>}
    </button>
  );
}

/* ── live data shaping ── */
function agentRows(live: LiveData) {
  const byAgent = new Map<string, { name: string; what: string; ts: number; running: boolean }>();
  for (const e of live.agentActivity) {
    const what = e.eventType === "tool_call" ? "running a tool" : e.eventType === "done" ? "finished" : "working";
    byAgent.set(e.agentName, { name: e.agentName, what, ts: e.timestamp, running: e.eventType !== "done" });
  }
  return [...byAgent.values()].sort((a, b) => b.ts - a.ts).slice(0, 4);
}
function todayRows(live: LiveData) {
  const rows: { id: string; dot: string; text: string; ts: number }[] = [];
  for (const t of live.taskEvents) rows.push({ id: `t${t.task.id}${t.timestamp}`, dot: t.task.status === "done" ? "var(--ok)" : "var(--speak)", text: t.task.what, ts: t.timestamp });
  for (const c of live.contentEvents) rows.push({ id: `c${c.item.id}${c.timestamp}`, dot: "var(--ok)", text: `${c.item.title} · ${c.item.stage}`, ts: c.timestamp });
  for (const n of live.notices) rows.push({ id: `n${n.id}`, dot: "var(--listen)", text: n.title, ts: Date.now() });
  return rows.sort((a, b) => b.ts - a.ts).slice(0, 5);
}
function taskRows(live: LiveData) {
  const seen = new Map<string, { id: string; what: string; status: string; due: number | null }>();
  for (const t of live.taskEvents) {
    if (t.action === "deleted") { seen.delete(t.task.id); continue; }
    if (t.task.status !== "done") seen.set(t.task.id, { id: t.task.id, what: t.task.what, status: t.task.status, due: t.task.when_due });
  }
  return [...seen.values()].slice(0, 4);
}

/* ── the widget catalog — one+ per room, broadly composable ── */
const WIDGETS: Record<string, WidgetDef> = {
  "right-now": {
    id: "right-now", group: "run", dot: "var(--speak)", desc: "Active agents and what each is doing.", defaultSize: 1,
    render: ({ live }) => {
      const a = agentRows(live);
      return (<><WHeader label="right now" room="agents" />
        {a.length ? a.map((x) => <Row key={x.name} dot={x.running ? "var(--speak)" : "var(--faint)"} room="agents" tm={rel(x.ts)}><b>{x.name}</b> · {x.what}</Row>)
          : <Empty>Nothing running yet. Say <b>“Hey Jarvis”</b> and hand it something, or start in <b>Workflows</b>.</Empty>}</>);
    },
  },
  waiting: {
    id: "waiting", group: "guard", dot: "var(--hold)", desc: "Pending approvals, resolvable in place. Pins to the top while amber.", defaultSize: 1,
    render: ({ live, onApprove, onCancel }) => (<><WHeader label={`waiting on you · ${live.approvals.length}`} room="authority" tone="hold" />
      {live.approvals.length ? live.approvals.slice(0, 3).map((a) => (
        <div className="rs-apr" key={a.id}>
          <div className="t1"><span className="rs-dot" />{a.category} · {a.toolName}</div>
          <div className="t2">{a.intent}</div>
          <div className="bs"><button className="b1" onClick={() => onApprove(a.id)}>Yes · approve</button><button className="b2" onClick={() => onCancel(a.id)}>Cancel</button></div>
        </div>
      )) : <Empty>Approvals land here when an action needs your yes. <span className="dim">Nothing waits right now.</span></Empty>}</>),
  },
  today: {
    id: "today", group: "guard", dot: "var(--ok)", desc: "Runs and outcomes since midnight, tones included.", defaultSize: 2,
    render: ({ live }) => {
      const r = todayRows(live);
      return (<><WHeader label="today" room="logs" />
        {r.length ? r.map((x) => <Row key={x.id} dot={x.dot} room="logs" tm={rel(x.ts)}>{x.text}</Row>)
          : <Empty>Day one. The first morning brief is scheduled for <b>07:00 tomorrow</b>; it will report here.</Empty>}</>);
    },
  },
  calendar: {
    id: "calendar", group: "know", dot: "var(--faint)", desc: "The next two commitments, holds, or focus blocks.", defaultSize: 1,
    render: () => (<><WHeader label="calendar · next" room="calendar" /><Empty>No commitments tracked yet. <span className="dim">Connect a calendar in Settings.</span></Empty></>),
  },
  vitals: {
    id: "vitals", group: "system", dot: "var(--faint)", desc: "Agents active, approvals waiting, events today.", defaultSize: 1,
    render: ({ live }) => {
      const active = agentRows(live).filter((a) => a.running).length;
      return (<><WHeader label="vitals" /><div className="rs-vit">
        <div className="v"><span className="k">agents</span><div className="n">{active}<span> active</span></div></div>
        <div className="v"><span className="k">waiting</span><div className="n">{live.approvals.length}</div></div>
        <div className="v"><span className="k">events</span><div className="n">{todayRows(live).length}<span> today</span></div></div>
      </div></>);
    },
  },
  "tasks-due": {
    id: "tasks-due", group: "run", dot: "var(--faint)", desc: "Due today and overdue, priority-toned.", defaultSize: 1,
    render: ({ live }) => {
      const t = taskRows(live);
      return (<><WHeader label="tasks · due" room="tasks" />
        {t.length ? t.map((x) => <Row key={x.id} dot={x.status === "in_progress" ? "var(--speak)" : "var(--faint)"} room="tasks" tm={x.due ? rel(x.due) : ""}>{x.what}</Row>)
          : <Empty>No open tasks. <span className="dim">Ask Jarvis to track one, or add it in Tasks.</span></Empty>}</>);
    },
  },
  "agents-roster": {
    id: "agents-roster", group: "run", dot: "var(--speak)", desc: "The full roster and delegation depth.", defaultSize: 1,
    render: ({ live }) => {
      const a = agentRows(live);
      return (<><WHeader label="agents · roster" room="agents" />
        {a.length ? a.map((x) => <Row key={x.name} dot={x.running ? "var(--speak)" : "var(--ok)"} room="agents" tm={x.running ? "live" : ""}><b>{x.name}</b></Row>)
          : <Empty>Specialist agents appear here once they run. <span className="dim">Open Agents to see the roster.</span></Empty>}</>);
    },
  },
  goals: {
    id: "goals", group: "know", dot: "var(--ok)", desc: "Objectives with their health tones; amber earns a place.", defaultSize: 1,
    render: () => (<><WHeader label="goals · health" room="goals" /><Empty>No goals set yet. <span className="dim">Define objectives in Goals to track them here.</span></Empty></>),
  },
  pipeline: {
    id: "pipeline", group: "know", dot: "var(--faint)", desc: "Cards in review and scheduled; your editorial gate.", defaultSize: 1,
    render: ({ live }) => {
      const c = live.contentEvents.slice(-4).reverse();
      return (<><WHeader label="pipeline" room="content" />
        {c.length ? c.map((x) => <Row key={`${x.item.id}${x.timestamp}`} dot="var(--faint)" room="content" tm={x.item.stage}>{x.item.title}</Row>)
          : <Empty>Nothing in the pipeline. <span className="dim">Draft something in Content.</span></Empty>}</>);
    },
  },
  workflows: {
    id: "workflows", group: "run", dot: "var(--speak)", desc: "Saved automations and their last run.", defaultSize: 1,
    render: () => (<><WHeader label="workflows" room="workflows" /><Empty>Saved automations show their status here. <span className="dim">Open Workflows to build one.</span></Empty></>),
  },
  memory: {
    id: "memory", group: "know", dot: "var(--faint)", desc: "Recently learned facts and entities.", defaultSize: 1,
    render: () => (<><WHeader label="memory · new" room="memory" /><Empty>New facts Jarvis learns surface here. <span className="dim">Browse the vault in Memory.</span></Empty></>),
  },
  "authority-audit": {
    id: "authority-audit", group: "guard", dot: "var(--faint)", desc: "Recent grants and audited actions.", defaultSize: 1,
    render: () => (<><WHeader label="authority · audit" room="authority" /><Empty>The audit trail of approved actions lands here. <span className="dim">Open Authority for the full log.</span></Empty></>),
  },
  "usage-week": {
    id: "usage-week", group: "guard", dot: "var(--faint)", desc: "Token spend by model — the privacy story as numbers.", defaultSize: 1,
    render: () => (<><WHeader label="usage · week" room="usage" /><Empty>Weekly token spend by model appears here. <span className="dim">See the full meter in Usage.</span></Empty></>),
  },
  workspaces: {
    id: "workspaces", group: "build", dot: "var(--faint)", desc: "Dev projects, git status, running servers.", defaultSize: 1,
    render: () => (<><WHeader label="workspaces" room="workspaces" /><Empty>Project dev servers and git status show here. <span className="dim">Open Workspaces.</span></Empty></>),
  },
  tools: {
    id: "tools", group: "build", dot: "var(--faint)", desc: "Capability catalogue and recent calls.", defaultSize: 1,
    render: () => (<><WHeader label="tools" room="tools" /><Empty>The capability catalogue lives in Tools. <span className="dim">Open it to manage flags.</span></Empty></>),
  },
  settings: {
    id: "settings", group: "system", dot: "var(--faint)", desc: "Providers, voice, channels — jump straight in.", defaultSize: 1,
    render: () => (<><WHeader label="settings" room="settings" /><Empty>Providers, voice, and channels. <span className="dim">Open Settings to configure Jarvis.</span></Empty></>),
  },
};

const GROUP_LABEL: Record<WidgetDef["group"], string> = { run: "run", know: "know", guard: "guard", build: "build", system: "system" };
const CATALOG_ORDER = Object.keys(WIDGETS);

const DEFAULT_LAYOUT: LayoutItem[] = [
  { id: "right-now", size: 1 }, { id: "waiting", size: 1 }, { id: "today", size: 2 },
  { id: "calendar", size: 1 }, { id: "vitals", size: 1 },
];

function loadLayout(): LayoutItem[] {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as LayoutItem[];
    const clean = parsed.filter((i) => WIDGETS[i.id]).map((i) => ({ id: i.id, size: (i.size === 2 ? 2 : 1) as WSize }));
    return clean.length ? clean : DEFAULT_LAYOUT;
  } catch { return DEFAULT_LAYOUT; }
}

export function NowRoom({
  connection, arranging, onApprove, onCancel,
}: {
  connection: ConnectionState;
  arranging: boolean;
  onApprove: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const live = useLiveData();
  const [layout, setLayout] = useState<LayoutItem[]>(loadLayout);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const persist = (l: LayoutItem[]) => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch { /* ignore */ } };
  const commit = useCallback((l: LayoutItem[]) => { setLayout(l); persist(l); }, []);

  const offline = connection === "offline";
  const amberPinned = live.approvals.length > 0;

  // waiting-on-you is force-present (and immovable) while amber.
  const items = useMemo(() => {
    let l = layout.filter((i) => WIDGETS[i.id]);
    if (amberPinned && !l.some((i) => i.id === "waiting")) l = [{ id: "waiting", size: 1 }, ...l];
    return l;
  }, [layout, amberPinned]);

  const available = useMemo(() => CATALOG_ORDER.filter((id) => !items.some((i) => i.id === id)), [items]);

  const ctx: RenderCtx = { live, onApprove, onCancel };

  const remove = (id: string) => { if (id === "waiting" && amberPinned) return; commit(layout.filter((i) => i.id !== id)); };
  const resize = (id: string) => commit(layout.map((i) => (i.id === id ? { ...i, size: (i.size === 2 ? 1 : 2) as WSize } : i)));
  const add = (id: string) => { const def = WIDGETS[id]; if (!def) return; commit([...layout, { id, size: def.defaultSize }]); };
  const resetDefault = () => { commit(DEFAULT_LAYOUT); setCatalogOpen(false); };

  // Native drag-reorder: live-reorder as the dragged widget passes over a target.
  const onDragStart = (id: string) => setDragId(id);
  const onDragOver = (e: React.DragEvent, id: string) => {
    if (!dragId) return;
    e.preventDefault();
    setOverId(id);
    if (id === dragId) return;
    setLayout((prev) => {
      const a = [...prev];
      const fi = a.findIndex((x) => x.id === dragId);
      const ti = a.findIndex((x) => x.id === id);
      if (fi < 0 || ti < 0 || fi === ti) return prev;
      const [m] = a.splice(fi, 1);
      if (!m) return prev;
      a.splice(ti, 0, m);
      return a;
    });
  };
  const onDragEnd = () => { setDragId(null); setOverId(null); persist(layoutRef.current); };

  return (
    <div className={`rs-surface${offline ? " dim" : ""}${arranging ? " editing" : ""}`}>
      {offline && (
        <div className="rs-notice">
          <div className="gd2" />
          <div className="t">Waiting for daemon…</div>
          <div className="s">The dashboard can't reach the runtime. Check the service, or start it yourself:</div>
          <span className="mono2">jarvis start</span>
        </div>
      )}

      {items.map((item) => {
        const def = WIDGETS[item.id];
        if (!def) return null;
        const canRemove = !(item.id === "waiting" && amberPinned);
        return (
          <div
            key={item.id}
            className={`rs-wid${item.size === 2 ? " w2" : ""}${dragId === item.id ? " dragging" : ""}${overId === item.id && dragId && dragId !== item.id ? " dragover" : ""}`}
            draggable={arranging}
            onDragStart={() => onDragStart(item.id)}
            onDragOver={(e) => onDragOver(e, item.id)}
            onDragEnd={onDragEnd}
          >
            {arranging && (
              <div className="rs-wtools">
                <button className="rs-wtool" onClick={() => resize(item.id)} title={item.size === 2 ? "Half width" : "Full width"} aria-label={item.size === 2 ? "Half width" : "Full width"}>{item.size === 2 ? "½" : "full"}</button>
                <button className="rs-wtool rm" onClick={() => remove(item.id)} disabled={!canRemove} title={canRemove ? "Remove" : "Can't remove while waiting"} aria-label="Remove widget">✕</button>
              </div>
            )}
            {def.render(ctx)}
          </div>
        );
      })}

      {arranging && !catalogOpen && (
        <button className="rs-addtile" onClick={() => setCatalogOpen(true)}>+ add widget</button>
      )}

      {arranging && catalogOpen && (
        <div className="rs-catalog">
          <div className="rs-catalog-h">widget catalog · each is a room's headline<button className="x" onClick={() => setCatalogOpen(false)}>done</button></div>
          {available.length ? (
            <div className="rs-catalog-grid">
              {available.map((id) => {
                const def = WIDGETS[id];
                if (!def) return null;
                return (
                  <button key={id} className="rs-cwidget" onClick={() => add(id)}>
                    <div className="ct"><span className="rs-dot" style={{ background: def.dot ?? "var(--faint)" }} />{WIDGET_TITLE(id)}<small>{GROUP_LABEL[def.group]} · {def.defaultSize}×</small></div>
                    <div className="cs">{def.desc}</div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="rs-catalog-foot"><span className="none">Every widget is already on your Now.</span></div>
          )}
          <div className="rs-catalog-foot"><button onClick={resetDefault}>restore default layout</button></div>
        </div>
      )}
    </div>
  );
}

/** Human title for a widget id (its first header word group), for the catalog. */
function WIDGET_TITLE(id: string): string {
  const map: Record<string, string> = {
    "right-now": "Right now", waiting: "Waiting on you", today: "Today", calendar: "Calendar · next",
    vitals: "Vitals", "tasks-due": "Tasks · due", "agents-roster": "Agents · roster", goals: "Goals · health",
    pipeline: "Pipeline", workflows: "Workflows", memory: "Memory · new", "authority-audit": "Authority · audit",
    "usage-week": "Usage · week", workspaces: "Workspaces", tools: "Tools", settings: "Settings",
  };
  return map[id] ?? id;
}
