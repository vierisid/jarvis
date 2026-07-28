import React, { useState, useEffect } from "react";
import { api } from "../../hooks/useApi";

type SidecarConfig = {
  capabilities: string[];
  terminal: { blocked_commands: string[]; default_shell: string; timeout_ms: number };
  filesystem: { blocked_paths: string[]; max_file_size_kb: number };
  browser: { cdp_port: number; profile_dir: string };
  awareness: { screen_interval_ms: number; window_interval_ms: number; min_change_threshold: number; stuck_threshold_ms: number };
};

const ALL_CAPABILITIES = [
  "terminal", "filesystem", "desktop", "browser", "clipboard", "screenshot", "system_info", "awareness",
] as const;

type UnavailableCapability = {
  name: string;
  reason: string;
};

type Props = {
  sidecarId: string;
  sidecarName: string;
  unavailableCapabilities?: UnavailableCapability[];
  onClose: () => void;
};

export function SidecarConfigEditor({ sidecarId, sidecarName, unavailableCapabilities = [], onClose }: Props) {
  const [config, setConfig] = useState<SidecarConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [mode, setMode] = useState<"form" | "yaml">("form");
  const [yamlText, setYamlText] = useState("");
  const [yamlError, setYamlError] = useState("");

  useEffect(() => {
    loadConfig();
  }, [sidecarId]);

  useEffect(() => {
    if (success) {
      const t = setTimeout(() => setSuccess(""), 3000);
      return () => clearTimeout(t);
    }
  }, [success]);

  const loadConfig = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<SidecarConfig>(`/api/sidecars/${sidecarId}/config`);
      setConfig(result);
      setYamlText(configToYaml(result));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      let payload: SidecarConfig;
      if (mode === "yaml") {
        try {
          payload = yamlToConfig(yamlText);
        } catch (err: any) {
          setError("Invalid format: " + err.message);
          setSaving(false);
          return;
        }
      } else {
        payload = config;
      }
      const result = await api<SidecarConfig>(`/api/sidecars/${sidecarId}/config`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setConfig(result);
      setYamlText(configToYaml(result));
      setSuccess("Config saved successfully");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const switchMode = (newMode: "form" | "yaml") => {
    if (newMode === mode) return;
    if (newMode === "yaml" && config) {
      setYamlText(configToYaml(config));
      setYamlError("");
    } else if (newMode === "form" && yamlText) {
      try {
        const parsed = yamlToConfig(yamlText);
        setConfig(parsed);
        setYamlError("");
      } catch (err: any) {
        setYamlError("Cannot switch: " + err.message);
        return;
      }
    }
    setMode(newMode);
  };

  const updateConfig = (updater: (c: SidecarConfig) => SidecarConfig) => {
    if (config) setConfig(updater(config));
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={modalHeaderStyle}>
          <div>
            <span style={{ fontWeight: 600, fontSize: "15px", color: "var(--ink)" }}>
              Configure: {sidecarName}
            </span>
          </div>
          <button onClick={onClose} style={closeButtonStyle}>&times;</button>
        </div>

        {/* Mode tabs */}
        <div style={tabBarStyle}>
          <button
            onClick={() => switchMode("form")}
            style={mode === "form" ? activeTabStyle : tabStyle}
          >
            Form
          </button>
          <button
            onClick={() => switchMode("yaml")}
            style={mode === "yaml" ? activeTabStyle : tabStyle}
          >
            JSON
          </button>
        </div>

        {yamlError && (
          <div style={{ color: "var(--j-error, #f44)", fontSize: "12px", padding: "0 20px" }}>{yamlError}</div>
        )}

        {/* Content */}
        <div style={modalBodyStyle}>
          {loading ? (
            <div style={{ color: "var(--ink3)", padding: "20px", textAlign: "center" }}>Loading config...</div>
          ) : error && !config ? (
            <div style={{ color: "var(--j-error, #f44)", padding: "20px" }}>{error}</div>
          ) : mode === "form" && config ? (
            <FormMode config={config} updateConfig={updateConfig} unavailableCapabilities={unavailableCapabilities} />
          ) : mode === "yaml" ? (
            <div style={{ padding: "0" }}>
              <textarea
                value={yamlText}
                onChange={(e) => setYamlText(e.target.value)}
                style={textareaStyle}
                spellCheck={false}
              />
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div style={modalFooterStyle}>
          {error && config && (
            <span style={{ color: "var(--j-error, #f44)", fontSize: "12px", flex: 1 }}>{error}</span>
          )}
          {success && (
            <span style={{ color: "var(--j-success, #4f4)", fontSize: "12px", flex: 1 }}>{success}</span>
          )}
          {!error && !success && <span style={{ flex: 1 }} />}
          <button onClick={onClose} style={cancelButtonStyle}>Cancel</button>
          <button onClick={handleSave} disabled={saving || loading} style={saveButtonStyle}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Form Mode ---

function FormMode({ config, updateConfig, unavailableCapabilities = [] }: {
  config: SidecarConfig;
  updateConfig: (fn: (c: SidecarConfig) => SidecarConfig) => void;
  unavailableCapabilities?: UnavailableCapability[];
}) {
  const unavailableMap = new Map(unavailableCapabilities.map(u => [u.name, u.reason]));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <ConfigSection title="Capabilities">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {ALL_CAPABILITIES.map((cap) => {
            const unavailReason = unavailableMap.get(cap);
            return (
              <label key={cap} style={checkboxLabelStyle}>
                <input
                  type="checkbox"
                  checked={config.capabilities.includes(cap)}
                  onChange={(e) => {
                    updateConfig((c) => ({
                      ...c,
                      capabilities: e.target.checked
                        ? [...c.capabilities, cap]
                        : c.capabilities.filter((x) => x !== cap),
                    }));
                  }}
                />
                {cap}
                {unavailReason && (
                  <span title={unavailReason} style={{ color: "var(--j-warning, #fa0)", cursor: "help", marginLeft: "2px" }}>
                    &#9888;
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </ConfigSection>

      <ConfigSection title="Terminal">
        <ConfigNumberField
          label="Timeout (ms)"
          value={config.terminal.timeout_ms}
          onChange={(v) => updateConfig((c) => ({ ...c, terminal: { ...c.terminal, timeout_ms: v } }))}
        />
        <ConfigTextField
          label="Default Shell"
          value={config.terminal.default_shell}
          placeholder="/bin/bash"
          onChange={(v) => updateConfig((c) => ({ ...c, terminal: { ...c.terminal, default_shell: v } }))}
        />
        <ConfigListField
          label="Blocked Commands"
          items={config.terminal.blocked_commands}
          placeholder="e.g. rm -rf"
          onChange={(items) => updateConfig((c) => ({ ...c, terminal: { ...c.terminal, blocked_commands: items } }))}
        />
      </ConfigSection>

      <ConfigSection title="Filesystem">
        <ConfigNumberField
          label="Max File Size (KB)"
          value={config.filesystem.max_file_size_kb}
          onChange={(v) => updateConfig((c) => ({ ...c, filesystem: { ...c.filesystem, max_file_size_kb: v } }))}
        />
        <ConfigListField
          label="Blocked Paths"
          items={config.filesystem.blocked_paths}
          placeholder="e.g. /etc/shadow"
          onChange={(items) => updateConfig((c) => ({ ...c, filesystem: { ...c.filesystem, blocked_paths: items } }))}
        />
      </ConfigSection>

      <ConfigSection title="Browser">
        <ConfigNumberField
          label="CDP Port"
          value={config.browser.cdp_port}
          onChange={(v) => updateConfig((c) => ({ ...c, browser: { ...c.browser, cdp_port: v } }))}
        />
        <ConfigTextField
          label="Profile Directory"
          value={config.browser.profile_dir}
          placeholder="Chrome profile path"
          onChange={(v) => updateConfig((c) => ({ ...c, browser: { ...c.browser, profile_dir: v } }))}
        />
      </ConfigSection>

      <ConfigSection title="Awareness">
        <ConfigNumberField
          label="Screen Interval (ms)"
          value={config.awareness.screen_interval_ms}
          onChange={(v) => updateConfig((c) => ({ ...c, awareness: { ...c.awareness, screen_interval_ms: v } }))}
        />
        <ConfigNumberField
          label="Window Interval (ms)"
          value={config.awareness.window_interval_ms}
          onChange={(v) => updateConfig((c) => ({ ...c, awareness: { ...c.awareness, window_interval_ms: v } }))}
        />
        <ConfigNumberField
          label="Min Change Threshold"
          value={config.awareness.min_change_threshold}
          step={0.01}
          onChange={(v) => updateConfig((c) => ({ ...c, awareness: { ...c.awareness, min_change_threshold: v } }))}
        />
        <ConfigNumberField
          label="Stuck Threshold (ms)"
          value={config.awareness.stuck_threshold_ms}
          onChange={(v) => updateConfig((c) => ({ ...c, awareness: { ...c.awareness, stuck_threshold_ms: v } }))}
        />
      </ConfigSection>
    </div>
  );
}

// --- Sub-components ---

function ConfigSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ border: "1px solid var(--rule)", borderRadius: "6px", overflow: "hidden" }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          padding: "8px 12px",
          background: "var(--panel)",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: "13px",
          fontWeight: 500,
          color: "var(--ink)",
        }}
      >
        {title}
        <span style={{ color: "var(--ink3)", fontSize: "11px" }}>{open ? "\u25B2" : "\u25BC"}</span>
      </div>
      {open && <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>{children}</div>}
    </div>
  );
}

function ConfigNumberField({ label, value, onChange, step }: {
  label: string; value: number; onChange: (v: number) => void; step?: number;
}) {
  return (
    <div style={fieldRowStyle}>
      <label style={fieldLabelStyle}>{label}</label>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        style={fieldInputStyle}
      />
    </div>
  );
}

function ConfigTextField({ label, value, placeholder, onChange }: {
  label: string; value: string; placeholder?: string; onChange: (v: string) => void;
}) {
  return (
    <div style={fieldRowStyle}>
      <label style={fieldLabelStyle}>{label}</label>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={fieldInputStyle}
      />
    </div>
  );
}

function ConfigListField({ label, items, placeholder, onChange }: {
  label: string; items: string[]; placeholder?: string; onChange: (items: string[]) => void;
}) {
  const [newItem, setNewItem] = useState("");

  const addItem = () => {
    const trimmed = newItem.trim();
    if (trimmed && !items.includes(trimmed)) {
      onChange([...items, trimmed]);
      setNewItem("");
    }
  };

  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "4px", marginBottom: "6px" }}>
        {items.map((item, i) => (
          <span key={i} style={tagStyle}>
            {item}
            <button
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              style={tagRemoveStyle}
            >
              &times;
            </button>
          </span>
        ))}
        {items.length === 0 && (
          <span style={{ fontSize: "11px", color: "var(--ink2)" }}>None</span>
        )}
      </div>
      <div style={{ display: "flex", gap: "4px" }}>
        <input
          type="text"
          value={newItem}
          placeholder={placeholder}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addItem()}
          style={{ ...fieldInputStyle, flex: 1 }}
        />
        <button onClick={addItem} disabled={!newItem.trim()} style={addButtonStyle}>Add</button>
      </div>
    </div>
  );
}

// --- YAML/JSON helpers ---

function configToYaml(config: SidecarConfig): string {
  return JSON.stringify(config, null, 2);
}

function yamlToConfig(text: string): SidecarConfig {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new Error("Expected an object");
  return parsed as SidecarConfig;
}

// --- Styles ---

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--rule)",
  borderRadius: "10px",
  width: "560px",
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
};

const modalHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "16px 20px",
  borderBottom: "1px solid var(--rule)",
};

const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--ink3)",
  fontSize: "20px",
  cursor: "pointer",
  padding: "0 4px",
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  gap: "0",
  padding: "0 20px",
  borderBottom: "1px solid var(--rule)",
};

const tabStyle: React.CSSProperties = {
  padding: "8px 16px",
  background: "none",
  border: "none",
  borderBottom: "2px solid transparent",
  color: "var(--ink3)",
  fontSize: "12px",
  cursor: "pointer",
  fontWeight: 500,
};

const activeTabStyle: React.CSSProperties = {
  ...tabStyle,
  color: "var(--ink)",
  borderBottomColor: "var(--ink)",
};

const modalBodyStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "16px 20px",
};

const modalFooterStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "12px 20px",
  borderTop: "1px solid var(--rule)",
};

const cancelButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  background: "transparent",
  border: "1px solid var(--rule)",
  borderRadius: "6px",
  color: "var(--ink3)",
  fontSize: "12px",
  cursor: "pointer",
};

const saveButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  background: "var(--ink)",
  border: "none",
  borderRadius: "6px",
  color: "#fff",
  fontSize: "12px",
  cursor: "pointer",
  fontWeight: 500,
};

const fieldRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--ink3)",
  minWidth: "140px",
};

