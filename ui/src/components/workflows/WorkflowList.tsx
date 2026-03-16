import React from "react";
import type { WorkflowEvent } from "../../hooks/useWebSocket";
import { api } from "../../hooks/useApi";

type Workflow = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  tags: string[];
  current_version: number;
  execution_count: number;
  last_executed_at: number | null;
  last_success_at: number | null;
  last_failure_at: number | null;
  created_at: number;
};

type WorkflowDefinition = {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    position: { x: number; y: number };
    config: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
    label?: string;
  }>;
  settings: Record<string, unknown>;
};

type PreviewNode = { label: string; bg: string };

// ── Color mapping for node type prefixes ──
function nodeColor(type: string): string {
  if (type.startsWith("trigger.")) return "var(--blue-dim)";
  if (type.startsWith("action.")) return "var(--amber-dim)";
  if (type.startsWith("logic."))  return "var(--emerald-dim)";
  if (type.startsWith("transform.")) return "var(--violet-dim)";
  if (type.startsWith("error."))  return "var(--rose-dim)";
  return "var(--surface-4)";
}

// ── Build linear preview chain from definition ──
function getPreviewChain(def: WorkflowDefinition): PreviewNode[] {
  const { nodes, edges } = def;
  if (nodes.length === 0) return [];

  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    outgoing.set(e.source, [...(outgoing.get(e.source) || []), e.target]);
  }

  const hasIncoming = new Set(edges.map(e => e.target));
  let root = nodes.find(n => !hasIncoming.has(n.id)) ?? nodes[0];

  const chain: PreviewNode[] = [];
  const visited = new Set<string>();
  let current: typeof nodes[0] | undefined = root;

  while (current && chain.length < 5 && !visited.has(current.id)) {
    visited.add(current.id);
    chain.push({ label: current.label, bg: nodeColor(current.type) });
    const targets = outgoing.get(current.id);
    current = targets?.[0] ? nodes.find(n => n.id === targets[0]) : undefined;
  }

  return chain;
}

// ── Truncate long labels ──
function shortLabel(label: string, max = 14): string {
  return label.length > max ? label.slice(0, max - 1) + "." : label;
}

export default function WorkflowList({
  workflows,
  loading,
  onSelect,
  onRefetch,
  onCreate,
  workflowEvents,
  definitionMap,
}: {
  workflows: Workflow[];
  loading: boolean;
  onSelect: (id: string) => void;
  onRefetch: () => void;
  onCreate: () => void;
  workflowEvents: WorkflowEvent[];
  definitionMap: Map<string, WorkflowDefinition>;
}) {
  if (loading) {
    return (
      <div className="wf-loading">
        <div className="wf-loading-orb" />
        <span className="wf-loading-text">Loading workflows...</span>
      </div>
    );
  }

  if (workflows.length === 0) {
    return (
      <div className="wf-empty">
        <div className="wf-empty-icon">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <path d="M4 14h6l3-8 6 16 3-8h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.5"/>
          </svg>
        </div>
        <h2 className="wf-empty-title">No workflows yet</h2>
        <p className="wf-empty-desc">Create your first automation to get started.</p>
        <button className="wf-empty-cta" onClick={onCreate}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
          New Workflow
        </button>
      </div>
    );
  }

  const handleToggle = async (e: React.MouseEvent, id: string, enabled: boolean) => {
    e.stopPropagation();
    try {
      await api(`/api/workflows/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !enabled }),
      });
      onRefetch();
    } catch (err) {
      console.error("Failed to toggle workflow:", err);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm("Delete this workflow?")) return;
    try {
      await api(`/api/workflows/${id}`, { method: "DELETE" });
      onRefetch();
    } catch (err) {
      console.error("Failed to delete workflow:", err);
    }
  };

  const handleRun = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await api(`/api/workflows/${id}/execute`, { method: "POST", body: "{}" });
    } catch (err) {
      console.error("Failed to run workflow:", err);
    }
  };

  return (
    <div className="wf-grid-area">
      <div className="wf-grid">
        {workflows.map((wf) => {
          const recentEvents = workflowEvents.filter(ev => ev.workflowId === wf.id).slice(-3);
          const lastEvent = recentEvents[recentEvents.length - 1];
          const isRunning = lastEvent?.type === "execution_started";
          const def = definitionMap.get(wf.id);
          const chain = def ? getPreviewChain(def) : [];
          const totalNodes = def?.nodes.length ?? 0;
          const statusClass = isRunning ? "running" : wf.enabled ? "active" : "disabled";
          const statusLabel = isRunning ? "Running" : wf.enabled ? "Active" : "Paused";

          return (
            <div key={wf.id} className="wf-card" onClick={() => onSelect(wf.id)}>
              {/* Top: icon + info + status */}
              <div className="wf-card-top">
                <div
                  className="wf-card-icon"
                  style={{
                    background: wf.enabled
                      ? "var(--blue-dim)"
                      : "rgba(255,255,255,0.05)",
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M3 8h3l2-4 4 8 2-4h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" opacity="0.7"/>
                  </svg>
                </div>
                <div className="wf-card-info">
                  <div className="wf-card-name">{wf.name}</div>
                  {wf.description && (
                    <div className="wf-card-desc">{wf.description}</div>
                  )}
                </div>
                <div className={`wf-card-status ${statusClass}`}>
                  <span className="wf-status-dot" />
                  {statusLabel}
                </div>
              </div>

              {/* Mini flow preview */}
              {chain.length > 0 && (
                <div className="wf-card-preview">
                  {chain.map((node, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && <span className="wf-preview-arrow">&rarr;</span>}
                      <div className="wf-preview-node" style={{ background: node.bg }}>
                        {shortLabel(node.label)}
                      </div>
                    </React.Fragment>
                  ))}
                  {totalNodes > chain.length && (
                    <span className="wf-preview-more">+{totalNodes - chain.length}</span>
                  )}
                </div>
              )}

              {/* Footer */}
              <div className="wf-card-footer">
                {wf.tags.length > 0 && (
                  <div className="wf-card-tags">
                    {wf.tags.slice(0, 3).map(tag => (
                      <span key={tag} className="wf-card-tag">{tag}</span>
                    ))}
                  </div>
                )}
                <div className="wf-card-meta">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M5 1v4l2.5 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  </svg>
                  v{wf.current_version} · {wf.execution_count.toLocaleString()} runs
                </div>
                <div className="wf-card-footer-spacer" />
                <button
                  className="wf-card-action run"
                  title="Run now"
                  onClick={(e) => handleRun(e, wf.id)}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 1l7 4-7 4V1z" fill="currentColor"/>
                  </svg>
                </button>
                <button
                  className="wf-card-action"
                  title={wf.enabled ? "Pause" : "Enable"}
                  onClick={(e) => handleToggle(e, wf.id, wf.enabled)}
                >
                  {wf.enabled ? (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <rect x="1.5" y="1" width="2.5" height="8" rx="0.5" fill="currentColor"/>
                      <rect x="6" y="1" width="2.5" height="8" rx="0.5" fill="currentColor"/>
                    </svg>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M2 1l7 4-7 4V1z" fill="currentColor"/>
                    </svg>
                  )}
                </button>
                <button
                  className="wf-card-action danger"
                  title="Delete"
                  onClick={(e) => handleDelete(e, wf.id)}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                    <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
