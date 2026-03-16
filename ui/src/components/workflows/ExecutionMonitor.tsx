import React from "react";
import { useApiData } from "../../hooks/useApi";
import type { WorkflowEvent } from "../../hooks/useWebSocket";

type Execution = {
  id: string;
  workflow_id: string;
  version: number;
  trigger_type: string;
  status: string;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
};

type StepResult = {
  id: string;
  node_id: string;
  node_type: string;
  status: string;
  error_message: string | null;
  retry_count: number;
  started_at: number | null;
  completed_at: number | null;
};

const STATUS_COLORS: Record<string, string> = {
  running: "var(--violet)",
  completed: "var(--emerald)",
  failed: "var(--rose)",
  cancelled: "var(--amber)",
  paused: "var(--text-3)",
  pending: "var(--text-3)",
  skipped: "var(--text-3)",
  waiting: "var(--blue)",
};

export default function ExecutionMonitor({
  workflowId,
  workflowEvents,
}: {
  workflowId: string;
  workflowEvents: WorkflowEvent[];
}) {
  const { data: executions, loading } = useApiData<Execution[]>(
    `/api/workflows/${workflowId}/executions`
  );

  if (loading) {
    return <div className="wf-panel-placeholder">Loading executions...</div>;
  }

  if (!executions || executions.length === 0) {
    return (
      <div className="wf-panel-placeholder">
        No executions yet. Run the workflow to see results.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {executions.slice(0, 20).map(exec => (
        <ExecutionCard key={exec.id} execution={exec} workflowEvents={workflowEvents} />
      ))}
    </div>
  );
}

function ExecutionCard({
  execution: exec,
  workflowEvents,
}: {
  execution: Execution;
  workflowEvents: WorkflowEvent[];
}) {
  const [expanded, setExpanded] = React.useState(exec.status === "running");
  const { data: steps } = useApiData<{ execution: Execution; steps: StepResult[] }>(
    expanded ? `/api/workflows/executions/${exec.id}` : null
  );

  const color = STATUS_COLORS[exec.status] ?? "var(--text-3)";
  const duration = exec.completed_at
    ? `${((exec.completed_at - exec.started_at) / 1000).toFixed(1)}s`
    : exec.status === "running" ? "running..." : "--";

  return (
    <div className="wf-exec-card">
      <div className="wf-exec-header" onClick={() => setExpanded(!expanded)}>
        <div className="wf-exec-header-left">
          <span
            className={`wf-exec-status-dot${exec.status === "running" ? " running" : ""}`}
            style={{
              background: color,
              boxShadow: exec.status === "running" ? `0 0 6px ${color}` : "none",
            }}
          />
          <span className="wf-exec-version">v{exec.version}</span>
          <span className="wf-exec-trigger">{exec.trigger_type}</span>
        </div>
        <div className="wf-exec-header-right">
          <span className="wf-exec-duration">{duration}</span>
          <span className="wf-exec-expand-icon">{expanded ? "\u25BC" : "\u25B6"}</span>
        </div>
      </div>

      {expanded && steps?.steps && (
        <div className="wf-exec-steps">
          {steps.steps.map(step => {
            const stepColor = STATUS_COLORS[step.status] ?? "var(--text-3)";
            return (
              <div key={step.id} className="wf-exec-step">
                <span className="wf-exec-step-dot" style={{ background: stepColor }} />
                <span className="wf-exec-step-name">{step.node_id}</span>
                <span className="wf-exec-step-type">{step.node_type}</span>
                {step.retry_count > 0 && (
                  <span className="wf-exec-step-retry">{step.retry_count}x retry</span>
                )}
                {step.error_message && (
                  <span className="wf-exec-step-error" title={step.error_message}>
                    {step.error_message}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {exec.error_message && (
        <div className="wf-exec-error-banner">{exec.error_message}</div>
      )}
    </div>
  );
}
