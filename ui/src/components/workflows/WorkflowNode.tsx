import React, { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

type WorkflowNodeData = {
  label: string;
  nodeType: string;
  icon: string;
  color: string;
  config: Record<string, unknown>;
  configSchema: Record<string, unknown>;
  inputs: string[];
  outputs: string[];
  status?: "running" | "completed" | "failed";
};

function WorkflowNodeComponent({ data, selected }: NodeProps) {
  const d = data as unknown as WorkflowNodeData;

  const statusColor = d.status === "running"
    ? "var(--emerald)"
    : d.status === "completed"
    ? "var(--emerald)"
    : d.status === "failed"
    ? "var(--rose)"
    : undefined;

  return (
    <div className={`wf-node${selected ? " selected" : ""}`}>
      {/* Header */}
      <div className="wf-node-header">
        <div className="wf-node-header-icon" style={{ background: d.color }}>
          {d.icon}
        </div>
        <div className="wf-node-header-label">{d.label}</div>
        {statusColor && (
          <div
            className={`wf-node-header-status${d.status === "running" ? " running" : ""}`}
            style={{
              background: statusColor,
              boxShadow: d.status === "running" ? `0 0 6px ${statusColor}` : "none",
            }}
          />
        )}
      </div>

      {/* Body */}
      <div className="wf-node-body">
        {Object.keys(d.config).length > 0 ? (
          <>
            {Object.entries(d.config).slice(0, 3).map(([key, val]) => (
              <div key={key} className="wf-node-field">
                <span className="wf-node-field-key">{key}</span>
                {typeof val === "string" ? val : JSON.stringify(val)}
              </div>
            ))}
            {Object.keys(d.config).length > 3 && (
              <div className="wf-node-field-overflow">
                +{Object.keys(d.config).length - 3} more
              </div>
            )}
          </>
        ) : (
          <div className="wf-node-field">
            <span className="wf-node-field-key">type</span>
            {d.nodeType}
          </div>
        )}
      </div>

      {/* Input handles */}
      {d.inputs.map((input, i) => (
        <Handle
          key={`in-${input}`}
          type="target"
          position={Position.Left}
          id={input}
          style={{
            top: `${((i + 1) / (d.inputs.length + 1)) * 100}%`,
            width: "10px",
            height: "10px",
            background: "rgba(255,255,255,0.08)",
            border: "2px solid var(--surface-2, #0D0D14)",
          }}
          title={input}
        />
      ))}

      {/* Output handles */}
      {d.outputs.map((output, i) => (
        <Handle
          key={`out-${output}`}
          type="source"
          position={Position.Right}
          id={output}
          style={{
            top: `${((i + 1) / (d.outputs.length + 1)) * 100}%`,
            width: "10px",
            height: "10px",
            background: d.color,
            border: "2px solid var(--surface-2, #0D0D14)",
          }}
          title={output}
        />
      ))}
    </div>
  );
}

export default memo(WorkflowNodeComponent);
