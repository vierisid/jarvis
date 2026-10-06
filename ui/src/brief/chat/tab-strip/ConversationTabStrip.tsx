import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { BriefIconButton } from "../../components/controls";
import { BRIEF_MOTION, createBriefMotion, useBriefReducedMotion } from "../../motion";
import { chatTabId, chatTabWidth, tabsMode, type ChatTab, type ConversationTabsBinding } from "./model";
import "./tabs.css";

interface Props {
  mode: "live" | "preview";
  binding?: ConversationTabsBinding;
  /** The caller's mounted conversation panel. Its content/state stays with F-04. */
  panelId: string;
  reducedMotion?: boolean;
}

/** Manual-activation tabs: arrows explore; Enter/Space selects; Delete closes.
 * The shell owns its separate panel X. The trailing reservation keeps that target still. */
export function ConversationTabStrip(props: Props) {
  const status = tabsMode(props.mode, props.binding);
  if (status !== "scoped") return <div className="brief-chat-tabs-fallback" role="status" data-tabs-mode={status}>
    {status === "loading" ? "Loading conversations…" : status === "unavailable" ? "Conversations unavailable" : "Conversation"}
  </div>;
  return <ScopedTabs key={props.binding!.scopeId} {...props} binding={props.binding!} />;
}

function ScopedTabs({ binding, panelId, reducedMotion }: Props & { binding: ConversationTabsBinding }) {
  const { tabs, activeId } = binding;
  const reduced = useBriefReducedMotion(reducedMotion);
  const viewport = useRef<HTMLDivElement>(null), header = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focused = useRef<string | null>(null), lock = useRef(false), mounted = useRef(true);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const [roving, setRoving] = useState(activeId ?? tabs[0]?.id ?? null);
  const [width, setWidth] = useState(0);
  // Removed objects remain only for the short width exit, never as actionable tabs.
  const [displayed, setDisplayed] = useState<readonly ChatTab[]>(tabs);
  const initialIds = useRef(new Set(tabs.map(tab => tab.id)));
  const idsKey = JSON.stringify(tabs.map(tab => tab.id));
  const liveIds = new Set(tabs.map(tab => tab.id));
  const merged = [...displayed];
  for (const tab of tabs) if (!merged.some(item => item.id === tab.id)) merged.push(tab);
  const current = new Map(tabs.map(tab => [tab.id, tab]));
  const busy = pending || binding.status.pending > 0;
  const focusId = liveIds.has(roving ?? "") ? roving : activeId ?? tabs[0]?.id ?? null;
  const reveal = (id: string | null) => {
    const strip = viewport.current, button = id ? buttons.current.get(id) : null;
    if (!strip || !button) return;
    const target = button.getBoundingClientRect(), box = strip.getBoundingClientRect();
    if (target.left < box.left) strip.scrollLeft += target.left - box.left;
    else if (target.right > box.right) strip.scrollLeft += target.right - box.right;
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(0, element.clientWidth - 4));
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => {
    const finish = () => { setDisplayed(tabs); initialIds.current = new Set(tabs.map(tab => tab.id)); };
    if (reduced) { finish(); return; }
    const timer = setTimeout(finish, BRIEF_MOTION.selection.enter);
    return () => clearTimeout(timer);
  }, [idsKey, reduced]);
  useLayoutEffect(() => {
    // Only recover focus that was on a now-removed tab/close control. Never steal
    // focus from the composer when a remote update or background close arrives.
    if (focused.current && !liveIds.has(focused.current)) {
      const next = activeId ?? tabs[0]?.id ?? null;
      setRoving(next); focused.current = next;
      if (next) buttons.current.get(next)?.focus({ preventScroll: true });
      else header.current?.querySelector<HTMLButtonElement>('[aria-label="New conversation"]')?.focus({ preventScroll: true });
    }
    if (!focused.current) setRoving(activeId ?? tabs[0]?.id ?? null);
    reveal(activeId);
    // Follow the growing edge during the same local transition, rather than
    // scrolling to a zero-width new tab and correcting it after the animation.
    const until = performance.now() + (reduced ? 0 : BRIEF_MOTION.selection.enter);
    let frame = 0;
    const follow = () => {
      reveal(focused.current && liveIds.has(focused.current) ? focused.current : activeId);
      if (performance.now() < until) frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [idsKey, activeId, width, reduced]);
  async function perform(kind: "add" | "select" | "close", id?: string) {
    if (lock.current || binding.status.pending > 0 || (id && !liveIds.has(id))) return;
    if (kind === "select" && id === activeId) return;
    lock.current = true; setPending(true); setError(null);
    try { if (kind === "add") await binding.actions.add(); else await binding.actions[kind](id!); }
    catch { if (mounted.current) setError("Conversation change failed. Try again."); }
    finally { lock.current = false; if (mounted.current) setPending(false); }
  }
  function keyDown(event: React.KeyboardEvent, id: string) {
    const index = tabs.findIndex(tab => tab.id === id);
    let next: string | undefined;
    if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length]?.id;
    if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length]?.id;
    if (event.key === "Home") next = tabs[0]?.id;
    if (event.key === "End") next = tabs.at(-1)?.id;
    if (next) { event.preventDefault(); setRoving(next); buttons.current.get(next)?.focus({ preventScroll: true }); reveal(next); }
    if (event.key === "Delete") { event.preventDefault(); void perform("close", id); }
  }
  return <>
    <div className="brief-chat-tabs-header" ref={header} data-tabs-mode="scoped" data-reduced-motion={reduced}>
      <div className="brief-chat-tabs-viewport" ref={viewport} role="tablist" aria-label="Conversations" aria-busy={busy}
        onFocusCapture={event => { focused.current = (event.target as HTMLElement).closest<HTMLElement>("[data-chat-id]")?.dataset.chatId ?? null; }}
        onBlurCapture={event => { if (event.relatedTarget && !viewport.current?.contains(event.relatedTarget as Node)) { focused.current = null; setRoving(activeId ?? tabs[0]?.id ?? null); } }}>
        {merged.map(previous => {
          const tab = current.get(previous.id) ?? previous, exiting = !liveIds.has(tab.id);
          return <AnimatedTab key={tab.id} width={exiting ? 0 : chatTabWidth(width, tabs.length)} exiting={exiting}
            entering={!initialIds.current.has(tab.id)} reduced={reduced}>
            <div className="brief-chat-tab" data-chat-id={tab.id} data-selected={activeId === tab.id}>
              <button type="button" role="tab" id={chatTabId(panelId, tab.id)} aria-controls={panelId}
                aria-selected={!exiting && activeId === tab.id} aria-disabled={busy || exiting} tabIndex={!exiting && focusId === tab.id ? 0 : -1}
                ref={element => { if (element) buttons.current.set(tab.id, element); else buttons.current.delete(tab.id); }}
                onFocus={() => { setRoving(tab.id); reveal(tab.id); }} title={tab.title} aria-label={tab.title}
                onKeyDown={event => keyDown(event, tab.id)} onClick={() => void perform("select", tab.id)}>
                <span>{tab.title}</span>
              </button>
              <button className="brief-chat-tab-close" type="button" aria-label={`Close ${tab.title}`} aria-disabled={busy || exiting}
                tabIndex={!exiting && focusId === tab.id ? 0 : -1} onKeyDown={event => keyDown(event, tab.id)}
                onClick={() => void perform("close", tab.id)}><X size={10} aria-hidden="true" /></button>
            </div>
          </AnimatedTab>;
        })}
      </div>
      <BriefIconButton label="New conversation" size="sm" icon={<Plus size={18}/>} aria-disabled={busy} onClick={() => void perform("add")} />
    </div>
    <span className="brief-chat-tabs-feedback" role="status">{error || binding.status.error || ""}</span>
  </>;
}

function AnimatedTab({ width, entering, exiting, reduced, children }: { width: number; entering: boolean; exiting: boolean; reduced: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), motion = useRef<ReturnType<typeof createBriefMotion> | null>(null);
  const initial = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current!;
    if (entering) element.style.width = "0px";
    motion.current = createBriefMotion(element);
    return () => { motion.current?.dispose(); motion.current = null; initial.current = true; };
  }, []);
  useLayoutEffect(() => {
    motion.current?.to({ width }, { kind: "selection", active: !exiting, reduced, immediate: initial.current && !entering });
    initial.current = false;
  }, [width, reduced, exiting]);
  return <div ref={ref} className="brief-chat-tab-slot" role="presentation" inert={exiting || undefined} aria-hidden={exiting || undefined} data-exiting={exiting}>{children}</div>;
}
