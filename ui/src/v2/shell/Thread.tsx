import React from "react";
import "./Thread.css";

export function Thread() {
  return (
    <div className="v2-thread">
      <section className="v2-thread__empty" aria-labelledby="v2-thread-empty-title">
        <span className="v2-thread__eyebrow">Phase 2 · shell scaffolded</span>
        <h1 id="v2-thread-empty-title" className="v2-thread__title">
          The thread is <em>the whole app.</em>
        </h1>
        <p className="v2-thread__lede">
          Everything you say, everything Jarvis says, every approval and every inline object
          preview lives here. The voice rail on the right is status &amp; affordances only — it
          never duplicates what's in the thread.
        </p>
        <p className="v2-thread__lede">
          Real messages, approval cards, inline object previews, and the ⌘K palette arrive in
          Phase 3 &amp; 5. For now, enjoy the quiet.
        </p>

        <div className="v2-thread__preview" aria-label="Preview of an incoming Jarvis message">
          <div className="v2-thread__preview-meta">
            <span className="v2-thread__preview-who">Jarvis</span>
            <time className="v2-thread__preview-time" dateTime="2026-04-23T07:30:00Z">
              · morning · preview
            </time>
          </div>
          <p className="v2-thread__preview-body">
            Good morning, Martin. Quiet overnight — no critical alerts. Your 10am with Anya is
            confirmed, and I've held two hours of deep work this afternoon.
          </p>
          <span className="v2-thread__preview-foot">Preview only · not live yet</span>
        </div>
      </section>
    </div>
  );
}
