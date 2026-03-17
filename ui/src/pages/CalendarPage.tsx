import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { api } from "../hooks/useApi";
import type { CalendarEvent } from "../components/calendar/CalendarEventBadge";
import type { TaskEvent, ContentEvent } from "../hooks/useWebSocket";
import "../styles/calendar.css";

type Props = {
  taskEvents: TaskEvent[];
  contentEvents: ContentEvent[];
};

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const PRIORITY_COLORS: Record<string, { bg: string; fg: string }> = {
  critical: { bg: "rgba(251,113,133,0.12)", fg: "#FB7185" },
  high:     { bg: "rgba(244,114,182,0.12)", fg: "#F472B6" },
  normal:   { bg: "rgba(34,211,238,0.12)",  fg: "#22D3EE" },
  low:      { bg: "rgba(255,255,255,0.04)", fg: "rgba(255,255,255,0.30)" },
};

function getWeekStart(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function getWeekRange(weekStart: Date): { start: number; end: number } {
  const start = weekStart.getTime();
  const end = new Date(weekStart);
  end.setDate(weekStart.getDate() + 7);
  return { start, end: end.getTime() };
}

function formatWeekRange(weekStart: Date): string {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const startStr = weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const endStr = weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${startStr} \u2013 ${endStr}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function CalendarPage({ taskEvents, contentEvents }: Props) {
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const lastTaskProcessed = useRef(0);
  const lastContentProcessed = useRef(0);

  const fetchEvents = useCallback(async (ws: Date) => {
    setLoading(true);
    try {
      const { start, end } = getWeekRange(ws);
      const data = await api<CalendarEvent[]>(`/api/calendar?range_start=${start}&range_end=${end}`);
      setEvents(data);
    } catch { setEvents([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchEvents(weekStart); }, [weekStart, fetchEvents]);

  // Real-time task events
  useEffect(() => {
    if (!taskEvents.length) return;
    const newE = taskEvents.filter(e => e.timestamp > lastTaskProcessed.current);
    if (newE.length === 0) return;
    lastTaskProcessed.current = newE[newE.length - 1]!.timestamp;
    fetchEvents(weekStart);
  }, [taskEvents, weekStart, fetchEvents]);

  // Real-time content events
  useEffect(() => {
    if (!contentEvents.length) return;
    const newE = contentEvents.filter(e => e.timestamp > lastContentProcessed.current);
    if (newE.length === 0) return;
    lastContentProcessed.current = newE[newE.length - 1]!.timestamp;
    fetchEvents(weekStart);
  }, [contentEvents, weekStart, fetchEvents]);

  const prevWeek = useCallback(() => {
    setWeekStart(ws => { const d = new Date(ws); d.setDate(ws.getDate() - 7); return d; });
  }, []);
  const nextWeek = useCallback(() => {
    setWeekStart(ws => { const d = new Date(ws); d.setDate(ws.getDate() + 7); return d; });
  }, []);
  const goToday = useCallback(() => {
    setWeekStart(getWeekStart(new Date()));
    setSelectedDate(new Date());
  }, []);

  // Build week days array
  const weekDays = useMemo(() => {
    const days: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      days.push(d);
    }
    return days;
  }, [weekStart]);

  const today = useMemo(() => new Date(), []);

  // Events for each day
  const eventsForDay = useCallback((date: Date) => {
    return events.filter(e => {
      const ed = new Date(e.timestamp);
      return sameDay(ed, date);
    }).sort((a, b) => a.timestamp - b.timestamp);
  }, [events]);

  // Selected day events split by type
  const selectedDayEvents = useMemo(() => eventsForDay(selectedDate), [eventsForDay, selectedDate]);
  const taskEventsForDay = selectedDayEvents.filter(e => e.type === "commitment");
  const contentEventsForDay = selectedDayEvents.filter(e => e.type === "content");

  return (
    <div className="cal-page">
      <div className="cal-atmosphere" />

      {/* Header */}
      <div className="cal-header">
        <span className="cal-header-title">Calendar</span>
        <div className="cal-week-nav">
          <button className="cal-week-btn" onClick={prevWeek}>&larr;</button>
          <span className="cal-week-range">{formatWeekRange(weekStart)}</span>
          <button className="cal-week-btn" onClick={nextWeek}>&rarr;</button>
        </div>
        <button className="cal-today-btn" onClick={goToday}>This Week</button>
        <div className="cal-header-spacer" />
        <div className="cal-legend">
          <div className="cal-legend-item"><div className="ldot" style={{ background: "#22D3EE" }} />Tasks</div>
          <div className="cal-legend-item"><div className="ldot" style={{ background: "#FBBF24" }} />Content</div>
        </div>
      </div>

      {/* Day summary cards */}
      <div className="cal-day-summaries">
        {weekDays.map((day, i) => {
          const dayEvents = eventsForDay(day);
          const isToday = sameDay(day, today);
          const isSelected = sameDay(day, selectedDate);
          const taskDots = dayEvents.filter(e => e.type === "commitment").length;
          const contentDots = dayEvents.filter(e => e.type === "content").length;

          return (
            <div
              key={i}
              className={`cal-day-sum${isToday ? " today" : ""}${isSelected ? " selected" : ""}`}
              onClick={() => setSelectedDate(day)}
            >
              <div className="cal-ds-day">{DAY_NAMES[i]}</div>
              <div className={`cal-ds-date${isToday ? " today" : ""}`}>{day.getDate()}</div>
              <div className="cal-ds-dots">
                {Array.from({ length: Math.min(taskDots, 4) }).map((_, j) => (
                  <div key={`t${j}`} className="cal-ds-dot" style={{ background: "#22D3EE" }} />
                ))}
                {Array.from({ length: Math.min(contentDots, 3) }).map((_, j) => (
                  <div key={`c${j}`} className="cal-ds-dot" style={{ background: "#FBBF24" }} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Event list */}
      {loading ? (
        <div className="cal-loading">
          <div className="cal-loading-orb" />
          <div className="cal-loading-text">Loading calendar...</div>
        </div>
      ) : (
        <div className="cal-event-area">
          {selectedDayEvents.length === 0 ? (
            <div className="cal-no-events">
              <div className="empty-icon">{"\u{1F4C5}"}</div>
              <p>No events on {selectedDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
            </div>
          ) : (
            <>
              {/* Tasks swim lane */}
              {taskEventsForDay.length > 0 && (
                <div className="cal-swim-lane">
                  <div className="cal-sl-header">
                    <div className="sh-dot" style={{ background: "#22D3EE" }} />
                    Tasks <span className="sh-count">({taskEventsForDay.length})</span>
                  </div>
                  {taskEventsForDay.map((evt, i) => (
                    <EventCard key={evt.id} event={evt} index={i} />
                  ))}
                </div>
              )}

              {/* Content swim lane */}
              {contentEventsForDay.length > 0 && (
                <div className="cal-swim-lane">
                  <div className="cal-sl-header">
                    <div className="sh-dot" style={{ background: "#FBBF24" }} />
                    Content <span className="sh-count">({contentEventsForDay.length})</span>
                  </div>
                  {contentEventsForDay.map((evt, i) => (
                    <EventCard key={evt.id} event={evt} index={i} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Event Card ──

function EventCard({ event, index }: { event: CalendarEvent; index: number }) {
  const isTask = event.type === "commitment";
  const time = event.has_due_date === false ? "no due date" : formatTime(event.timestamp);
  const priColor = isTask ? (PRIORITY_COLORS[event.priority || "normal"] || PRIORITY_COLORS.normal!) : null;

  return (
    <div
      className={`cal-event-card ${isTask ? "task" : "content"}`}
      style={{ animationDelay: `${index * 0.04}s` }}
    >
      <div className="cal-ec-time">{time}</div>
      <div className="cal-ec-body">
        <div className="cal-ec-title">{event.title}</div>
        <div className="cal-ec-meta">
          <span className={`cal-ec-badge ${isTask ? "task-badge" : "content-badge"}`}>
            {isTask ? "Task" : (event.content_type || "Content")}
          </span>
          {isTask && event.priority && event.priority !== "normal" && priColor && (
            <span className="cal-ec-priority" style={{ background: priColor.bg, color: priColor.fg }}>
              {event.priority}
            </span>
          )}
          <span className="cal-ec-status">{event.status}</span>
          {event.assigned_to && <span>{event.assigned_to}</span>}
        </div>
      </div>
    </div>
  );
}
