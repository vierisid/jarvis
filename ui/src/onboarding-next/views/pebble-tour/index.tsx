import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import "./pebble-tour.css";

export interface PebbleTourModel {
  sessionId: string;
  revision: number;
  phase: "ready" | "moving" | "error";
  theme: "light" | "dark";
  sidebar: "expanded" | "rail";
}
export interface PebbleTourIntent {
  sessionId: string;
  revision: number;
  from: "pebble";
  action: "back" | "skip" | "next";
  to: "billing" | "first-workflow";
}
export interface PebbleTourSurfaceProps {
  theme?: "light" | "dark";
  sidebar?: "expanded" | "rail";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reducedMotion?: boolean;
}
/** A trusted, effect-free host bridge to the existing D-line shell. It retains the
 * room/selection and conversation instances. This view never implements a shell,
 * conversation engine or live send action. Keep Surface's component identity stable. */
export interface PebbleTourAdapter {
  isolation: "tutorial-sandbox";
  status: "ready" | "loading" | "unsupported" | "error";
  open: boolean;
  Surface: ComponentType<PebbleTourSurfaceProps>;
  onOpenChange: (open: boolean) => void;
}
export interface PebbleTourViewProps {
  model: PebbleTourModel;
  adapter?: PebbleTourAdapter;
  reducedMotion?: boolean;
  onNavigate: (intent: PebbleTourIntent) => void | Promise<void>;
}

/** Optional and unregistered. ON-U-10/ON-B-06 must supply the durable journey and
 * a sandboxed D-line host. Mount in the workspace, below its header and beside
 * its sidebar. The shell slot deliberately stays mounted when its panel closes. */
export function PebbleTourView(props: PebbleTourViewProps) {
  return <PebbleTourSession key={props.model.sessionId} {...props} />;
}
function PebbleTourSession({ model, adapter, reducedMotion, onNavigate }: PebbleTourViewProps) {
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const waitingForFocus = useRef(false);
  const [pendingRevision, setPendingRevision] = useState<number | null>(null);
  const lock = useRef<number | null>(null);
  const currentRevision = useRef(model.revision);
  currentRevision.current = model.revision;
  const [error, setError] = useState<string | null>(null);
  const supported = adapter?.isolation === "tutorial-sandbox";
  const ready = supported && adapter.status === "ready";
  const open = ready && adapter.open;
  const navigable = model.phase !== "moving" && pendingRevision !== model.revision;
  const actionable = ready && navigable;
  const Surface = supported ? adapter.Surface : null;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    if (actionable) primary.current?.focus({ preventScroll: true });
    else { waitingForFocus.current = true; title.current?.focus({ preventScroll: true }); }
    // Entry focus only. Opening uses the existing shell's focus handoff.
  }, []);
  useLayoutEffect(() => {
    if (actionable && waitingForFocus.current && document.activeElement === title.current) {
      waitingForFocus.current = false;
      primary.current?.focus({ preventScroll: true });
    }
  }, [actionable]);
  useEffect(() => { lock.current = null; setPendingRevision(null); setError(null); }, [model.revision]);

  const changeOpen = (value: boolean) => {
    if (!ready || !navigable) return;
    setError(null);
    try { adapter.onOpenChange(value); }
    catch { setError("Pebble couldn’t open. Try again, or go back."); }
  };
  const navigate = (action: PebbleTourIntent["action"]) => {
    if (!navigable || lock.current === model.revision || (action === "next" && !open)) return;
    const revision = model.revision;
    lock.current = revision; setPendingRevision(revision); setError(null);
    const fail = () => {
      if (!mounted.current || currentRevision.current !== revision) return;
      lock.current = null; setPendingRevision(null);
      setError("The tour couldn’t continue. Try again.");
    };
    try {
      const result = onNavigate({ sessionId: model.sessionId, revision, from: "pebble", action,
        to: action === "back" ? "billing" : "first-workflow" });
      // Resolution alone is not journey acknowledgement. Await a new revision.
      if (result) Promise.resolve(result).catch(fail);
    } catch { fail(); }
  };
  return <section className="on-pebble-tour" data-theme={model.theme} data-sidebar={model.sidebar}
    data-open={open} data-reduced-motion={reducedMotion || undefined} aria-label="Pebble tutorial">
    <div className="on-pebble-tour__stage">
      {Surface ? <Surface theme={model.theme} sidebar={model.sidebar} open={Boolean(open)} onOpenChange={changeOpen} reducedMotion={reducedMotion} />
        : <div className="on-pebble-tour__unavailable" role="status">The workspace preview is unavailable.</div>}
    </div>
    <div className="on-pebble-tour__dock">
      <section className="on-pebble-tour__card" aria-labelledby={titleId}>
        <p className="on-pebble-tour__eyebrow">Your workspace · 12 / 12 · Pebble</p>
        <h2 className="on-pebble-tour__title" id={titleId} ref={title} tabIndex={-1} onBlur={() => { waitingForFocus.current = false; }}>
          {open ? "Your work makes room for the conversation." : "A conversation beside your work."}</h2>
        <p className="on-pebble-tour__body">{open
          ? "Chat stays beside the page. Close Pebble to return to the full workspace."
          : "Open the Pebble in the lower-right corner. Ask for help, refine a workflow or think through a decision."}</p>
        <div className="on-pebble-tour__notice" role="status" aria-live="polite">
          {error ?? (!ready ? adapter?.status === "loading" ? "Preparing the workspace preview…"
            : "Pebble isn’t available in this preview. Go back or skip to the first workflow step." : "")}
        </div>
        <div className="on-pebble-tour__actions">
          {!open && <button type="button" aria-disabled={!navigable} onClick={() => navigate("skip")}>Skip tour</button>}
          <button type="button" aria-disabled={!navigable} onClick={() => navigate("back")}>Back</button>
          <button ref={primary} type="button" className="on-pebble-tour__primary" aria-disabled={!actionable}
            onClick={() => actionable && (open ? navigate("next") : changeOpen(true))}>
            {open ? "Let’s build your first workflow" : "Open Pebble"}</button>
        </div>
      </section>
    </div>
  </section>;
}
