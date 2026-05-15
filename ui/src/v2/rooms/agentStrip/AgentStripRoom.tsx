import React, { useEffect, useMemo, useRef, useState } from "react";
import "./AgentStripRoom.css";

type TaskStatus = "running" | "completed" | "failed";

type StripTask = {
  task_id: string;
  agent_name: string;
  status: TaskStatus;
  task: string;
  elapsed_seconds: number;
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
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Background agent strip — small ambient surface listing every async agent
 * task the daemon is currently running, plus completed tasks until they
 * age out of the task manager. Polls /api/agents/tasks; sized to live in
 * a thin always-on-top native window (~280×400).
 *
 * Status dots:
 *   ● amber pulse — running
 *   ● green       — completed
 *   ● vermilion   — failed
 *   ○ ink-3       — idle agent (no task)
 *
 * Rendered with no internal scrim — the OS window IS the surface.
 */
export function AgentStripRoom(_: { mode?: RoomBodyMode }) {
  const [payload, setPayload] = useState<StripPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const tickRef = useRef(0);

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
          tickRef.current += 1;
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

  // Sort: running first (by oldest first), then completed (newest first),
  // then failed (newest first). Keeps the user's eye on what's still going.
  const sortedTasks = useMemo(() => {
    if (!payload) return [];
    const running = payload.tasks
      .filter((t) => t.status === "running")
      .sort((a, b) => b.elapsed_seconds - a.elapsed_seconds);
    const completed = payload.tasks
      .filter((t) => t.status === "completed")
      .sort((a, b) => a.elapsed_seconds - b.elapsed_seconds);
    const failed = payload.tasks
      .filter((t) => t.status === "failed")
      .sort((a, b) => a.elapsed_seconds - b.elapsed_seconds);
    return [...running, ...completed, ...failed];
  }, [payload]);

  const idleAgents = useMemo(() => {
    if (!payload) return [];
    return payload.agents.filter((a) => !a.busy && a.status !== "terminated");
  }, [payload]);

  return (
    <div className="agent-strip">
      <header className="agent-strip__head">
        <span className="agent-strip__title">AGENTS</span>
        <span className="agent-strip__count">
          {payload ? `${payload.tasks_running}/${payload.tasks_total}` : "—"}
        </span>
      </header>

      <div className="agent-strip__list" role="list">
        {error && !payload && (
          <div className="agent-strip__empty">no daemon</div>
        )}

        {payload && sortedTasks.length === 0 && idleAgents.length === 0 && (
          <div className="agent-strip__empty">no agents running</div>
        )}

        {sortedTasks.map((task) => (
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
                {formatElapsed(task.elapsed_seconds)}
              </span>
            </div>
            <div className="agent-strip__task" title={task.task}>
              {task.task}
            </div>
          </article>
        ))}

        {idleAgents.length > 0 && (
          <div className="agent-strip__idle-group">
            <div className="agent-strip__idle-label">idle</div>
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
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const AgentStripRoomBody = AgentStripRoom;
