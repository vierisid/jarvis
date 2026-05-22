import React, { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "../taskResult/TaskResultRoom.css";

type AnswerRecord = {
  id: string;
  prompt: string;
  response: string;
  created_at: number;
};

/**
 * Long-answer panel — spawned when the user clicks "open full ↗" on the
 * pebble's speaking bubble. Renders the full LLM response as markdown so
 * long answers stay readable even when TTS is off.
 *
 * Reuses TaskResultRoom.css styling for visual consistency with the
 * sub-pebble result panel. Read-only — no polling needed since answers
 * are immutable once registered.
 */
export function AnswerRoom({ answerId }: { answerId: string }) {
  const [answer, setAnswer] = useState<AnswerRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/pebble/answers/${encodeURIComponent(answerId)}`);
        if (!res.ok) {
          if (alive) setError(`HTTP ${res.status}`);
          return;
        }
        const json = (await res.json()) as AnswerRecord;
        if (alive) setAnswer(json);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "fetch failed");
      }
    })();
    return () => { alive = false; };
  }, [answerId]);

  if (error && !answer) {
    return (
      <div className="task-result task-result--error">
        <div className="task-result__error">
          <div className="task-result__error-eyebrow">unavailable</div>
          <div className="task-result__error-msg">{error}</div>
          <div className="task-result__error-hint">
            Answer may have aged out (~25 most recent kept in memory).
          </div>
        </div>
      </div>
    );
  }
  if (!answer) {
    return (
      <div className="task-result task-result--loading">
        <div className="task-result__loading-dot" />
        <div className="task-result__loading-line">loading answer…</div>
      </div>
    );
  }

  const askedAt = new Date(answer.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="task-result">
      <header className="task-result__head">
        <div className="task-result__eyebrow">
          <span className="task-result__agent">JARVIS</span>
          <span className="task-result__sep">·</span>
          <span className="task-result__elapsed">asked at {askedAt}</span>
        </div>
        <h1 className="task-result__title">{answer.prompt}</h1>
      </header>

      <section className="task-result__response">
        <div className="task-result__response-head">
          <div className="task-result__section-eyebrow">full answer</div>
        </div>
        <div className="task-result__response-body task-result__markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {answer.response || "(no output)"}
          </ReactMarkdown>
        </div>
      </section>
    </div>
  );
}