const fieldInputStyle: React.CSSProperties = {
  padding: "5px 8px",
  background: "var(--bg)",
  border: "1px solid var(--rule)",
  borderRadius: "4px",
  color: "var(--ink)",
  fontSize: "12px",
  outline: "none",
  width: "160px",
};

const checkboxLabelStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--ink)",
  display: "flex",
  alignItems: "center",
  gap: "4px",
  cursor: "pointer",
};

const tagStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  padding: "2px 8px",
  background: "var(--panel)",
  border: "1px solid var(--rule)",
  borderRadius: "4px",
  fontSize: "11px",
  color: "var(--ink)",
};

const tagRemoveStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--ink3)",
  cursor: "pointer",
  padding: "0",
  fontSize: "14px",
  lineHeight: 1,
};

const addButtonStyle: React.CSSProperties = {
  padding: "5px 10px",
  background: "var(--panel)",
  border: "1px solid var(--rule)",
  borderRadius: "4px",
  color: "var(--ink)",
  fontSize: "11px",
  cursor: "pointer",
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  minHeight: "400px",
  padding: "12px",
  background: "var(--panel)",
  border: "1px solid var(--rule)",
  borderRadius: "6px",
  color: "var(--ink)",
  fontSize: "12px",
  fontFamily: "monospace",
  resize: "vertical",
  outline: "none",
  boxSizing: "border-box",
};
