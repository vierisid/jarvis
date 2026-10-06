import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ReadingPosition } from "./model";

export interface ReadingSnapshot extends ReadingPosition { anchor?: string; offset?: number }
export interface ThreadMemory { reading: ReadingSnapshot; expanded: Record<string, boolean> }
export const nearBottom = (element: HTMLElement) => element.scrollHeight - element.clientHeight - element.scrollTop <= 24;

/** Stable article/block identities survive appends, history prepends and width changes. */
function anchors(element: HTMLElement) {
  const result: { id: string; node: HTMLElement }[] = [];
  element.querySelectorAll<HTMLElement>("[data-thread-item]").forEach(article => {
    const key = article.dataset.threadItem!;
    let block = 0;
    article.querySelectorAll<HTMLElement>("[data-reading-anchor], .brief-reply-prose :is(p,h1,h2,h3,h4,h5,h6,pre,li,table)").forEach(node => {
      const id = node.dataset.readingAnchor ?? `block:${block++}`;
      if (!node.closest("[hidden]")) result.push({ id: `${key}/${id}`, node });
    });
  });
  return result;
}
export function captureReading(element: HTMLElement, preferred?: HTMLElement): ReadingSnapshot {
  const top = element.getBoundingClientRect().top;
  const items = anchors(element);
  const anchor = preferred ? items.find(item => item.node === preferred)
    : items.find(item => item.node.getBoundingClientRect().bottom > top + 1);
  return { top: element.scrollTop, atBottom: preferred ? false : nearBottom(element),
    ...(anchor ? { anchor: anchor.id, offset: anchor.node.getBoundingClientRect().top - top } : {}) };
}
export function restoreReading(element: HTMLElement, reading: ReadingSnapshot) {
  if (reading.atBottom) { element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight); return; }
  const candidates = anchors(element);
  // A finished activity may condense while its row is being read. Its summary
  // replaces that row as the anchor, rather than jumping to an unrelated reply.
  const match = reading.anchor && (candidates.find(item => item.id === reading.anchor)
    ?? (reading.anchor.includes("/activity:") ? candidates.find(item => item.id === `${reading.anchor!.split("/activity:")[0]}/activity-toggle`) : undefined));
  const next = match ? element.scrollTop + match.node.getBoundingClientRect().top - element.getBoundingClientRect().top - (reading.offset ?? 0) : reading.top;
  element.scrollTop = Math.max(0, Math.min(Math.max(0, element.scrollHeight - element.clientHeight), next));
}

export function useReadingPosition(viewport: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>, memory: ThreadMemory,
  save: (position: ReadingPosition) => void, revision: unknown) {
  const [following, setFollowing] = useState(memory.reading.atBottom);
  const lastSaved = useRef<ReadingPosition>(memory.reading);
  const saveLatest = useRef(save); saveLatest.current = save;
  const applying = useRef(false);
  const persist = (position: ReadingPosition) => {
    if (lastSaved.current.top === position.top && lastSaved.current.atBottom === position.atBottom) return;
    lastSaved.current = { top: position.top, atBottom: position.atBottom };
    saveLatest.current(lastSaved.current);
  };
  const capture = (preferred?: HTMLElement) => {
    const el = viewport.current; if (!el || !el.clientHeight) return;
    memory.reading = captureReading(el, preferred);
    setFollowing(memory.reading.atBottom); persist(memory.reading);
  };
  const restore = () => {
    const el = viewport.current; if (!el || !el.clientHeight) return;
    applying.current = true;
    restoreReading(el, memory.reading);
    // Keep the semantic anchor while a sidebar reflow changes width repeatedly.
    memory.reading.top = el.scrollTop;
    if (el.scrollHeight <= el.clientHeight) memory.reading.atBottom = true;
    setFollowing(nearBottom(el));
    persist(memory.reading); applying.current = false;
  };
  useLayoutEffect(restore, [revision]);
  useLayoutEffect(() => {
    const el = viewport.current, body = content.current;
    if (!el || !body) return;
    const observer = new ResizeObserver(restore); observer.observe(el); observer.observe(body);
    return () => observer.disconnect();
  }, []);
  return { following, beforeToggle: capture,
    onScroll: () => {
      if (applying.current) return;
      const el = viewport.current;
      // Browser scroll events caused by our restoration must not replace its anchor.
      if (el && Math.abs(el.scrollTop - memory.reading.top) > .5) capture();
    },
    toLatest: () => { memory.reading = { top: 0, atBottom: true }; setFollowing(true); restore(); },
  };
}
