import React, { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import { Icon } from "../../ui";
import { Tabs, StatusChip, EmptyState, Toast, DeepLink, Skeleton, type Tone } from "../../ui/roomkit";
import { RoomShell } from "../RoomShell";
import { openRoom } from "../../router";
import { useRoomActions } from "../useRoomActionBus";
import { parseRelativeDate } from "../../../../../src/voice/parse-date";
import { useCalendarData, type CalendarEvent, type CalendarPriority } from "./useCalendarData";
import "./CalendarRoom.css";

type ViewMode = "week" | "day";

// Tone remap (calendar §05, citing Book 03): active→blue, low→neutral,
// failed/cancelled→red, high→amber, done→green, pending→neutral.
const PRIORITY_TONE: Record<string, Tone> = { critical: "fail", high: "hold", normal: "mut", low: "mut" };
const STATUS_TONE: Record<string, Tone> = { done: "ok", completed: "ok", failed: "fail", cancelled: "fail", active: "run", pending: "mut" };
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type RoomBodyMode = "inline" | "expanded";

export function CalendarRoomBody({ mode }: { mode: RoomBodyMode }) {
  const data = useCalendarData();
  const [view, setView] = useState<ViewMode>("week");
  const [search, setSearch] = useState("");
  const [selectedDayIdx, setSelectedDayIdx] = useState<number>(currentDayIdx);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const filteredEventsByDay = useMemo(() => {
    if (!search.trim()) return data.eventsByDay;
    const q = search.trim().toLowerCase();
    const out = new Map<number, CalendarEvent[]>();
    for (const [k, v] of data.eventsByDay) out.set(k, v.filter((e) => e.title.toLowerCase().includes(q)));
    return out;
  }, [data.eventsByDay, search]);

  const dayEvents = filteredEventsByDay.get(selectedDayIdx) ?? [];
  const tasksForDay = dayEvents.filter((e) => e.type === "commitment");
  const contentForDay = dayEvents.filter((e) => e.type === "content");

  const selectedEvent = useMemo(() => {
    if (!selectedEventId) return null;
    for (const events of data.eventsByDay.values()) {
      const hit = events.find((e) => e.id === selectedEventId);
      if (hit) return hit;
    }
    return null;
  }, [data.eventsByDay, selectedEventId]);

  useRoomActions("calendar", (action, args) => {
    switch (action) {
      case "switch_view": { const v = String(args.view); if (v === "week" || v === "day") { setView(v); return true; } return false; }
      case "search": setSearch(typeof args.query === "string" ? args.query : ""); return true;
      case "select_event": {
        const ev = data.findByTitle(typeof args.title === "string" ? args.title : "");
        if (!ev) return false;
        setSelectedEventId(ev.id);
        const dayIdx = Math.floor((ev.timestamp - data.weekStart) / 86_400_000);
        if (dayIdx >= 0 && dayIdx < 7) setSelectedDayIdx(dayIdx);
        return true;
      }
      case "schedule_event": {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const whenStr = typeof args.when === "string" ? args.when : "";
        if (!title) return false;
        const parsed = whenStr ? parseRelativeDate(whenStr) : null;
        (async () => {
          const r = await data.addEvent({ title, whenMs: parsed?.ts, priority: (args.priority as CalendarPriority) ?? undefined, assigned_to: typeof args.with === "string" ? args.with : undefined });
          if (r.ok && parsed) {
            const offset = Math.round((startOfWeek(parsed.ts) - data.weekStart) / (7 * 86_400_000));
            if (offset !== 0) data.goToWeek(offset);
          }
          setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
        })();
        return true;
      }
      default: return false;
    }
  });

  const dayView = view === "day" && mode === "expanded";

  return (
    <div className={`rk-cal rk-cal--${mode}`} style={{ position: "relative" }}>
      <div className="rk-cal__tool">
        <span className="rk-cal__title">Calendar</span>
        {mode === "expanded" && (
          <Tabs tabs={[{ key: "week", label: "Week" }, { key: "day", label: "Day" }]} active={view} onChange={(k) => setView(k as ViewMode)} />
        )}
        <div className="rk-cal__search">
          <Icon icon={Search} size="sm" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search events…" aria-label="Search events" />
        </div>
        <button className="rk-cal__icbtn" onClick={data.refresh} aria-label="Refresh"><Icon icon={RefreshCw} size="sm" /></button>
        <button className="rk-cal__new" onClick={() => setCreateOpen(true)}>New event</button>
      </div>

      <div className="rk-cal__nav">
        <button className="rk-cal__nb" onClick={() => data.goToWeek(-1)} aria-label="Previous week"><Icon icon={ChevronLeft} size="sm" /></button>
        <button className="rk-cal__nb" onClick={() => data.goToWeek(1)} aria-label="Next week"><Icon icon={ChevronRight} size="sm" /></button>
        <span className="rk-cal__wk">{weekRangeLabel(data.weekStart)}</span>
        <button className="rk-cal__tw" onClick={data.goToToday}>This week</button>
      </div>

      <div className="rk-cal__strip">
        {Array.from({ length: 7 }, (_, i) => (
          <DayCell key={i} idx={i} weekStart={data.weekStart} events={filteredEventsByDay.get(i) ?? []} selected={selectedDayIdx === i} onClick={() => setSelectedDayIdx(i)} />
        ))}
      </div>

      {data.error ? (
        <div className="rk-cal__msg">{data.error}</div>
      ) : data.loading && data.events.length === 0 ? (
        <div style={{ padding: 22, flex: 1 }}><Skeleton lines={6} /></div>
      ) : dayView ? (
        <DayView weekStart={data.weekStart} idx={selectedDayIdx} events={dayEvents} selectedId={selectedEventId} onSelect={setSelectedEventId} selectedEvent={selectedEvent} />
      ) : (
        <div className="rk-cal__body">
          <div className="rk-cal__lanes">
            <Lane label="tasks" shape="task" events={tasksForDay} selectedId={selectedEventId} onSelect={(id) => setSelectedEventId(selectedEventId === id ? null : id)} />
            <Lane label="content" shape="content" events={contentForDay} selectedId={selectedEventId} onSelect={(id) => setSelectedEventId(selectedEventId === id ? null : id)} />
          </div>
          {mode === "expanded" && selectedEvent && (
            <div className="rk-cal__side"><div className="rk-cal__side-inner"><SideDetail event={selectedEvent} onClose={() => setSelectedEventId(null)} /></div></div>
          )}
        </div>
      )}

      {createOpen && (
        <CreateDialog
          onClose={() => setCreateOpen(false)}
          onCreate={async ({ title, when, priority }) => {
            const parsed = when ? parseRelativeDate(when) : null;
            const r = await data.addEvent({ title, whenMs: parsed?.ts, priority });
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
            return r.ok;
          }}
        />
      )}

      {toast && <div className="rk-cal__toast"><Toast tone={toast.tone === "ok" ? "ok" : "hold"}>{toast.text}</Toast></div>}
    </div>
  );
}

export function CalendarRoom() {
  return (
    <RoomShell title="Calendar" subtitle="this week · commitments" breadcrumb={["Calendar"]}>
      <CalendarRoomBody mode="expanded" />
    </RoomShell>
  );
}

/* ── week strip cell ── */
function DayCell({ idx, weekStart, events, selected, onClick }: { idx: number; weekStart: number; events: CalendarEvent[]; selected: boolean; onClick: () => void }) {
  const ts = weekStart + idx * 86_400_000;
  const d = new Date(ts);
  const today = isSameDay(ts, Date.now());
  const overdue = events.some((e) => e.type === "commitment" && (e.status === "pending" || e.status === "active") && e.timestamp < Date.now());
  const dots = events.slice(0, 5);
  const extra = events.length - dots.length;
  return (
    <button className={`rk-cal__cell${selected ? " rk-cal__cell--sel" : ""}${today ? " rk-cal__cell--today" : ""}`} onClick={onClick} aria-current={selected ? "date" : undefined}>
      <span className="rk-cal__cell-top">
        <span className="rk-cal__dow">{DOW[idx]}</span>
        <span className="rk-cal__date">{d.getDate()}</span>
      </span>
      <span className="rk-cal__dots">
        {overdue && <span className="cdot cdot--overdue" />}
        {dots.map((e, i) => <span key={i} className={`cdot${e.type === "content" ? " cdot--content" : ""}`} />)}
        {extra > 0 && <span className="rk-cal__plus">+{extra}</span>}
      </span>
    </button>
  );
}

/* ── week lane ── */
function Lane({ label, shape, events, selectedId, onSelect }: { label: string; shape: "task" | "content"; events: CalendarEvent[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="rk-cal__lane">
      <div className="rk-cal__lh"><span className={`cdot${shape === "content" ? " cdot--content" : ""}`} />{label}<span className="c">{events.length}</span></div>
      <div className="rk-cal__lane-scroll">
        {events.length === 0 ? (
          <div className="rk-cal__lane-empty">Nothing {shape === "task" ? "due" : "scheduled"} this day.</div>
        ) : (
          events.map((e) => <EventCard key={e.id} event={e} selected={selectedId === e.id} onClick={() => onSelect(e.id)} />)
        )}
      </div>
    </div>
  );
}

function EventCard({ event, selected, onClick }: { event: CalendarEvent; selected: boolean; onClick: () => void }) {
  return (
    <button className={`rk-cal__card${selected ? " rk-cal__card--sel" : ""}`} onClick={onClick}>
      <span className="rk-cal__card-time">{formatTime(event.timestamp)}{event.has_due_date === false ? " · on creation date" : ""}</span>
      <span className="rk-cal__card-title">{event.title}</span>
      <span className="rk-cal__card-chips">
        <StatusChip tone={STATUS_TONE[event.status] ?? "mut"}>{event.status}</StatusChip>
        {event.priority && event.type === "commitment" && <StatusChip tone={PRIORITY_TONE[event.priority] ?? "mut"}>{event.priority}</StatusChip>}
        {event.assigned_to && <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink3)" }}>→ {event.assigned_to}</span>}
      </span>
    </button>
  );
}

/* ── side / day detail ── */
function SideDetail({ event, onClose }: { event: CalendarEvent; onClose?: () => void }) {
  const isContent = event.type === "content";
  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <div className="rk-cal__eyebrow">{isContent ? "content" : "task"}</div>
          <div className="rk-cal__side-title">{event.title}</div>
        </div>
        {onClose && <button className="rk-cal__icbtn" onClick={onClose} aria-label="Close"><Icon icon={X} size="sm" /></button>}
      </div>
      <div className="rk-cal__kv"><span className="k">when</span><span className="v">{formatFullDateTime(event.timestamp)}</span></div>
      <div className="rk-cal__kv"><span className="k">{isContent ? "stage" : "status"}</span><span className="v"><StatusChip tone={STATUS_TONE[event.status] ?? "mut"}>{event.status}</StatusChip></span></div>
      {event.priority && !isContent && <div className="rk-cal__kv"><span className="k">priority</span><span className="v"><StatusChip tone={PRIORITY_TONE[event.priority] ?? "mut"}>{event.priority}</StatusChip></span></div>}
      {event.content_type && <div className="rk-cal__kv"><span className="k">type</span><span className="v">{event.content_type}</span></div>}
      {event.assigned_to && <div className="rk-cal__kv"><span className="k">assignee</span><span className="v">{event.assigned_to}</span></div>}
      <div className="rk-cal__acts">
        <DeepLink onClick={() => openRoom(isContent ? "content" : "tasks")}>Open in {isContent ? "Content" : "Tasks"} →</DeepLink>
      </div>
      {event.has_due_date === false && <div className="rk-cal__note">Showing on creation date</div>}
    </>
  );
}

/* ── day hour grid (calendar §03) ── */
const HOURS = Array.from({ length: 15 }, (_, i) => i + 7); // 07:00–21:00
function DayView({ weekStart, idx, events, selectedId, onSelect, selectedEvent }: { weekStart: number; idx: number; events: CalendarEvent[]; selectedId: string | null; onSelect: (id: string) => void; selectedEvent: CalendarEvent | null }) {
  const dayTs = weekStart + idx * 86_400_000;
  const today = isSameDay(dayTs, Date.now());
  const undated = events.filter((e) => e.has_due_date === false);
  const placed = events.filter((e) => e.has_due_date !== false);
  // Events outside the 07:00–21:00 grid still exist — surface them in a tray
  // instead of silently dropping them.
  const offGrid = placed.filter((e) => { const h = new Date(e.timestamp).getHours(); return h < 7 || h > 21; });
  const now = new Date();
  const nowTop = today && now.getHours() >= 7 && now.getHours() <= 21 ? (now.getHours() - 7 + now.getMinutes() / 60) * 44 : null;
  const detail = selectedEvent ?? events[0] ?? null;

  return (
    <div className="rk-cal__day">
      <div className="rk-cal__hours">
        {undated.length > 0 && (
          <div className="rk-cal__tray">
            <span className="rk-cal__tray-lab">due today</span>
            {undated.map((e) => <button key={e.id} className={`rk-cal__card${selectedId === e.id ? " rk-cal__card--sel" : ""}`} style={{ padding: "5px 9px" }} onClick={() => onSelect(e.id)}><span className="rk-cal__card-title" style={{ fontSize: 11.5 }}>{e.title}</span></button>)}
          </div>
        )}
        {offGrid.length > 0 && (
          <div className="rk-cal__tray">
            <span className="rk-cal__tray-lab">earlier / later</span>
            {offGrid.map((e) => <button key={e.id} className={`rk-cal__card${selectedId === e.id ? " rk-cal__card--sel" : ""}`} style={{ padding: "5px 9px" }} onClick={() => onSelect(e.id)}><span className="rk-cal__card-title" style={{ fontSize: 11.5 }}>{formatTime(e.timestamp)} · {e.title}</span></button>)}
          </div>
        )}
        <div style={{ position: "relative" }}>
          {HOURS.map((h) => (
            <div key={h} className="rk-cal__hour"><span className="rk-cal__hour-label">{String(h).padStart(2, "0")}:00</span><span className="rk-cal__hour-slot" /></div>
          ))}
          <div className="rk-cal__blocks">
            {placed.map((e) => {
              const d = new Date(e.timestamp);
              const h = d.getHours();
              if (h < 7 || h > 21) return null;
              const top = (h - 7 + d.getMinutes() / 60) * 44;
              return (
                <button key={e.id} className={`rk-cal__block rk-cal__block--${e.type === "content" ? "content" : "task"}${selectedId === e.id ? " rk-cal__block--sel" : ""}`} style={{ top, height: 22 }} onClick={() => onSelect(e.id)}>
                  <span className="rk-cal__block-t">{formatTime(e.timestamp)}</span> {e.title}
                </button>
              );
            })}
          </div>
          {nowTop != null && <div className="rk-cal__nowline" style={{ top: nowTop }}><i>now</i></div>}
        </div>
      </div>
      <div className="rk-cal__side-inner">
        {detail ? <SideDetail event={detail} /> : <div className="rk-cal__side-empty">Select an event to inspect it.</div>}
      </div>
    </div>
  );
}

/* ── create dialog ── */
function CreateDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (input: { title: string; when: string; priority: CalendarPriority }) => Promise<boolean> }) {
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
  const [priority, setPriority] = useState<CalendarPriority>("normal");
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => (when.trim() ? parseRelativeDate(when) : null), [when]);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    const ok = await onCreate({ title: title.trim(), when: when.trim(), priority });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div className="rk-cal__overlay" onClick={() => !busy && onClose()}>
      <div className="rk-cal__dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="rk-cal__dialog-head">
          <div className="rk-cal__dialog-title">New event</div>
          <div className="rk-cal__dialog-sub">Schedules a task, on the commitment surface Tasks already owns.</div>
        </div>
        <div className="rk-cal__dialog-body">
          <div>
            <div className="rk-cal__field-lab">title</div>
            <input className="rk-cal__dialog-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's the event?" autoFocus />
          </div>
          <div>
            <div className="rk-cal__field-lab">when</div>
            <input className="rk-cal__dialog-input" value={when} onChange={(e) => setWhen(e.target.value)} placeholder="e.g. tomorrow at 3pm, next monday" />
            <div className="rk-cal__parse">{when.trim() ? (parsed ? `→ ${formatFullDateTime(parsed.ts)}` : "Couldn't parse that — leave blank for an undated task.") : "Leave blank for an undated task."}</div>
          </div>
          <div>
            <div className="rk-cal__field-lab">priority</div>
            <div style={{ display: "flex", gap: 6 }}>
              {(["low", "normal", "high", "critical"] as CalendarPriority[]).map((p) => (
                <button key={p} className={`rk-cal__sbtn${priority === p ? " rk-cal__sbtn--pri" : ""}`} onClick={() => setPriority(p)}>{p}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="rk-cal__dialog-acts" style={{ padding: "0 18px 16px" }}>
          <button className="rk-cal__sbtn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="rk-cal__sbtn rk-cal__sbtn--pri" onClick={submit} disabled={busy || !title.trim()}>{busy ? "Creating…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

/* ── helpers ── */
function formatTime(ts: number): string { if (!Number.isFinite(ts)) return ""; const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
function formatFullDateTime(ts: number): string { return new Date(ts).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function isSameDay(a: number, b: number): boolean { const da = new Date(a), db = new Date(b); return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate(); }
function startOfWeek(ts: number): number { const d = new Date(ts); d.setHours(0, 0, 0, 0); const dow = d.getDay(); d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow)); return d.getTime(); }
function weekRangeLabel(weekStart: number): string {
  const start = new Date(weekStart), end = new Date(weekStart + 6 * 86_400_000);
  if (start.getMonth() === end.getMonth()) return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}–${end.getDate()}`;
  return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
function currentDayIdx(): number { const dow = new Date().getDay(); return dow === 0 ? 6 : dow - 1; }
