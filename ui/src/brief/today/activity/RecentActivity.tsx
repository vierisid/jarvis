import React from "react";
import { ArrowRight } from "lucide-react";
import type { BriefRoute } from "../../contracts";
import type { BriefViewPort } from "../../contracts";
import "./activity.css";

export interface RecentActivityItem {
  activityId: string;
  title: string;
  /** Owner-formatted time label; no client freshness invention. */
  timeLabel: string;
  occurredAt: number;
  detail: string;
  destination?: BriefRoute;
}
export function RecentActivity({ mode, binding, onOpen }: { mode: "live" | "preview"; binding?: BriefViewPort<readonly RecentActivityItem[]>; onOpen?: (destination: BriefRoute) => void }) {
  // Workflow runs feed this list, so it does not wait on the outcome evidence capabilities.
  const state = binding?.source === (mode === "live" ? "live" : "fixture") ? binding.state : { status: "unavailable" as const, reason: "Activity is not available yet." };
  const rows = state.status === "ready" || state.status === "stale" ? state.data : null;
  return <section className="brief-recent-activity brief-surface" aria-label="Recent activity" data-state={state.status}>
    <h2 className="brief-type-body-emphasis">Recent activity</h2>
    {state.status === "stale" && <p className="brief-type-utility brief-secondary" role="status">Previously reported · {state.reason}</p>}
    {rows?.length ? <ul>{rows.map(item => {
      const content = <><strong className="brief-type-body-emphasis">{item.title}</strong><span className="brief-activity-meta brief-type-utility brief-secondary"><time dateTime={new Date(item.occurredAt).toISOString()}>{item.timeLabel}</time> · {item.detail}</span></>;
      return <li key={item.activityId} data-activity-id={item.activityId}>{item.destination && onOpen
        ? <button className="brief-activity-row" onClick={() => onOpen(item.destination!)}>{content}<ArrowRight size={14} aria-hidden="true" /></button>
        : <div className="brief-activity-row">{content}</div>}</li>;
    })}</ul> : <p className="brief-type-body brief-secondary" role="status">{state.status === "loading" ? "Loading recent activity…" : state.status === "empty" || rows ? "No workflow has run yet." : "Activity is not available yet."}</p>}
  </section>;
}
