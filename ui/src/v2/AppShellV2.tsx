import React from "react";
import { disableV2 } from "./flag";
import "./v2.css";

export function AppShellV2() {
  return (
    <div className="jarvis-v2-root">
      <div className="v2-placeholder">
        <header className="v2-placeholder__brand">
          <span className="v2-placeholder__brand-dot" aria-hidden="true" />
          <span>J.A.R.V.I.S. · V2</span>
        </header>

        <main className="v2-placeholder__body">
          <div className="v2-placeholder__eyebrow">Phase 0 · alignment &amp; setup</div>
          <h1 className="v2-placeholder__title">
            A new shell, <em>on bone paper.</em>
          </h1>
          <p className="v2-placeholder__lede">
            Tokens, fonts, and the flag are wired. The Thread, Voice Rail, and Rooms arrive in
            Phase 2. Until then, this surface is here to verify the risograph foundation renders
            correctly — bone paper, hard black ink, one vermilion accent, Fraunces for display,
            Inter Tight for body, JetBrains Mono for meta.
          </p>

          <dl className="v2-placeholder__meta">
            <div className="v2-placeholder__meta-cell">
              <dt>Branch</dt>
              <dd>refractor/UI_UX</dd>
            </div>
            <div className="v2-placeholder__meta-cell">
              <dt>Roadmap</dt>
              <dd>docs/UI_REDESIGN_ROADMAP.md</dd>
            </div>
            <div className="v2-placeholder__meta-cell">
              <dt>Flag</dt>
              <dd>?ui=v2</dd>
            </div>
          </dl>
        </main>

        <footer className="v2-placeholder__footer">
          <span>voice-first · thread + rail + rooms</span>
          <button
            type="button"
            className="v2-placeholder__back"
            onClick={disableV2}
            aria-label="Switch back to legacy UI"
          >
            ← Legacy UI
          </button>
        </footer>
      </div>
    </div>
  );
}
