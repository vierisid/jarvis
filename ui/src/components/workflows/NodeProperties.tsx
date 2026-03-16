import React, { useState, useEffect } from "react";
import type { Node } from "@xyflow/react";

type ConfigField = {
  type: string;
  label: string;
  required?: boolean;
  default?: unknown;
  options?: (string | { label: string; value: string })[];
  placeholder?: string;
  description?: string;
};

export default function NodeProperties({
  node,
  onConfigUpdate,
}: {
  node: Node;
  onConfigUpdate: (config: Record<string, unknown>) => void;
}) {
  const data = node.data as {
    label: string;
    nodeType: string;
    icon: string;
    color: string;
    config: Record<string, unknown>;
    configSchema: Record<string, unknown>;
  };

  const [config, setConfig] = useState<Record<string, unknown>>(data.config ?? {});

  useEffect(() => {
    setConfig(data.config ?? {});
  }, [node.id, data.config]);

  const schema = data.configSchema ?? {};
  const fields = Object.entries(schema) as [string, ConfigField][];

  const updateField = (key: string, value: unknown) => {
    const next = { ...config, [key]: value };
    setConfig(next);
    onConfigUpdate(next);
  };

  return (
    <>
      {/* Node header */}
      <div className="wf-panel-node-header">
        <div className="wf-panel-node-icon" style={{ background: data.color }}>
          {data.icon}
        </div>
        <div>
          <div className="wf-panel-node-name">{data.label}</div>
          <div className="wf-panel-node-type">{data.nodeType}</div>
        </div>
      </div>

      <div className="wf-panel-divider" />

      {/* Config fields */}
      <div className="wf-panel-section">
        <div className="wf-panel-section-label">Configuration</div>

        {fields.length === 0 ? (
          <div className="wf-panel-placeholder" style={{ padding: "12px 0" }}>
            No configuration needed
          </div>
        ) : (
          fields.map(([key, field]) => (
            <FieldEditor
              key={`${node.id}-${key}`}
              fieldKey={key}
              field={field}
              value={config[key]}
              onChange={(val) => updateField(key, val)}
            />
          ))
        )}
      </div>

      {/* Node ID */}
      <div className="wf-panel-node-id">Node ID: {node.id}</div>
    </>
  );
}

function FieldEditor({
  fieldKey,
  field,
  value,
  onChange,
}: {
  fieldKey: string;
  field: ConfigField;
  value: unknown;
  onChange: (val: unknown) => void;
}) {
  const label = field.label || fieldKey;

  const renderInput = () => {
    switch (field.type) {
      case "boolean":
        return (
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={!!value}
              onChange={e => onChange(e.target.checked)}
              style={{ accentColor: "var(--violet)" }}
            />
            <span style={{ fontSize: "12px", color: "var(--text-1)" }}>{label}</span>
          </label>
        );

      case "number":
        return (
          <input
            type="number"
            className="wf-panel-input"
            value={value != null ? String(value) : ""}
            onChange={e => onChange(e.target.value ? Number(e.target.value) : undefined)}
            placeholder={field.placeholder ?? String(field.default ?? "")}
          />
        );

      case "select":
        return (
          <select
            className="wf-panel-input"
            value={String(value ?? field.default ?? "")}
            onChange={e => onChange(e.target.value)}
          >
            <option value="">-- Select --</option>
            {(field.options ?? []).map(opt => {
              const val = typeof opt === "string" ? opt : opt.value;
              const lbl = typeof opt === "string" ? opt : opt.label;
              return <option key={val} value={val}>{lbl}</option>;
            })}
          </select>
        );

      case "code":
      case "template":
        return (
          <textarea
            className="wf-panel-input mono"
            value={String(value ?? "")}
            onChange={e => onChange(e.target.value)}
            placeholder={field.placeholder ?? ""}
            rows={4}
            style={{ resize: "vertical", minHeight: "60px" }}
          />
        );

      case "json":
        return (
          <textarea
            className="wf-panel-input mono"
            value={typeof value === "string" ? value : JSON.stringify(value ?? "", null, 2)}
            onChange={e => {
              try { onChange(JSON.parse(e.target.value)); }
              catch { onChange(e.target.value); }
            }}
            placeholder="{}"
            rows={4}
            style={{ resize: "vertical", minHeight: "60px" }}
          />
        );

      default:
        return (
          <input
            type="text"
            className="wf-panel-input"
            value={String(value ?? "")}
            onChange={e => onChange(e.target.value)}
            placeholder={field.placeholder ?? String(field.default ?? "")}
          />
        );
    }
  };

  return (
    <div className="wf-panel-field">
      {field.type !== "boolean" && (
        <label>
          {label}
          {field.required && <span style={{ color: "var(--rose)", marginLeft: "3px" }}>*</span>}
        </label>
      )}
      {renderInput()}
      {field.description && (
        <div style={{ fontSize: "10px", color: "var(--text-3)", lineHeight: "1.3" }}>
          {field.description}
        </div>
      )}
    </div>
  );
}
