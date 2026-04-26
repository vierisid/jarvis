import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  FileText,
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
import { parseRelativeDate } from "../../../../../src/voice/parse-date";
import {
  useCalendarData,
  type CalendarEvent,
  type CalendarPriority,
} from "./useCalendarData";
import "./CalendarRoom.css";

type ViewMode = "week" | "day";

const PRIORITY_TONE: Record<string, "ok" | "neutral" | "warn" | "accent"> = {
  critical: "accent",
  high: "warn",
  normal: "neutral",
  low: "ok",
};

const STATUS_TONE: Record<string, "ok" | "neutral" | "warn" | "accent"> = {
  done: "ok",
  completed: "ok",
  failed: "accent",
  cancelled: "accent",
  active: "warn",
  pending: "neutral",
};

const TYPE_ICON: Record<CalendarEvent["type"], LucideIcon> = {
  commitment: CalendarRange,
  content: FileText,
};

const DAY_LABEL_LONG = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type RoomBodyMode = "inline" | "expanded";

export function CalendarRoomBody({ mode }: { mode: RoomBodyMode }) {
  const data = useCalendarData();
  const [view, setView] = useState<ViewMode>("week");
  const [search, setSearch] = useState("");
  const [selectedDayIdx, setSelectedDayIdx] = useState<number>(() => {
    const d = new Date();
    const dow = d.getDay();
    return dow === 0 ? 6 : dow - 1; // Mon=0..Sun=6
  });
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
    for (const [k, v] of data.eventsByDay) {
      out.set(
        k,
        v.filter((e) => e.title.toLowerCase().includes(q)),
      );
    }
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

  // Phase 6.3.5 voice room actions for Calendar.
  useRoomActions("calendar", (action, args) => {
    switch (action) {
      case "switch_view": {
        const v = String(args.view);
        if (v === "week" || v === "day") {
          setView(v);
          return true;
        }
        return false;
      }
      case "search":
        setSearch(typeof args.query === "string" ? args.query : "");
        return true;
      case "select_event": {
        const name = typeof args.title === "string" ? args.title : "";
        const ev = data.findByTitle(name);
        if (!ev) return false;
        setSelectedEventId(ev.id);
        // Pivot to the day of the selected event so it's actually visible.
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
          const r = await data.addEvent({
            title,
            whenMs: parsed?.ts,
            priority: (args.priority as CalendarPriority) ?? undefined,
            assigned_to: typeof args.with === "string" ? args.with : undefined,
          });
          if (r.ok && parsed) {
            // Jump the calendar to the event's week so it's visible.
            const targetWeekStart = startOfWeek(parsed.ts);
            const offset = Math.round((targetWeekStart - data.weekStart) / (7 * 86_400_000));
            if (offset !== 0) data.goToWeek(offset);
          }
          setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
        })();
        return true;
      }
      default:
        return false;
    }
  });

  return (
    <div className={`v2-cal v2-cal--${mode}`}>
      {/* Stats */}
      <div className="v2-cal__stats">
        <StatCard
          label="This week"
          value={data.events.length}
          sub={`${data.events.filter((e) => e.type === "commitment").length} tasks · ${data.events.filter((e) => e.type === "content").length} content`}
        />
        <StatCard
          label="Today"
          value={(data.eventsByDay.get(currentDayIdx()) ?? []).length}
          sub="events scheduled"
        />
        <StatCard
          label="View"
          value={view === "week" ? "Week" : "Day"}
          sub={dayLabel(data.weekStart, selectedDayIdx)}
        />
        <StatCard
          label="Selected day"
          value={tasksForDay.length + contentForDay.length}
          sub={`${tasksForDay.length} tasks · ${contentForDay.length} content`}
        />
      </div>

      {/* Toolbar — week navigation + search + new */}
      <div className="v2-cal__toolbar">
        <div className="v2-cal__nav">
          <button
            type="button"
            className="v2-cal__nav-btn"
            onClick={() => data.goToWeek(-1)}
            aria-label="Previous week"
          >
            <Icon icon={ChevronLeft} size="sm" />
          </button>
          <button
            type="button"
            className="v2-cal__today-btn"
            onClick={data.goToToday}
          >
            This week
          </button>
          <button
            type="button"
            className="v2-cal__nav-btn"
            onClick={() => data.goToWeek(1)}
            aria-label="Next week"
          >
            <Icon icon={ChevronRight} size="sm" />
          </button>
          <span className="v2-cal__week-label">{weekRangeLabel(data.weekStart)}</span>
        </div>

        <div className="v2-cal__search">
          <Icon icon={Search} size="sm" />
          <input
            className="v2-cal__search-input"
            type="text"
            placeholder="Search events…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search calendar"
          />
        </div>

        {mode === "expanded" && (
          <div className="v2-cal__view-row" role="tablist" aria-label="View">
            <button
              type="button"
              className="v2-cal__view-btn"
              data-active={view === "week"}
              onClick={() => setView("week")}
            >
              Week
            </button>
            <button
              type="button"
              className="v2-cal__view-btn"
              data-active={view === "day"}
              onClick={() => setView("day")}
            >
              Day
            </button>
          </div>
        )}

        <button
          type="button"
          className="v2-cal__refresh"
          onClick={data.refresh}
          aria-label="Refresh"
          title="Refresh"
        >
          <Icon icon={RefreshCw} size="sm" />
        </button>
        <button
          type="button"
          className="v2-cal__new-btn"
          onClick={() => setCreateOpen(true)}
        >
          <Icon icon={Plus} size="sm" />
          New
        </button>
      </div>

      {data.error && <div className="v2-cal__error">{data.error}</div>}

      {/* Week strip — 7 day cells. Hidden in day-only inline mode. */}
      {(mode === "expanded" && view === "week") || mode === "inline" ? (
        <div className="v2-cal__week" role="tablist" aria-label="Days of the week">
          {DAY_LABEL_LONG.map((label, i) => {
            const dayTs = data.weekStart + i * 86_400_000;
            const dayEvents = filteredEventsByDay.get(i) ?? [];
            const isToday = isSameDay(dayTs, Date.now());
            return (
              <button
                key={i}
                type="button"
                className="v2-cal__day-cell"
                data-active={selectedDayIdx === i}
                data-today={isToday}
                onClick={() => setSelectedDayIdx(i)}
                role="tab"
                aria-selected={selectedDayIdx === i}
              >
                <span className="v2-cal__day-name">{label}</span>
                <span className="v2-cal__day-num">{new Date(dayTs).getDate()}</span>
                {dayEvents.length > 0 && (
                  <div className="v2-cal__day-dots">
                    {dayEvents.slice(0, 5).map((e, idx) => (
                      <span
                        key={`${e.id}-${idx}`}
                        className="v2-cal__day-dot"
                        data-type={e.type}
                      />
                    ))}
                    {dayEvents.length > 5 && (
                      <span className="v2-cal__day-more">+{dayEvents.length - 5}</span>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Detail strip — Tasks + Content swimlanes for the selected day */}
      <div className="v2-cal__detail">
        <header className="v2-cal__detail-head">
          <h3 className="v2-cal__detail-title">
            {fullDayLabel(data.weekStart, selectedDayIdx)}
          </h3>
          <span className="v2-cal__detail-count">
            {tasksForDay.length + contentForDay.length} events
          </span>
        </header>

        <div className="v2-cal__lanes">
          <Lane
            label="Tasks"
            tone="neutral"
            events={tasksForDay}
            selectedId={selectedEventId}
            onSelect={setSelectedEventId}
            loading={data.loading}
          />
          <Lane
            label="Content"
            tone="warn"
            events={contentForDay}
            selectedId={selectedEventId}
            onSelect={setSelectedEventId}
            loading={data.loading}
          />
        </div>
      </div>

      {/* Side panel — selected event detail. Only in expanded mode. */}
      {mode === "expanded" && selectedEvent && (
        <DetailPanel event={selectedEvent} onClose={() => setSelectedEventId(null)} />
      )}

      {/* Create dialog */}
      {createOpen && (
        <CreateDialog
          onClose={() => setCreateOpen(false)}
          onCreate={async (input) => {
            const parsed = input.when ? parseRelativeDate(input.when) : null;
            const r = await data.addEvent({
              title: input.title,
              whenMs: parsed?.ts,
              priority: input.priority,
            });
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
            return r.ok;
          }}
        />
      )}

      {toast && (
        <div role="status" aria-live="polite" className="v2-cal__toast" data-tone={toast.tone}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

export function CalendarRoom() {
  return (
    <RoomShell
      title="Calendar"
      subtitle="this week · commitments · content"
      breadcrumb={["Calendar"]}
    >
      <CalendarRoomBody mode="expanded" />
    </RoomShell>
  );
}

/* ─────────── Subcomponents ─────────── */

function StatCard({ label, value, sub }: { label: string; value: number | string; sub: string }) {
  return (
    <div className="v2-cal__stat">
      <div className="v2-cal__stat-label">{label}</div>
      <div className="v2-cal__stat-value">{value}</div>
      <div className="v2-cal__stat-sub">{sub}</div>
    </div>
  );
}

function Lane({
  label,
  tone,
  events,
  selectedId,
  onSelect,
  loading,
}: {
  label: string;
  tone: "neutral" | "warn";
  events: CalendarEvent[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  loading: boolean;
}) {
  return (
    <section className="v2-cal__lane" data-tone={tone}>
      <header className="v2-cal__lane-head">
        <span className="v2-cal__lane-label">{label}</span>
        <span className="v2-cal__lane-count">{events.length}</span>
      </header>
      {loading && events.length === 0 ? (
        <div className="v2-cal__lane-empty">Loading…</div>
      ) : events.length === 0 ? (
        <div className="v2-cal__lane-empty">No {label.toLowerCase()} for this day.</div>
      ) : (
        <ul className="v2-cal__lane-list">
          {events.map((e) => (
            <li key={e.id}>
              <EventCard
                event={e}
                active={selectedId === e.id}
                onClick={() => onSelect(selectedId === e.id ? null : e.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EventCard({
  event,
  active,
  onClick,
}: {
  event: CalendarEvent;
  active: boolean;
  onClick: () => void;
}) {
  const IconComp = TYPE_ICON[event.type];
  const priorityTone = event.priority ? PRIORITY_TONE[event.priority] ?? "neutral" : "neutral";
  const statusTone = STATUS_TONE[event.status] ?? "neutral";
  return (
    <button
      type="button"
      className="v2-cal__event"
      data-active={active}
      data-type={event.type}
      onClick={onClick}
    >
      <span className="v2-cal__event-icon">
        <Icon icon={IconComp} size="sm" />
      </span>
      <span className="v2-cal__event-body">
        <span className="v2-cal__event-time">{formatTime(event.timestamp)}</span>
        <span className="v2-cal__event-title">{event.title}</span>
        <span className="v2-cal__event-meta">
          {event.priority && (
            <Chip tone={priorityTone} dot>
              {event.priority}
            </Chip>
          )}
          <Chip tone={statusTone} dot>
            {event.status}
          </Chip>
          {event.assigned_to && (
            <span className="v2-cal__event-assignee">→ {event.assigned_to}</span>
          )}
        </span>
      </span>
    </button>
  );
}

function DetailPanel({ event, onClose }: { event: CalendarEvent; onClose: () => void }) {
  return (
    <aside className="v2-cal__side">
      <header className="v2-cal__side-head">
        <div>
          <div className="v2-cal__side-eyebrow">
            {event.type === "commitment" ? "Task" : "Content"}
          </div>
          <h3 className="v2-cal__side-title">{event.title}</h3>
        </div>
        <button
          type="button"
          className="v2-cal__icon-btn"
          onClick={onClose}
          aria-label="Close detail"
        >
          <Icon icon={X} size="sm" />
        </button>
      </header>

      <dl className="v2-cal__side-fields">
        <div>
          <dt>When</dt>
          <dd>{formatFullDateTime(event.timestamp)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <Chip tone={STATUS_TONE[event.status] ?? "neutral"} dot>
              {event.status}
            </Chip>
          </dd>
        </div>
        {event.priority && (
          <div>
            <dt>Priority</dt>
            <dd>
              <Chip tone={PRIORITY_TONE[event.priority] ?? "neutral"} dot>
                {event.priority}
              </Chip>
            </dd>
          </div>
        )}
        {event.assigned_to && (
          <div>
            <dt>Assignee</dt>
            <dd>{event.assigned_to}</dd>
          </div>
        )}
        {event.content_type && (
          <div>
            <dt>Type</dt>
            <dd>{event.content_type}</dd>
          </div>
        )}
        {event.has_due_date === false && (
          <div>
            <dt>Due date</dt>
            <dd className="v2-cal__side-muted">Showing on creation date</dd>
          </div>
        )}
      </dl>
    </aside>
  );
}

function CreateDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: { title: string; when: string; priority: CalendarPriority }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
  const [priority, setPriority] = useState<CalendarPriority>("normal");
  const [busy, setBusy] = useState(false);

  // Live-preview the parsed date so the user sees what they'll get.
  const parsed = useMemo(() => (when.trim() ? parseRelativeDate(when) : null), [when]);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    const ok = await onCreate({ title: title.trim(), when: when.trim(), priority });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div className="v2-cal__overlay" onClick={() => !busy && onClose()}>
      <div
        className="v2-cal__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="v2-cal-create-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="v2-cal__dialog-head">
          <div>
            <div id="v2-cal-create-title" className="v2-cal__dialog-title">
              New event
            </div>
            <div className="v2-cal__dialog-subtitle">
              Schedule a task. Reuses your existing commitment surface.
            </div>
          </div>
          <button
            type="button"
            className="v2-cal__icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <Icon icon={X} size="sm" />
          </button>
        </div>

        <div className="v2-cal__dialog-body">
          <label className="v2-cal__field">
            <span className="v2-cal__field-label">Title</span>
            <input
              type="text"
              className="v2-cal__input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What's the event?"
              autoFocus
            />
          </label>

          <label className="v2-cal__field">
            <span className="v2-cal__field-label">When</span>
            <input
              type="text"
              className="v2-cal__input"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              placeholder="e.g. tomorrow at 3pm, next monday, 2026-04-30 15:00"
            />
            <span className="v2-cal__field-hint">
              {when.trim()
                ? parsed
                  ? `→ ${formatFullDateTime(parsed.ts)}`
                  : "Couldn't parse that — leave blank for an undated task."
                : "Leave blank for an undated task."}
            </span>
          </label>

          <label className="v2-cal__field">
            <span className="v2-cal__field-label">Priority</span>
            <div className="v2-cal__chip-row">
              {(["low", "normal", "high", "critical"] as CalendarPriority[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  className="v2-cal__chip"
                  data-active={priority === p}
                  onClick={() => setPriority(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </label>
        </div>

        <div className="v2-cal__dialog-foot">
          <button
            type="button"
            className="v2-cal__btn v2-cal__btn--secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="v2-cal__btn v2-cal__btn--primary"
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

function formatTime(ts: number): string {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatFullDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function startOfWeek(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + offset);
  return d.getTime();
}

function dayLabel(weekStart: number, idx: number): string {
  const d = new Date(weekStart + idx * 86_400_000);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function fullDayLabel(weekStart: number, idx: number): string {
  const d = new Date(weekStart + idx * 86_400_000);
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function weekRangeLabel(weekStart: number): string {
  const start = new Date(weekStart);
  const end = new Date(weekStart + 6 * 86_400_000);
  const sameMonth = start.getMonth() === end.getMonth();
  if (sameMonth) {
    return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}–${end.getDate()}`;
  }
  return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function currentDayIdx(): number {
  const dow = new Date().getDay();
  return dow === 0 ? 6 : dow - 1;
}

// silence unused-import lints
void Sparkles;
