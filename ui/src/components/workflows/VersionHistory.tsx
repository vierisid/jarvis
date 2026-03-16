import React, { useState } from "react";
import { useApiData } from "../../hooks/useApi";

type WorkflowVersion = {
  id: string;
  workflow_id: string;
  version: number;
  definition: {
    nodes: Array<{ id: string; type: string; label: string }>;
    edges: Array<{ id: string; source: string; target: string }>;
    settings: Record<string, unknown>;
  };
  changelog: string | null;
  created_at: number;
};

export default function VersionHistory({ workflowId }: { workflowId: string }) {
  const { data: versions, loading } = useApiData<WorkflowVersion[]>(
    `/api/workflows/${workflowId}/versions`
  );
  const [diffPair, setDiffPair] = useState<[number, number] | null>(null);

  if (loading) {
    return <div className="wf-panel-placeholder">Loading versions...</div>;
  }

  if (!versions || versions.length === 0) {
    return <div className="wf-panel-placeholder">No versions yet.</div>;
  }

  const diffResult = diffPair ? computeDiff(
    versions.find(v => v.version === diffPair[0]),
    versions.find(v => v.version === diffPair[1]),
  ) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ fontSize: "11px", color: "var(--text-3)", padding: "0 4px" }}>
        {versions.length} version{versions.length !== 1 ? "s" : ""}
      </div>

      {versions.map((v, i) => {
        const prev = versions[i + 1];
        return (
          <div key={v.id} className="wf-version-card">
            <div className="wf-version-header">
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span className={`wf-version-badge${i === 0 ? " latest" : ""}`}>
                  v{v.version}
                  {i === 0 && <span className="wf-version-latest-label">latest</span>}
                </span>
              </div>
              <span className="wf-version-date">
                {new Date(v.created_at).toLocaleString()}
              </span>
            </div>

            {v.changelog && (
              <div className="wf-version-changelog">{v.changelog}</div>
            )}

            <div className="wf-version-stats">
              {v.definition.nodes.length} nodes, {v.definition.edges.length} edges
            </div>

            {prev && (
              <button
                className="wf-version-diff-btn"
                onClick={() => setDiffPair(diffPair?.[0] === prev.version ? null : [prev.version, v.version])}
              >
                {diffPair?.[0] === prev.version ? "Hide diff" : `Diff v${prev.version} \u2192 v${v.version}`}
              </button>
            )}

            {diffResult && diffPair?.[1] === v.version && (
              <DiffView diff={diffResult} />
            )}
          </div>
        );
      })}
    </div>
  );
}

type DiffInfo = {
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesModified: string[];
  edgesAdded: number;
  edgesRemoved: number;
};

function computeDiff(v1?: WorkflowVersion, v2?: WorkflowVersion): DiffInfo | null {
  if (!v1 || !v2) return null;
  const d1 = v1.definition;
  const d2 = v2.definition;

  const nodeIds1 = new Set(d1.nodes.map(n => n.id));
  const nodeIds2 = new Set(d2.nodes.map(n => n.id));
  const edgeIds1 = new Set(d1.edges.map(e => e.id));
  const edgeIds2 = new Set(d2.edges.map(e => e.id));

  return {
    nodesAdded: d2.nodes.filter(n => !nodeIds1.has(n.id)).map(n => n.label),
    nodesRemoved: d1.nodes.filter(n => !nodeIds2.has(n.id)).map(n => n.label),
    nodesModified: d2.nodes.filter(n => {
      if (!nodeIds1.has(n.id)) return false;
      const old = d1.nodes.find(o => o.id === n.id);
      return old && (old.type !== n.type || old.label !== n.label);
    }).map(n => n.label),
    edgesAdded: d2.edges.filter(e => !edgeIds1.has(e.id)).length,
    edgesRemoved: d1.edges.filter(e => !edgeIds2.has(e.id)).length,
  };
}

function DiffView({ diff }: { diff: DiffInfo }) {
  const hasChanges = diff.nodesAdded.length || diff.nodesRemoved.length ||
    diff.nodesModified.length || diff.edgesAdded || diff.edgesRemoved;

  if (!hasChanges) {
    return <div style={{ fontSize: "10px", color: "var(--text-3)", marginTop: "6px" }}>No differences</div>;
  }

  return (
    <div style={{ marginTop: "6px", fontSize: "10px", display: "flex", flexDirection: "column", gap: "2px" }}>
      {diff.nodesAdded.map(n => (
        <div key={`+${n}`} style={{ color: "var(--emerald)" }}>+ {n}</div>
      ))}
      {diff.nodesRemoved.map(n => (
        <div key={`-${n}`} style={{ color: "var(--rose)" }}>- {n}</div>
      ))}
      {diff.nodesModified.map(n => (
        <div key={`~${n}`} style={{ color: "var(--amber)" }}>~ {n}</div>
      ))}
      {diff.edgesAdded > 0 && <div style={{ color: "var(--emerald)" }}>+ {diff.edgesAdded} edge(s)</div>}
      {diff.edgesRemoved > 0 && <div style={{ color: "var(--rose)" }}>- {diff.edgesRemoved} edge(s)</div>}
    </div>
  );
}
