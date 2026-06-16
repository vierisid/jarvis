import React, { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./TaskResultRoom.css";

type TaskRecord = {
  id: string;
  agent_id: string;
  agent_name: string;
  specialist: string;
  task: string;
  status: "running" | "completed" | "failed";
  started_at: number;
  completed_at: number | null;
  elapsed_seconds: number;
  response: string;
  summary: string | null;
  tools_used: string[];
  tokens_used: { input: number; output: number } | null;
};

/**
 * Full-result panel for a single backgrounded sub-agent task. Spawned as a
 * standalone native window when the user clicks "open full" on a sub-pebble
 * bubble. Reads the task id from `#/_task_<id>` and pulls the full record
 * (agent name, task, summary, raw response, tools, tokens) from the daemon.
 *
 * Polls every 2 s while the task is still running so the panel updates as
 * the agent works. Stops polling once the task lands in a terminal state.
 */
export function TaskResultRoom({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState<boolean>(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      let status: string | undefined;
      try {
        const res = await fetch(`/api/agents/tasks/${encodeURIComponent(taskId)}`);
        if (!res.ok) {
          if (alive) setError(`HTTP ${res.status}`);
        } else {
          const json = (await res.json()) as TaskRecord;
          status = json.status;
          if (alive) {
            setTask(json);
            setError(null);
          }
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "fetch failed");
      } finally {
        // Re-poll only while running (fast) or after a transient fetch error
        // (status undefined). A terminal record is immutable, so stop — this is
        // a long-lived native panel and otherwise it would poll forever. Decide
        // from the freshly-fetched status, not a stale closure, so the effect
        // doesn't need task.status in its deps (which tore down the loop on
        // every transition and fired an extra immediate fetch).
        if (alive && (status === "running" || status === undefined)) {
          timer = setTimeout(tick, status === "running" ? 2000 : 5000);
        }
      }
    };

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [taskId]);

  if (error && !task) {
    return (
      <div className="task-result task-result--error">
        <div className="task-result__error">
          <div className="task-result__error-eyebrow">unavailable</div>
          <div className="task-result__error-msg">{error}</div>
          <div className="task-result__error-hint">
            Task may have aged out (kept ~10 min after completion).
          </div>
        </div>
      </div>
    );
  }
  if (!task) {
    return (
      <div className="task-result task-result--loading">
        <div className="task-result__loading-dot" />
        <div className="task-result__loading-line">loading task…</div>
      </div>
    );
  }

  const elapsedLabel = formatElapsed(task.elapsed_seconds);
  const statusTone =
    task.status === "running" ? "running" :
    task.status === "failed" ? "failed" : "completed";

  return (
    <div className="task-result">
      <header className="task-result__head">
        <div className="task-result__eyebrow">
          <span className={`task-result__dot task-result__dot--${statusTone}`} />
          <span className="task-result__agent">{task.agent_name}</span>
          <span className="task-result__sep">·</span>
          <span className="task-result__status">{task.status}</span>
          <span className="task-result__sep">·</span>
          <span className="task-result__elapsed">{elapsedLabel}</span>
        </div>
        <h1 className="task-result__title">{task.task}</h1>
      </header>

      {task.summary && (
        <section className="task-result__summary">
          <div className="task-result__section-eyebrow">summary</div>
          <p className="task-result__summary-body">{task.summary}</p>
        </section>
      )}

      <section className="task-result__response">
        <div className="task-result__response-head">
          <div className="task-result__section-eyebrow">
            {task.summary ? "full response" : "response"}
          </div>
          {task.summary && (
            <button
              type="button"
              className="task-result__raw-toggle"
              onClick={() => setShowRaw((v) => !v)}
            >
              {showRaw ? "hide ▴" : "show ▾"}
            </button>
          )}
        </div>
        {(!task.summary || showRaw) && (
          task.response ? (
            <div className="task-result__response-body task-result__markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.response}</ReactMarkdown>
            </div>
          ) : (
            <div className="task-result__response-body task-result__response-empty">(no output)</div>
          )
        )}
      </section>

      {(task.tools_used.length > 0 || task.tokens_used) && (
        <footer className="task-result__footer">
          {task.tools_used.length > 0 && (
            <div className="task-result__tools">
              <span className="task-result__section-eyebrow">tools</span>
              {task.tools_used.map((t) => (
                <span key={t} className="task-result__tool-chip">{t}</span>
              ))}
            </div>
          )}
          {task.tokens_used && (
            <div className="task-result__tokens">
              {task.tokens_used.input} in · {task.tokens_used.output} out
            </div>
          )}
        </footer>
      )}
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
