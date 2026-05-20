import React, { useEffect, useMemo, useRef, useState } from "react";
import "./AgentStripRoom.css";

type TaskStatus = "running" | "completed" | "failed";

type StripTask = {
  task_id: string;
  agent_name: string;
  status: TaskStatus;
  task: string;
  elapsed_seconds: number;
  completed_at: number | null;
  result_preview: string | null;
};

type StripAgent = {
  agent_id: string;
  name: string;
  specialist: string;
  status: "active" | "idle" | "terminated";
  current_task: string | null;
  busy?: boolean;
};

type StripPayload = {
  active_agents: number;
  agents: StripAgent[];
  tasks_total: number;
  tasks_running: number;
  tasks: StripTask[];
};

const POLL_MS = 1000;

export type RoomBodyMode = "inline" | "expanded";

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function formatRelativeCompleted(completedAt: number, now: number): string {
  const diff = Math.max(0, Math.round((now - completedAt) / 1000));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/**
 * Background agent strip — ambient floating window of every async sub-agent
 * the daemon has in flight, plus completed runs (kept ~10 min by the task
 * manager) so you can read the result without a separate room. Polls
 * /api/agents/tasks; sized to live in a 290×440 always-on-top native window.
 *
 * Row tones:
 *   ● amber pulse  — running
 *   ● emerald      — completed (result preview shown inline)
 *   ● vermilion    — failed
 *   ○ ink-3        — idle agent (collapsed footer)
 */
export function AgentStripRoom(_: { mode?: RoomBodyMode }) {
  const [payload, setPayload] = useState<StripPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(Date.now());
  const [now, setNow] = useState<number>(Date.now());
  const [expandedIdle, setExpandedIdle] = useState<boolean>(false);
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set());
  const aliveRef = useRef(true);

  // Tick a second clock independent of the payload so "Xs ago" / elapsed
  // counters stay live between polls (the daemon poll is 1s but feels
  // jittery if elapsed only updates on response).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch("/api/agents/tasks");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as StripPayload;
        if (aliveRef.current) {
          setPayload(json);
          setError(null);
          setLastUpdate(Date.now());
        }
      } catch (err) {
        if (aliveRef.current) {
          setError(err instanceof Error ? err.message : "fetch failed");
        }
      } finally {
        if (aliveRef.current) {
          timer = setTimeout(tick, POLL_MS);
        }
      }
    };

    void tick();
    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Sort: running first (longest first so the most-likely-to-finish-soon
  // gets visual priority), then most-recently-completed, then failed.
  const sortedTasks = useMemo(() => {
    if (!payload) return [];
    const running = payload.tasks
      .filter((t) => t.status === "running")
      .sort((a, b) => b.elapsed_seconds - a.elapsed_seconds);
    const completed = payload.tasks
      .filter((t) => t.status === "completed")
      .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
    const failed = payload.tasks
      .filter((t) => t.status === "failed")
      .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
    return [...running, ...completed, ...failed];
  }, [payload]);

  const idleAgents = useMemo(() => {
    if (!payload) return [];
    return payload.agents.filter((a) => !a.busy && a.status !== "terminated");
  }, [payload]);

  const lastUpdateLabel = useMemo(() => {
    const diff = Math.max(0, Math.round((now - lastUpdate) / 1000));
    if (diff < 2) return "live";
    return `${diff}s ago`;
  }, [now, lastUpdate]);

  const toggleResult = (id: string) => {
    setExpandedResults((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const running = payload?.tasks_running ?? 0;
  const total = payload?.tasks_total ?? 0;

  return (
    <div className="agent-strip">
      <header className="agent-strip__head">
        <div className="agent-strip__head-left">
          <span
            className={`agent-strip__head-pulse${
              running > 0 ? " agent-strip__head-pulse--on" : ""
            }`}
            aria-hidden="true"
          />
          <span className="agent-strip__title">AGENTS</span>
        </div>
        <span className="agent-strip__count" title={`${running} running / ${total} total`}>
          {running}<span className="agent-strip__count-sep">/</span>{total}
        </span>
      </header>

      <div className="agent-strip__list" role="list">
        {error && !payload && (
          <div className="agent-strip__empty">
            <div className="agent-strip__empty-eyebrow">offline</div>
            <div className="agent-strip__empty-line">daemon unreachable</div>
          </div>
        )}

        {payload && sortedTasks.length === 0 && (
          <div className="agent-strip__empty">
            <span className="agent-strip__empty-dot" aria-hidden="true" />
            <div className="agent-strip__empty-eyebrow">standing by</div>
            <div className="agent-strip__empty-line">
              Say "Jarvis, in the background…" to launch one
            </div>
          </div>
        )}

        {sortedTasks.map((task) => {
          const isRunning = task.status === "running";
          const isCompleted = task.status === "completed";
          const isFailed = task.status === "failed";
          const expanded = expandedResults.has(task.task_id);
          const hasResult = !!task.result_preview;
          const liveElapsed = isRunning && task.completed_at === null
            ? task.elapsed_seconds + Math.max(0, Math.round((now - lastUpdate) / 1000))
            : task.elapsed_seconds;
          return (
            <article
              key={task.task_id}
              role="listitem"
              className={`agent-strip__card agent-strip__card--${task.status}`}
            >
              <div className="agent-strip__row">
                <span
                  className={`agent-strip__dot agent-strip__dot--${task.status}`}
                  aria-hidden="true"
                />
                <span className="agent-strip__name">{task.agent_name}</span>
                <span className="agent-strip__elapsed">
                  {isCompleted || isFailed
                    ? task.completed_at
                      ? formatRelativeCompleted(task.completed_at, now)
                      : formatElapsed(task.elapsed_seconds)
                    : formatElapsed(liveElapsed)}
                </span>
              </div>
              <div className="agent-strip__task" title={task.task}>
                {task.task}
              </div>
              {isRunning && (
                <div className="agent-strip__progress" aria-hidden="true">
                  <span className="agent-strip__progress-bar" />
                </div>
              )}
              {(isCompleted || isFailed) && hasResult && (
                <div
                  className={`agent-strip__result${
                    expanded ? " agent-strip__result--expanded" : ""
                  }`}
                >
                  <div className="agent-strip__result-eyebrow">
                    {isFailed ? "error" : "result"}
                  </div>
                  <div className="agent-strip__result-body">
                    {task.result_preview}
                  </div>
                  {task.result_preview && task.result_preview.length >= 180 && (
                    <button
                      type="button"
                      className="agent-strip__result-toggle"
                      onClick={() => toggleResult(task.task_id)}
                    >
                      {expanded ? "show less" : "show more"}
                    </button>
                  )}
                </div>
              )}
              {(isCompleted || isFailed) && !hasResult && (
                <div className="agent-strip__result agent-strip__result--empty">
                  <div className="agent-strip__result-eyebrow">
                    {isFailed ? "error" : "done"}
                  </div>
                  <div className="agent-strip__result-body agent-strip__result-body--muted">
                    no output captured
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {idleAgents.length > 0 && (
        <footer
          className={`agent-strip__idle-group${
            expandedIdle ? " agent-strip__idle-group--open" : ""
          }`}
        >
          <button
            type="button"
            className="agent-strip__idle-toggle"
            onClick={() => setExpandedIdle((v) => !v)}
          >
            <span className="agent-strip__idle-chev" aria-hidden="true">
              {expandedIdle ? "▾" : "▸"}
            </span>
            <span className="agent-strip__idle-label">
              {idleAgents.length} idle
            </span>
            <span className="agent-strip__last-update" title={`last poll ${lastUpdateLabel}`}>
              {lastUpdateLabel}
            </span>
          </button>
          {expandedIdle && (
            <div className="agent-strip__idle-list">
              {idleAgents.map((agent) => (
                <div
                  key={agent.agent_id}
                  role="listitem"
                  className="agent-strip__idle"
                >
                  <span
                    className="agent-strip__dot agent-strip__dot--idle"
                    aria-hidden="true"
                  />
                  <span className="agent-strip__idle-name">{agent.name}</span>
                  <span className="agent-strip__idle-spec">{agent.specialist}</span>
                </div>
              ))}
            </div>
          )}
        </footer>
      )}

      {idleAgents.length === 0 && sortedTasks.length > 0 && (
        <footer className="agent-strip__last-update-bar">
          <span className="agent-strip__last-update">last poll {lastUpdateLabel}</span>
        </footer>
      )}
    </div>
  );
}

export const AgentStripRoomBody = AgentStripRoom;
