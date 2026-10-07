import React from "react";
import { ArrowRight, GitBranch } from "lucide-react";
import { BriefButton } from "../../components/controls";
import { runPresentation, type RecentWorkflow, type RecentWorkflowBinding } from "./model";

export function RecentWorkflows({ mode, binding, selectedRunId, onOpen, onAll }: {
  mode: "live" | "preview"; binding?: RecentWorkflowBinding; selectedRunId: string | null;
  onOpen(row: RecentWorkflow): void; onAll(): void;
}) {
  const state = binding?.source === (mode === "live" ? "live" : "fixture") ? binding.state : { status: "unsupported" as const };
  const rows = "data" in state ? state.data : [];
  return <section className="brief-recent-workflows" aria-labelledby="brief-recent-workflows-title">
    <h2 id="brief-recent-workflows-title" className="brief-type-section-heading">Recently run</h2>
    {state.status === "stale" && <p className="brief-workflow-notice" role="status">Recent results may be incomplete or out of date. {binding?.refresh && <button onClick={binding.refresh}>Refresh</button>}</p>}
    {rows.length > 0 ? <>
      <div className="brief-recent-head" aria-hidden="true"><span>Workflow<span className="brief-recent-compact-label"> &amp; result</span></span><span className="brief-recent-result-heading">Latest result</span><span>Status</span><span>Last run</span></div>
      <ul>{rows.map(row => {
        const status = runPresentation(row.status);
        // Only successful runs may carry an owner-supplied result summary.
        const result = row.status === "SUCCEEDED" ? row.result : status.result;
        return <li key={row.runId}><button type="button" className="brief-recent-row" data-selected={row.runId === selectedRunId}
          data-run-id={row.runId} aria-label={`Open ${row.name}, ${status.label.toLowerCase()}`} onClick={() => onOpen(row)}>
          <span className="brief-recent-name"><GitBranch size={19} strokeWidth={1.5} aria-hidden="true" /><strong>{row.name}</strong></span>
          <span className="brief-recent-result">{row.environment === "TESTING" ? "Test run · " : ""}{result}</span>
          <span className="brief-recent-status" data-tone={status.tone}><i aria-hidden="true" />{status.label}</span>
          <time dateTime={new Date(row.at).toISOString()} title={new Date(row.at).toLocaleString()}>{new Intl.DateTimeFormat(undefined, { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" }).format(row.at)}</time>
        </button></li>;
      })}</ul>
    </> : <p className="brief-workflow-notice" role="status">{state.status === "loading" ? "Loading recent runs…" : state.status === "empty" || state.status === "ready" ? "Your recent runs will appear here." : "Recent runs are unavailable."}
      {(state.status === "unavailable" || state.status === "stale") && binding?.refresh && <> <button onClick={binding.refresh}>Retry</button></>}
    </p>}
    <BriefButton variant="text" onClick={onAll}>See all workflows <ArrowRight size={16} aria-hidden="true" /></BriefButton>
  </section>;
}
