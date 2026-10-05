import React, { createContext, useContext, useId, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { BriefShellPort } from "../../contracts";
import { BriefTooltip } from "../../components/controls";
import { BriefBrand } from "../../styles/BriefBrand";
import { useBriefMotion } from "../../motion";
import { pebbleGeometry, PEBBLE_SIZE } from "./layout";
import "./pebble.css";

/** The composition root supplies its ONE existing conversation. This host never
 * creates a thread, connection, request, microphone, or persistence layer. */
export interface BriefConversationBinding {
  source: "live" | "fixture";
  content: React.ReactNode;
}
export interface PebbleWorkspace {
  open: boolean;
  layout: "split" | "single";
  workingWidth: number;
  conversationWidth: number;
}
const WorkspaceContext = createContext<PebbleWorkspace>({ open: false, layout: "split", workingWidth: 0, conversationWidth: 0 });
/** Rooms can adapt their existing composition without replacing/remounting it.
 * CSS container queries on brief-work are preferred for purely visual changes. */
export const usePebbleWorkspace = () => useContext(WorkspaceContext);

export function PebbleLayout({ shell, enabled, conversation, children, reducedMotion = false }: {
  shell: BriefShellPort; enabled: boolean; conversation?: BriefConversationBinding;
  children: React.ReactNode; reducedMotion?: boolean;
}) {
  const id = useId();
  const host = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const work = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const valid = conversation?.source === (shell.mode === "preview" ? "fixture" : "live");
  const available = enabled && valid;
  const open = available && shell.chatOpen;
  const geometry = pebbleGeometry(size.width, size.height);
  const { single, inset, panelWidth, panelHeight, reservedWidth } = geometry;
  // Resizing the enclosing workspace follows that boundary directly. Only an
  // explicit open/close animates these surfaces, avoiding compounded sidebar lag.
  const previous = useRef({ open, ...size });
  const resizing = previous.current.open === open && (previous.current.width !== size.width || previous.current.height !== size.height);
  const reserve = useBriefMotion<HTMLDivElement>({ width: open ? reservedWidth : 0 },
    { kind: "reflow", active: open, immediate: resizing, reduced: reducedMotion });
  const surface = useBriefMotion<HTMLElement>({ width: open ? panelWidth : PEBBLE_SIZE, height: open ? panelHeight : PEBBLE_SIZE },
    { kind: "reflow", active: open, immediate: resizing, reduced: reducedMotion });
  const panelBody = useBriefMotion<HTMLDivElement>({ opacity: open ? 1 : 0 },
    { kind: "reveal", active: open, reduced: reducedMotion });
  const wasOpen = useRef(false);
  useLayoutEffect(() => { previous.current = { open, ...size }; });
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize(current => current.width === width && current.height === height ? current : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // The composer is at the origin and can be focused without scrolling the
      // still-unfolding surface. Conversation implementations opt in explicitly.
      (panelBody.current?.querySelector<HTMLElement>("[data-pebble-focus]") ?? panelBody.current)?.focus({ preventScroll: true });
    } else if (!open && wasOpen.current) {
      // Do not steal focus from a room action or a menu on capability changes.
      const focused = document.activeElement;
      if (!focused || focused === document.body || panelBody.current?.contains(focused)) restoreFocus();
    }
    wasOpen.current = open;
  }, [open]);
  useLayoutEffect(() => {
    // A resize into the single-pane fallback must not strand focus in hidden work.
    if (open && single && work.current?.contains(document.activeElement)) panelBody.current?.focus({ preventScroll: true });
  }, [open, single]);
  function restoreFocus() {
    const origin = returnFocus.current;
    const usable = origin?.isConnected && origin !== document.body && !origin.closest("[inert], [aria-hidden='true']");
    const target = usable ? origin : available ? opener.current : work.current?.querySelector<HTMLElement>("main");
    target?.focus({ preventScroll: true });
  }
  function close() { shell.setChatOpen(false); }
  const value: PebbleWorkspace = { open, layout: single ? "single" : "split",
    workingWidth: size.width - (open ? reservedWidth : 0), conversationWidth: panelWidth };
  return <WorkspaceContext.Provider value={value}>
    <div className="brief-pebble-layout" ref={host} data-pebble-open={open} data-pebble-layout={single ? "single" : "split"}
      data-pebble-available={available} style={{ "--pebble-inset": `${inset}px` } as React.CSSProperties}>
      <div className="brief-pebble-work" ref={work} inert={open && single} aria-hidden={open && single || undefined}>
        {children}
      </div>
      <div className="brief-pebble-reserve" ref={reserve} aria-hidden="true" />
      <section ref={surface} id={id} className="brief-pebble-surface" aria-label="Conversation" aria-hidden={!open} inert={!open}>
        <div className="brief-pebble-reading" ref={panelBody} tabIndex={-1} style={{ width: Math.max(0, panelWidth - 2), height: Math.max(0, panelHeight - 2) }}
          onKeyDown={event => {
            if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
              event.preventDefault(); event.stopPropagation(); close();
            }
          }}>
          <button type="button" className="brief-pebble-close" aria-label="Close conversation" onClick={close}>
            <X size={16} aria-hidden="true" />
          </button>
          <div className="brief-pebble-content">{valid ? conversation?.content : null}</div>
        </div>
      </section>
      <div className="brief-pebble-origin" aria-hidden={!available || open} inert={!available || open}>
        <BriefTooltip label="Open conversation" disabled={!available || open}>
          <button ref={opener} type="button" className="brief-pebble-opener" aria-label="Open conversation" aria-controls={id} aria-expanded={open}
            tabIndex={available && !open ? 0 : -1} onClick={() => shell.setChatOpen(true)}>
            <span className="brief-pebble-mark" aria-hidden="true"><BriefBrand /></span>
          </button>
        </BriefTooltip>
      </div>
    </div>
  </WorkspaceContext.Provider>;
}
