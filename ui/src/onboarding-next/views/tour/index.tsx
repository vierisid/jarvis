import { Component, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { getTourStep, TOUR_STEPS, type TourDescriptor, type TourStepId } from "./descriptors";
import "./tour.css";

export { getTourStep, TOUR_STEPS, type TourDescriptor, type TourStepId } from "./descriptors";

export interface TourModel {
  sessionId: string | null;
  /** Authoritative B06 position. Unknown IDs never silently become Today. */
  stepId: string;
  revision: number;
  phase: "ready" | "moving" | "error";
  theme: "light" | "dark";
  sidebar: "expanded" | "rail";
  error?: string;
}
export interface TourRoomRequest {
  step: TourDescriptor;
  theme: TourModel["theme"];
  sidebar: TourModel["sidebar"];
  mode: "tutorial";
  effects: "disabled";
  /** Keep the highlighted subject outside this lower-start overlay on wide screens.
   * At <=1024px or <=800px height the card is a separate reserved grid row. */
  cardPlacement: "workspace-lower-start";
}
export type TourRoomResult =
  | { status: "ready"; content: ReactNode }
  | { status: "unsupported" | "loading" | "error" };
/**
 * Trusted host adapter, never a live application/provider.
 * Must use actual D room components with fixture-only data and no effects/portals.
 * The view adds inert interaction containment; it cannot sandbox arbitrary JS.
 */
export interface TourRoomRenderer {
  isolation: "fixture-only";
  renderRoom: (request: TourRoomRequest) => TourRoomResult;
}
export interface TourIntent {
  sessionId: string;
  revision: number;
  from: TourStepId;
  action: "back" | "next" | "skip" | "open-pebble";
  to?: TourStepId;
}
export interface TourViewProps {
  model: TourModel;
  renderer?: TourRoomRenderer;
  onNavigate?: (intent: TourIntent) => void | Promise<void>;
  /** Match the owning shell. Values are pixels; narrow layouts ignore this inset. */
  sidebarWidth?: number;
  reducedMotion?: boolean;
}

class RoomBoundary extends Component<{ children: ReactNode; onFailure: () => void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch() { this.props.onFailure(); }
  override render() { return this.state.failed ? null : this.props.children; }
}

/** Controlled, optional presentation. No routing, fetch, storage, sockets or registration. */
export function TourView({ model, renderer, onNavigate, sidebarWidth, reducedMotion = false }: TourViewProps) {
  const uid = useId();
  const nextRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const locked = useRef<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [fault, setFault] = useState<{ key: string; message: string } | null>(null);
  const [failedRoom, setFailedRoom] = useState<string | null>(null);
  const step = getTourStep(model.stepId);
  const index = step ? TOUR_STEPS.indexOf(step) : -1;
  const key = JSON.stringify([model.sessionId, model.stepId, model.revision]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const valid = !!model.sessionId?.trim() && Number.isSafeInteger(model.revision) && model.revision >= 0 && !!step
    && ["ready", "moving", "error"].includes(model.phase);
  let room: TourRoomResult = { status: "unsupported" };
  if (step && renderer?.isolation === "fixture-only") {
    try { room = renderer.renderRoom({ step, theme: model.theme, sidebar: model.sidebar, mode: "tutorial", effects: "disabled", cardPlacement: "workspace-lower-start" }); }
    catch { room = { status: "error" }; }
  }
  const roomReady = room?.status === "ready" && room.content != null && failedRoom !== key;
  const busy = model.phase === "moving" || pending === key;
  const canNavigate = valid && !!onNavigate && !busy;
  const status = fault?.key === key ? fault.message
    : model.phase === "error" ? model.error || "The tour could not move. Try again."
    : !valid ? "Tour progress is unavailable. Return to setup to resume."
    : !onNavigate ? "Tour navigation is unavailable."
    : busy ? "Moving to the next step…"
    : !roomReady ? room?.status === "loading" ? "Loading this room preview…" : "This room preview is unavailable. You can go back or skip the tour."
    : "";
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Keep the same Next node across steps; theme/sidebar changes must not steal focus.
  useEffect(() => {
    (nextRef.current?.getAttribute("aria-disabled") === "false" ? nextRef.current : titleRef.current)?.focus({ preventScroll: true });
  }, [model.sessionId, model.stepId]);

  const navigate = (action: TourIntent["action"]) => {
    if (!canNavigate || !step || !model.sessionId || locked.current === key) return;
    if ((action === "next" || action === "open-pebble") && !roomReady) return;
    if (action === "back" && index === 0) return;
    const to = action === "back" ? TOUR_STEPS[index - 1]?.id : action === "next" ? TOUR_STEPS[index + 1]?.id : undefined;
    locked.current = key; setPending(key); setFault(null);
    const fail = () => {
      if (!mounted.current || currentKey.current !== key) return;
      locked.current = null; setPending(null); setFault({ key, message: "The tour could not move. Try again." });
    };
    try { Promise.resolve(onNavigate!({ sessionId: model.sessionId, revision: model.revision, from: step.id, action, ...(to ? { to } : {}) })).catch(fail); }
    catch { fail(); }
    // Success is not assumed from a resolved callback. The host supplies a new revision/step.
  };
  const inset = sidebarWidth !== undefined && Number.isFinite(sidebarWidth)
    ? Math.min(320, Math.max(0, sidebarWidth)) : model.sidebar === "rail" ? 72 : 232;
  return <section className="on-tour" data-theme={model.theme} data-sidebar={model.sidebar} data-reduced-motion={reducedMotion || undefined}
    style={{ "--on-tour-sidebar": `${inset}px` } as CSSProperties} aria-label="Workspace tutorial">
    <div className="on-tour__sandbox-label">Tutorial sandbox · Sample content · Actions disabled</div>
    <div className="on-tour__room" inert aria-hidden="true" data-room-id={step?.id}
      onClickCapture={event => { event.preventDefault(); event.stopPropagation(); }}
      onSubmitCapture={event => { event.preventDefault(); event.stopPropagation(); }}>
      {roomReady && <RoomBoundary key={key} onFailure={() => setFailedRoom(key)}>{room.status === "ready" ? room.content : null}</RoomBoundary>}
    </div>
    <div className="on-tour__dock">
      <section className="on-tour__card" aria-labelledby={`${uid}-title`} aria-describedby={`${uid}-body`} aria-busy={busy}>
        <p className="on-tour__eyebrow" aria-live="polite" aria-atomic="true">
          <span>Your workspace</span><span aria-hidden="true">·</span>
          <span className="on-tour__count">{index < 0 ? "--" : String(index + 1).padStart(2, "0")} / 12</span>
          <span aria-hidden="true">·</span><span>{step?.room ?? "Unavailable"}</span>
        </p>
        <h2 ref={titleRef} tabIndex={-1} id={`${uid}-title`}>{step?.title ?? "Your tour will resume here."}</h2>
        <p className="on-tour__body" id={`${uid}-body`}>{step?.body ?? "Your progress has not been changed."}</p>
        <p className="on-tour__status" role="status" aria-live="polite">{status || "\u00a0"}</p>
        <footer className="on-tour__actions">
          <button type="button" className="on-tour__quiet on-tour__skip" aria-disabled={!canNavigate} onClick={() => navigate("skip")}>Skip tour</button>
          <button type="button" className="on-tour__quiet" aria-disabled={!canNavigate || index <= 0} onClick={() => navigate("back")}>Back</button>
          <button type="button" className="on-tour__primary" ref={nextRef} aria-disabled={!canNavigate || !roomReady}
            onClick={() => navigate(step?.id === "pebble" ? "open-pebble" : "next")}>{step?.id === "pebble" ? "Open Pebble" : "Next"}</button>
        </footer>
      </section>
    </div>
  </section>;
}
