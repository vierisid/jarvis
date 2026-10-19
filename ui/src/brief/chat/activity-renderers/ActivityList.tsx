import React, { useId } from "react";
import { ChevronDown } from "lucide-react";
import { activityCategory, activityText, running, type Activity, type ReplyTurn } from "../message/model";

export function ActivityList({ activities, turn, expanded, toggle, connected, reduced }: {
  activities: Activity[]; turn?: ReplyTurn; expanded: boolean; toggle(): void; connected: boolean; reduced: boolean;
}) {
  const id = useId();
  const current = running(turn) && connected ? activities.findLast(a => a.phase === "started" && a.live) : undefined;
  const failed = activities.filter(a => a.phase === "failed").length;
  const summary = running(turn) ? (connected ? "Working" : "Reconnecting") : `${activities.length} ${activities.length === 1 ? "activity" : "activities"}${failed ? ` · ${failed} failed` : activities.every(a => a.phase === "completed") ? " finished" : " recorded"}`;
  return <div className="brief-reply-activity" data-reduced={reduced}>
    <button type="button" className="brief-activity-toggle" aria-expanded={expanded} aria-controls={id} onClick={toggle} data-reading-anchor="activity-toggle">
      <span className="brief-activity-signature" aria-hidden="true"><i/><i/><i/></span>
      <span>{expanded ? "Hide activity" : summary}</span><ChevronDown size={14} aria-hidden="true"/>
    </button>
    <ol id={id} hidden={!expanded} className="brief-activity-list">
      {activities.map(activity => {
        const category = activityCategory(activity);
        const label = activity.phase === "completed" ? "Finished" : activity.phase === "failed" ? "Failed"
          : running(turn) ? (connected ? "Working" : "Paused") : "Unfinished";
        return <li key={activity.activityId} data-activity-id={activity.activityId} data-tone={category.tone} data-reading-anchor={`activity:${activity.activityId}`}>
          <span className="brief-activity-marker" aria-hidden="true" data-current={activity === current}/>
          <span className="brief-activity-category">{category.label}</span>
          <span className="brief-activity-phase" data-failed={activity.phase === "failed"}>{label}</span>
          <p>{activityText(activity)}</p>
        </li>;
      })}
    </ol>
  </div>;
}
