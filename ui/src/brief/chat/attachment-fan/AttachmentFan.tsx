import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, Image, ScanLine, Plus } from "lucide-react";
import { BriefTooltip } from "../../components/controls";
import { useBriefMotion, useBriefReducedMotion } from "../../motion";
import { attachmentChoices, fanAvailable, type AttachmentChoice, type AttachmentFanBinding } from "./model";
import "./attachment-fan.css";

const names = { document: "Document", image: "Image", screenshot: "Screenshot" };
const icons = { document: FileText, image: Image, screenshot: ScanLine };
interface Props {
  mode: "preview" | "live";
  binding?: AttachmentFanBinding;
  reducedMotion?: boolean;
  /** Render feedback in the host's reserved status area, including upload failures. */
  onFeedback: (message: string) => void;
}
export function AttachmentFan(props: Props) {
  return <ScopedFan key={JSON.stringify([props.binding?.source, props.binding?.scopeId, props.binding?.conversationId])} {...props} />;
}
function ScopedFan({ mode, binding, reducedMotion, onFeedback }: Props) {
  const id = useId(), anchor = useRef<HTMLButtonElement>(null), layer = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false), [focused, setFocused] = useState(false);
  const [theme, setTheme] = useState("light");
  const [distance, setDistance] = useState(108), [compact, setCompact] = useState(false);
  const reduced = useBriefReducedMotion(reducedMotion), available = fanAvailable(mode, binding);
  const controller = useRef<AbortController | null>(null), alive = useRef(true), initialFocus = useRef(false);
  const openNow = useRef(open); openNow.current = open;
  const glyph = useBriefMotion<HTMLSpanElement>({ transform: `rotate(${open ? 45 : 0}deg)` }, { kind: "selection", active: open, reduced });
  const close = (restore = false) => { setOpen(false); if (restore) anchor.current?.focus({ preventScroll: true }); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (!available) { close(); if (controller.current) onFeedback(""); controller.current?.abort(); setBusy(false); } }, [available]);
  // Follow the actual composer during growth and shell reflow. No separate geometry owner.
  // The body portal escapes Pebble's clip; explicit theme prevents a mixed-theme menu.
  useLayoutEffect(() => {
    const target = anchor.current, element = layer.current;
    if (!target || !element) return;
    let raf = 0;
    const place = () => {
      const rect = target.getBoundingClientRect();
      const composer = target.closest(".brief-composer");
      const clearance = composer?.querySelector(".brief-composer-suggestions") ?? composer?.querySelector(".brief-composer-surface");
      const top = clearance?.getBoundingClientRect().top ?? rect.top - 52;
      const next = Math.max(60, rect.top - top + 56);
      const headerBottom = target.closest(".brief-pebble-reading")?.querySelector(".brief-chat-tabs-header")?.getBoundingClientRect().bottom ?? 0;
      setCompact(rect.top - next - 104 < Math.max(8, headerBottom + 12));
      element.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 174))}px`;
      element.style.top = `${rect.top}px`;
      setDistance(previous => previous === next ? previous : next);
      setTheme(target.closest<HTMLElement>(".brief-root")?.dataset.briefTheme ?? document.documentElement.dataset.theme ?? "light");
      if (target.closest('[inert], [aria-hidden="true"]')) {
        element.style.visibility = "hidden";
        if (openNow.current) close();
        controller.current?.abort();
      } else element.style.visibility = "visible";
    };
    const until = performance.now() + 280;
    const tick = () => { place(); if (open || performance.now() < until) raf = requestAnimationFrame(tick); };
    place();
    raf = requestAnimationFrame(tick);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    resize?.observe(target); const composer = target.closest(".brief-composer"); if (composer) resize?.observe(composer);
    const observer = new MutationObserver(place);
    const root = target.closest(".brief-root"); if (root) observer.observe(root, { attributes: true, subtree: true, attributeFilter: ["data-brief-theme", "aria-hidden", "inert"] });
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { cancelAnimationFrame(raf); resize?.disconnect(); observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && (layer.current?.contains(target) || anchor.current?.contains(target));
    const outside = (event: Event) => { if (!inside(event.target)) close(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    if (initialFocus.current) { layer.current?.querySelector<HTMLButtonElement>('[data-choice="document"]')?.focus(); initialFocus.current = false; }
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  async function choose(kind: AttachmentChoice) {
    if (!available || !binding || busy || controller.current || (kind === "screenshot" && !binding.screenshot.available)) return;
    const request = new AbortController(); controller.current = request; setBusy(true);
    close(true); onFeedback(`Adding ${names[kind].toLowerCase()}…`);
    try {
      const result = await binding.choose(kind, request.signal);
      if (alive.current && !request.signal.aborted) onFeedback(result === "attached" ? `${names[kind]} attached.` : "");
    } catch {
      if (alive.current && !request.signal.aborted) onFeedback(`Could not add ${names[kind].toLowerCase()}. Try again.`);
    } finally {
      if (controller.current === request) controller.current = null;
      if (alive.current) setBusy(false);
    }
  }
  function keys(event: React.KeyboardEvent) {
    const rows = [...layer.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Tab") { close(true); return; }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      // Document is nearest the origin; ArrowUp moves outward toward Screenshot.
      const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (["ArrowUp", "ArrowRight"].includes(event.key) ? 1 : -1) + 3) % 3;
      rows[next]?.focus();
    }
  }
  return <>
    <BriefTooltip label={!available ? binding?.reason ?? "Attachments unavailable" : busy ? "Adding attachment…" : "Add attachment"} disabled={open} delay={350}>
      <button ref={anchor} type="button" className="brief-fan-toggle" aria-label={open ? "Close attachments" : "Add attachment"}
        aria-haspopup="menu" aria-expanded={open} aria-controls={id} aria-disabled={!available || busy}
        data-intent={open || ((hover || focused) && available)} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}
        onFocus={event => setFocused(event.currentTarget.matches(":focus-visible"))} onBlur={() => setFocused(false)}
        onClick={event => { if (available && !busy) { initialFocus.current = event.detail === 0; setOpen(value => !value); } }}
        onKeyDown={event => { if ((event.key === "ArrowUp" || event.key === "ArrowDown") && available && !busy) { event.preventDefault(); if (open) layer.current?.querySelector<HTMLButtonElement>('[data-choice="document"]')?.focus(); else { initialFocus.current = true; setOpen(true); } } }}>
        <span className="brief-fan-toggle-surface" /><span ref={glyph} className="brief-fan-glyph"><Plus size={12} aria-hidden="true" /></span>
      </button>
    </BriefTooltip>
    {createPortal(<div className="brief-root brief-fan-portal" data-brief-theme={theme}>
      <div ref={layer} className="brief-fan-layer" role="menu" aria-orientation={compact ? "horizontal" : "vertical"} aria-label="Attachments" id={id} aria-hidden={!open} inert={!open}
        data-open={open} data-compact={compact} data-reduced-motion={reduced} onKeyDown={keys}>
        {attachmentChoices.map((kind, index) => <Choice key={kind} kind={kind} index={index} open={open} reduced={reduced}
          distance={distance} compact={compact} disabled={busy || !available || (kind === "screenshot" && !binding?.screenshot.available)}
          reason={kind === "screenshot" && !binding?.screenshot.available ? binding?.screenshot.reason ?? "Requires a connected desktop with capture enabled." : undefined}
          onChoose={() => void choose(kind)} />)}
      </div>
    </div>, document.body)}
  </>;
}
function Choice({ kind, index, open, reduced, distance, compact, disabled, reason, onChoose }: {
  kind: AttachmentChoice; index: number; open: boolean; reduced: boolean; distance: number; compact: boolean; disabled: boolean; reason?: string; onChoose: () => void;
}) {
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => {
    if (reduced) { setShown(open); return; }
    const timer = setTimeout(() => setShown(open), (open ? index : 2 - index) * 30);
    return () => clearTimeout(timer);
  }, [open, reduced, index]);
  const ref = useBriefMotion<HTMLDivElement>({ transform: `translate(${shown && compact ? index * 52 : 0}px, ${shown ? -(distance + (compact ? 0 : index * 52)) : 0}px)`, opacity: shown ? 1 : 0 }, { kind: "reveal", active: shown, reduced });
  const Icon = icons[kind], description = useId();
  return <div ref={ref} className="brief-fan-item">
    <button type="button" role="menuitem" data-choice={kind} aria-label={names[kind]} aria-disabled={disabled}
      aria-describedby={reason ? description : undefined} tabIndex={open ? 0 : -1} onClick={() => { if (!disabled) onChoose(); }}>
      <span className="brief-fan-circle"><Icon size={16} aria-hidden="true" /></span>
      <span className="brief-fan-name">{names[kind]}</span>
      {reason && <span className="brief-fan-reason" id={description}>{reason}</span>}
    </button>
  </div>;
}
