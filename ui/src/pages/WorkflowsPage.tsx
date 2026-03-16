import React, { useState, useCallback, useEffect, useMemo } from "react";
import type { WorkflowEvent } from "../hooks/useWebSocket";
import { useApiData, api } from "../hooks/useApi";
import WorkflowList from "../components/workflows/WorkflowList";
import WorkflowCanvas from "../components/workflows/WorkflowCanvas";
import "../styles/workflows.css";

export type Workflow = {
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
  updated_at: number;
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

type VersionEntry = {
  id: string;
  workflow_id: string;
  version: number;
  definition: WorkflowDefinition;
  changelog: string | null;
  created_at: number;
};

type Filter = "all" | "active" | "paused" | "disabled";

export default function WorkflowsPage({
  workflowEvents,
  sendMessage,
}: {
  workflowEvents: WorkflowEvent[];
  sendMessage: (text: string) => void;
}) {
  const [view, setView] = useState<"list" | "canvas">("list");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [defMap, setDefMap] = useState<Map<string, WorkflowDefinition>>(new Map());
  const { data: workflows, loading, refetch } = useApiData<Workflow[]>("/api/workflows");

  // Fetch definitions for mini preview chain on cards
  useEffect(() => {
    if (!workflows || workflows.length === 0) return;
    const fetchDefs = async () => {
      const entries = await Promise.allSettled(
        workflows.map(wf =>
          fetch(`/api/workflows/${wf.id}/versions`)
            .then(r => r.ok ? r.json() as Promise<VersionEntry[]> : [])
            .then(versions => [wf.id, versions[0]?.definition] as const)
        )
      );
      const map = new Map<string, WorkflowDefinition>();
      for (const entry of entries) {
        if (entry.status === "fulfilled" && entry.value[1]) {
          map.set(entry.value[0], entry.value[1]);
        }
      }
      setDefMap(map);
    };
    fetchDefs();
  }, [workflows]);

  // Filter + search
  const filteredWorkflows = useMemo(() => {
    if (!workflows) return [];
    let list = workflows;

    if (filter !== "all") {
      list = list.filter(wf => {
        if (filter === "active") return wf.enabled;
        if (filter === "paused" || filter === "disabled") return !wf.enabled;
        return true;
      });
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(wf =>
        wf.name.toLowerCase().includes(q) ||
        wf.description.toLowerCase().includes(q) ||
        wf.tags.some(t => t.toLowerCase().includes(q))
      );
    }

    return list;
  }, [workflows, filter, search]);

  // Stats
  const stats = useMemo(() => {
    if (!workflows) return { total: 0, active: 0, paused: 0, executions: 0 };
    return {
      total: workflows.length,
      active: workflows.filter(w => w.enabled).length,
      paused: workflows.filter(w => !w.enabled).length,
      executions: workflows.reduce((sum, w) => sum + w.execution_count, 0),
    };
  }, [workflows]);

  const handleSelect = useCallback((id: string) => {
    setSelectedWorkflowId(id);
    setView("canvas");
  }, []);

  const handleBack = useCallback(() => {
    setView("list");
    setSelectedWorkflowId(null);
    refetch();
  }, [refetch]);

  const handleCreate = useCallback(async () => {
    const name = prompt("Workflow name:");
    if (!name) return;
    try {
      const wf = await api<Workflow>("/api/workflows", {
        method: "POST",
        body: JSON.stringify({
          name,
          definition: {
            nodes: [{
              id: "trigger-1",
              type: "trigger.manual",
              label: "Manual Trigger",
              position: { x: 100, y: 200 },
              config: {},
            }],
            edges: [],
            settings: {
              maxRetries: 3,
              retryDelayMs: 5000,
              timeoutMs: 300000,
              parallelism: "parallel",
              onError: "stop",
            },
          },
        }),
      });
      handleSelect(wf.id);
    } catch (err) {
      console.error("Failed to create workflow:", err);
    }
  }, [handleSelect]);

  const selectedWorkflow = workflows?.find(w => w.id === selectedWorkflowId);

  // ── Canvas View ──
  if (view === "canvas" && selectedWorkflowId) {
    return (
      <div className="wf-page">
        <div className="wf-canvas-header">
          <button className="wf-back-btn" onClick={handleBack}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M8 2L4 6l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Back
          </button>
          <div className="wf-canvas-divider" />
          <div className="wf-canvas-title">{selectedWorkflow?.name ?? "Workflow"}</div>
          <div className={`wf-canvas-badge ${selectedWorkflow?.enabled ? "active" : "disabled"}`}>
            {selectedWorkflow?.enabled ? "Active" : "Disabled"}
          </div>
          <div className="wf-canvas-spacer" />
          <div className="wf-canvas-actions">
            <button className="wf-canvas-btn">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M5 1v4l2.5 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              v{selectedWorkflow?.current_version ?? 1}
            </button>
            <button
              className="wf-canvas-btn"
              onClick={async () => {
                if (!selectedWorkflowId) return;
                try {
                  await api(`/api/workflows/${selectedWorkflowId}`, {
                    method: "PATCH",
                    body: JSON.stringify({ enabled: !selectedWorkflow?.enabled }),
                  });
                  refetch();
                } catch (err) {
                  console.error("Failed to toggle:", err);
                }
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <rect x="1.5" y="1" width="2.5" height="8" rx="0.5" fill="currentColor"/>
                <rect x="6" y="1" width="2.5" height="8" rx="0.5" fill="currentColor"/>
              </svg>
              {selectedWorkflow?.enabled ? "Pause" : "Enable"}
            </button>
            <button
              className="wf-canvas-btn primary"
              onClick={async () => {
                try {
                  await api(`/api/workflows/${selectedWorkflowId}/execute`, { method: "POST", body: "{}" });
                } catch (err) {
                  console.error("Failed to run:", err);
                }
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 1l7 4-7 4V1z" fill="currentColor"/>
              </svg>
              Run Now
            </button>
          </div>
        </div>
        <WorkflowCanvas
          workflowId={selectedWorkflowId}
          workflowEvents={workflowEvents}
          sendMessage={sendMessage}
        />
      </div>
    );
  }

  // ── List View ──
  return (
    <div className="wf-page">
      {/* Header */}
      <div className="wf-header">
        <div className="wf-header-title">Workflows</div>
        <div className="wf-header-count">{stats.total}</div>
        <div className="wf-header-spacer" />
        <div className="wf-search-wrap">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4"/>
            <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
          <input
            className="wf-search"
            placeholder="Search workflows..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <button
          className={`wf-filter-btn${filter !== "all" ? " active" : ""}`}
          onClick={() => setFilter(f => f === "all" ? "active" : f === "active" ? "paused" : "all")}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M1 2h10M3 6h6M5 10h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          {filter === "all" ? "Filter" : filter.charAt(0).toUpperCase() + filter.slice(1)}
        </button>
        <button className="wf-new-btn" onClick={handleCreate}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
          New Workflow
        </button>
      </div>

      {/* Stats Bar */}
      <div className="wf-stats-bar">
        <div className="wf-stat-card">
          <div className="wf-stat-label">Total Workflows</div>
          <div className="wf-stat-value violet">{stats.total}</div>
          <div className="wf-stat-sub">
            {stats.active} active · {stats.paused} paused
          </div>
        </div>
        <div className="wf-stat-card">
          <div className="wf-stat-label">Total Executions</div>
          <div className="wf-stat-value emerald">{stats.executions.toLocaleString()}</div>
          <div className="wf-stat-sub">across all workflows</div>
        </div>
        <div className="wf-stat-card">
          <div className="wf-stat-label">Active</div>
          <div className="wf-stat-value blue">{stats.active}</div>
          <div className="wf-stat-sub">{stats.total > 0 ? Math.round((stats.active / stats.total) * 100) : 0}% of total</div>
        </div>
        <div className="wf-stat-card">
          <div className="wf-stat-label">Recent Events</div>
          <div className="wf-stat-value amber">{workflowEvents.length}</div>
          <div className="wf-stat-sub">this session</div>
        </div>
      </div>

      {/* Content */}
      <WorkflowList
        workflows={filteredWorkflows}
        loading={loading}
        onSelect={handleSelect}
        onRefetch={refetch}
        onCreate={handleCreate}
        workflowEvents={workflowEvents}
        definitionMap={defMap}
      />
    </div>
  );
}
