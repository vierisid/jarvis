import React, { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BriefShellPort } from "../../contracts";
import { PebbleCompanion } from "../../shell/pebble-layout/PebbleCompanion";
import { usePebbleWorkspace } from "../../shell/pebble-layout/PebbleLayout";
import { HeroPaper } from "../hero-paper/HeroPaper";
import { decisionView, type DecisionBinding } from "../hero-paper/model";
import "./today-layout.css";

/** D-09/10/11 supply their independently gated views. No fabricated fallback cards. */
export interface TodaySlots { goal?: ReactNode; outcomes?: ReactNode; activity?: ReactNode; opportunities?: ReactNode; queueNotice?: ReactNode }
export function TodayLayout({ shell, greeting, dateLabel, dateTime, decision, slots = {}, reducedMotion = false }: {
  shell: BriefShellPort; greeting: string; dateLabel: string; dateTime?: string;
  decision?: DecisionBinding; slots?: TodaySlots; reducedMotion?: boolean;
}) {
  const workspace = usePebbleWorkspace();
  const compact = workspace.open || workspace.layout === "single";
  const greetingRef = useRef<HTMLElement>(null);
  const [greetingHeight, setGreetingHeight] = useState(74);
  useLayoutEffect(() => {
    const header = greetingRef.current;
    if (!header) return;
    const measure = () => setGreetingHeight(Math.max(74, header.getBoundingClientRect().height));
    measure(); const observer = new ResizeObserver(measure); observer.observe(header);
    return () => observer.disconnect();
  }, []);
  return <div className="brief-today-layout" data-compact={compact} data-single={workspace.layout === "single"}
    data-chat={workspace.open} data-goal={!!slots.goal} data-reduce-motion={reducedMotion}>
    <header ref={greetingRef} className="brief-today-greeting"><time className="brief-type-data brief-secondary" dateTime={dateTime}>{dateLabel}</time>
      <h1 className="brief-type-today-greeting">{greeting}</h1></header>
    {slots.goal && <PebbleCompanion closedTop={greetingHeight + 58}>{slots.goal}</PebbleCompanion>}
    <div className="brief-today-primary"><HeroPaper binding={decisionView(shell.mode, decision)} reducedMotion={reducedMotion} queueNotice={slots.queueNotice} /></div>
    {slots.outcomes && <div className="brief-today-outcomes">{slots.outcomes}</div>}
    {slots.activity && <div className="brief-today-activity">{slots.activity}</div>}
    {slots.opportunities && <section className="brief-today-opportunities" aria-label="Opportunities"><h2 className="brief-type-section-heading">Opportunities</h2>{slots.opportunities}</section>}
  </div>;
}
