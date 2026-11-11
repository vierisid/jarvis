import React, { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BriefShellPort } from "../../contracts";
import { PebbleCompanion } from "../../shell/pebble-layout/PebbleCompanion";
import { usePebbleWorkspace } from "../../shell/pebble-layout/PebbleLayout";
import { HeroPaper } from "../hero-paper/HeroPaper";
import { decisionView, type DecisionBinding } from "../hero-paper/model";
import "./today-layout.css";

/** D-09/10/11 supply their independently gated views. No fabricated fallback cards. */
export interface TodaySlots { goal?: ReactNode; outcomes?: ReactNode; activity?: ReactNode; opportunities?: ReactNode; queueNotice?: ReactNode; gettingStarted?: ReactNode }
export function TodayLayout({ shell, greeting, dateLabel, dateTime, decision, slots = {}, reducedMotion = false }: {
  shell: BriefShellPort; greeting: string; dateLabel: string; dateTime?: string;
  decision?: DecisionBinding; slots?: TodaySlots; reducedMotion?: boolean;
}) {
  const workspace = usePebbleWorkspace();
  const compact = workspace.open || workspace.layout === "single";
  const greetingRef = useRef<HTMLElement>(null);
  const [greetingBox, setGreetingBox] = useState({ top: 32, height: 74 });
  useLayoutEffect(() => {
    const header = greetingRef.current;
    if (!header) return;
    const host = header.closest<HTMLElement>(".brief-pebble-layout");
    const main = header.closest("main");
    // The goal card is positioned inside the pebble layout, not inside the page, so
    // it must follow where the greeting really sits: notices above Today push it down.
    const measure = () => {
      const box = header.getBoundingClientRect();
      const top = Math.round(box.top - (host?.getBoundingClientRect().top ?? 0) + (main?.scrollTop ?? 0));
      const height = Math.max(74, box.height);
      setGreetingBox(current => current.top === top && current.height === height ? current : { top, height });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(header);
    // A notice appearing or leaving moves the greeting without resizing it.
    const mutations = new MutationObserver(measure);
    if (main) mutations.observe(main, { childList: true, subtree: true });
    return () => { observer.disconnect(); mutations.disconnect(); };
  }, []);
  return <div className="brief-today-layout" data-compact={compact} data-single={workspace.layout === "single"}
    data-chat={workspace.open} data-goal={!!slots.goal} data-reduce-motion={reducedMotion}>
    <header ref={greetingRef} className="brief-today-greeting"><time className="brief-type-data brief-secondary" dateTime={dateTime}>{dateLabel}</time>
      <h1 className="brief-type-today-greeting">{greeting}</h1></header>
    {slots.goal && <PebbleCompanion top={greetingBox.top} closedTop={greetingBox.top + greetingBox.height + 26}>{slots.goal}</PebbleCompanion>}
    <div className="brief-today-primary"><HeroPaper binding={decisionView(shell.mode, decision)} reducedMotion={reducedMotion} queueNotice={slots.queueNotice} emptyContent={slots.gettingStarted} />{decisionView(shell.mode, decision).state.status !== "empty" && slots.gettingStarted}</div>
    {slots.outcomes && <div className="brief-today-outcomes">{slots.outcomes}</div>}
    {slots.activity && <div className="brief-today-activity">{slots.activity}</div>}
    {slots.opportunities && <section className="brief-today-opportunities" aria-label="Opportunities"><h2 className="brief-type-section-heading">Opportunities</h2>{slots.opportunities}</section>}
  </div>;
}
