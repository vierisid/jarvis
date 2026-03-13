import React, { useState, useEffect, useCallback } from "react";

const API = `http://${window.location.hostname}:3142`;

type ApprovalRequest = {
  id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  tool_arguments: string;
  action_category: string;
  urgency: string;
  reason: string;
  context: string;
  status: string;
  decided_at: number | null;
  decided_by: string | null;
  executed_at: number | null;
  execution_result: string | null;
  created_at: number;
};

type AuditEntry = {
  id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  action_category: string;
  authority_decision: string;
  approval_id: string | null;
  executed: number;
  execution_time_ms: number | null;
  created_at: number;
};

type AuditStats = {
  total: number;
  allowed: number;
  denied: number;
  approvalRequired: number;
  byCategory: Record<string, number>;
};

type AuthorityConfig = {
  default_level: number;
  governed_categories: string[];
  overrides: Array<{
    action: string;
    role_id?: string;
    allowed: boolean;
    requires_approval?: boolean;
  }>;
  context_rules: Array<{
    id: string;
    action: string;
    condition: string;
    params: Record<string, unknown>;
    effect: string;
    description: string;
  }>;
  learning: { enabled: boolean; suggest_threshold: number };
  emergency_state: string;
};

type Suggestion = {
  actionCategory: string;
  toolName: string;
  consecutiveApprovals: number;
  suggestedRule: { action: string; allowed: boolean; requires_approval: boolean };
};

type Tab = "approvals" | "audit" | "config";

export default function AuthorityPage() {
  const [tab, setTab] = useState<Tab>("approvals");
  const [emergencyState, setEmergencyState] = useState<string>("normal");

  useEffect(() => {
    fetch(`${API}/api/authority/status`).then(r => r.json()).then(data => {
      if (data.emergency_state) setEmergencyState(data.emergency_state);
    }).catch(() => {});
  }, []);

  const handleEmergency = async (action: string) => {
    try {
      const res = await fetch(`${API}/api/authority/emergency/${action}`, { method: "POST" });
      const data = await res.json();
      if (data.state) setEmergencyState(data.state);
    } catch (err) {
      console.error("Emergency action failed:", err);
    }
  };

  return (
    <div style={{ padding: "24px", overflow: "auto", height: "100%" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "24px" }}>
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: 600, color: "var(--j-text)", margin: 0 }}>
            Authority & Autonomy
          </h1>
          <div style={{ fontSize: "13px", color: "var(--j-text-muted)", marginTop: "4px" }}>
            Approval queue, audit trail, and authority configuration
          </div>
        </div>

        {/* Emergency Controls */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <span style={{
            fontSize: "12px",
            padding: "4px 10px",
            borderRadius: "4px",
            background: emergencyState === "normal" ? "rgba(0, 200, 83, 0.15)" :
                        emergencyState === "paused" ? "rgba(255, 193, 7, 0.15)" : "rgba(244, 67, 54, 0.15)",
            color: emergencyState === "normal" ? "var(--j-success)" :
                   emergencyState === "paused" ? "#ffc107" : "#f44336",
            fontWeight: 600,
          }}>
            {emergencyState.toUpperCase()}
          </span>

          {emergencyState === "normal" && (
            <>
              <EmergencyButton label="Pause" color="#ffc107" onClick={() => handleEmergency("pause")} />
              <EmergencyButton label="Kill" color="#f44336" onClick={() => handleEmergency("kill")} />
            </>
          )}
          {emergencyState === "paused" && (
            <>
              <EmergencyButton label="Resume" color="#00c853" onClick={() => handleEmergency("resume")} />
              <EmergencyButton label="Kill" color="#f44336" onClick={() => handleEmergency("kill")} />
            </>
          )}
          {emergencyState === "killed" && (
            <EmergencyButton label="Reset" color="#00c853" onClick={() => handleEmergency("reset")} />
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "0", borderBottom: "1px solid var(--j-border)", marginBottom: "20px" }}>
        <TabButton label="Approval Queue" active={tab === "approvals"} onClick={() => setTab("approvals")} />
        <TabButton label="Audit Trail" active={tab === "audit"} onClick={() => setTab("audit")} />
        <TabButton label="Rules & Config" active={tab === "config"} onClick={() => setTab("config")} />
      </div>

      {/* Tab Content */}
      {tab === "approvals" && <ApprovalQueue />}
      {tab === "audit" && <AuditTrailTab />}
      {tab === "config" && <ConfigTab />}
    </div>
  );
}

// --- Approval Queue ---

function ApprovalQueue() {
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [history, setHistory] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [pRes, hRes] = await Promise.all([
        fetch(`${API}/api/authority/approvals?status=pending`),
        fetch(`${API}/api/authority/approvals?limit=20`),
      ]);
      setPending(await pRes.json());
      setHistory(await hRes.json());
    } catch (err) {
      console.error("Failed to load approvals:", err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-refresh every 5s
  useEffect(() => {
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleAction = async (id: string, action: "approve" | "deny") => {
    try {
      await fetch(`${API}/api/authority/approvals/${id}/${action}`, { method: "POST" });
      await refresh();
    } catch (err) {
      console.error(`Failed to ${action}:`, err);
    }
  };

  if (loading) return <div style={{ color: "var(--j-text-muted)" }}>Loading...</div>;

  return (
    <div>
      {/* Pending Approvals */}
      <h3 style={{ fontSize: "14px", fontWeight: 600, color: "var(--j-text)", margin: "0 0 12px 0" }}>
        Pending ({pending.length})
      </h3>
      {pending.length === 0 ? (
        <div style={emptyStyle}>No pending approval requests</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "24px" }}>
          {pending.map(req => (
            <ApprovalCard key={req.id} request={req} onApprove={() => handleAction(req.id, "approve")} onDeny={() => handleAction(req.id, "deny")} />
          ))}
        </div>
      )}

      {/* History */}
      <h3 style={{ fontSize: "14px", fontWeight: 600, color: "var(--j-text)", margin: "24px 0 12px 0" }}>
        Recent History
      </h3>
      {history.filter(h => h.status !== "pending").length === 0 ? (
        <div style={emptyStyle}>No history yet</div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Time</th>
              <th style={thStyle}>Agent</th>
              <th style={thStyle}>Tool</th>
              <th style={thStyle}>Category</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Decided By</th>
            </tr>
          </thead>
          <tbody>
            {history.filter(h => h.status !== "pending").map(req => (
              <tr key={req.id}>
                <td style={tdStyle}>{formatTime(req.created_at)}</td>
                <td style={tdStyle}>{req.agent_name}</td>
                <td style={tdStyle}><code>{req.tool_name}</code></td>
                <td style={tdStyle}>{req.action_category}</td>
                <td style={tdStyle}>
                  <StatusBadge status={req.status} />
                </td>
                <td style={tdStyle}>{req.decided_by ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ApprovalCard({ request, onApprove, onDeny }: { request: ApprovalRequest; onApprove: () => void; onDeny: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const shortId = request.id.slice(0, 8);

  return (
    <div style={{
      background: "var(--j-surface)",
      border: `1px solid ${request.urgency === "urgent" ? "rgba(255, 193, 7, 0.4)" : "var(--j-border)"}`,
      borderRadius: "8px",
      padding: "14px 16px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <code style={{ fontSize: "13px", color: "var(--j-accent)" }}>{request.tool_name}</code>
            <span style={{ fontSize: "11px", color: "var(--j-text-muted)", padding: "2px 6px", background: "var(--j-surface-hover)", borderRadius: "3px" }}>
              {request.action_category}
            </span>
            {request.urgency === "urgent" && (
              <span style={{ fontSize: "10px", color: "#ffc107", fontWeight: 700 }}>URGENT</span>
            )}
          </div>
          <div style={{ fontSize: "12px", color: "var(--j-text-dim)", marginTop: "4px" }}>
            {request.agent_name} &middot; {formatTime(request.created_at)} &middot; <span style={{ fontFamily: "monospace", fontSize: "11px" }}>{shortId}</span>
          </div>
          {request.reason && (
            <div style={{ fontSize: "12px", color: "var(--j-text-muted)", marginTop: "4px" }}>
              {request.reason}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button onClick={() => setExpanded(!expanded)} style={linkBtnStyle}>
            {expanded ? "Hide" : "Details"}
          </button>
          <button onClick={onDeny} style={{ ...actionBtnStyle, background: "rgba(244, 67, 54, 0.15)", color: "#f44336" }}>
            Deny
          </button>
          <button onClick={onApprove} style={{ ...actionBtnStyle, background: "rgba(0, 200, 83, 0.15)", color: "#00c853" }}>
            Approve
          </button>
        </div>
      </div>

      {expanded && (
        <pre style={{
          marginTop: "10px",
          padding: "10px",
          background: "var(--j-bg)",
          borderRadius: "4px",
          fontSize: "11px",
          color: "var(--j-text-dim)",
          overflow: "auto",
          maxHeight: "200px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}>
          {tryFormatJSON(request.tool_arguments)}
        </pre>
      )}
    </div>
  );
}

// --- Audit Trail ---

function AuditTrailTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const filterParam = filter !== "all" ? `&decision=${filter}` : "";
      const [eRes, sRes] = await Promise.all([
        fetch(`${API}/api/authority/audit?limit=100${filterParam}`),
        fetch(`${API}/api/authority/audit/stats`),
      ]);
      setEntries(await eRes.json());
      setStats(await sRes.json());
    } catch (err) {
      console.error("Failed to load audit:", err);
    }
    setLoading(false);
  }, [filter]);

  useEffect(() => { refresh(); }, [refresh]);

  if (loading) return <div style={{ color: "var(--j-text-muted)" }}>Loading...</div>;

  return (
    <div>
      {/* Stats cards */}
      {stats && (
        <div style={{ display: "flex", gap: "12px", marginBottom: "20px" }}>
          <StatCard label="Total" value={stats.total} color="var(--j-text)" />
          <StatCard label="Allowed" value={stats.allowed} color="var(--j-success)" />
          <StatCard label="Denied" value={stats.denied} color="#f44336" />
          <StatCard label="Approval Required" value={stats.approvalRequired} color="#ffc107" />
        </div>
      )}

      {/* Filter */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
        <span style={{ fontSize: "12px", color: "var(--j-text-muted)" }}>Filter:</span>
        {["all", "allowed", "denied", "approval_required"].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              ...chipStyle,
              background: filter === f ? "rgba(0, 212, 255, 0.15)" : "transparent",
              color: filter === f ? "var(--j-accent)" : "var(--j-text-dim)",
              borderColor: filter === f ? "var(--j-accent)" : "var(--j-border)",
            }}
          >
            {f === "all" ? "All" : f.replace("_", " ")}
          </button>
        ))}
      </div>

      {/* Table */}
      {entries.length === 0 ? (
        <div style={emptyStyle}>No audit entries yet</div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Time</th>
              <th style={thStyle}>Agent</th>
              <th style={thStyle}>Tool</th>
              <th style={thStyle}>Category</th>
              <th style={thStyle}>Decision</th>
              <th style={thStyle}>Executed</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <tr key={entry.id}>
                <td style={tdStyle}>{formatTime(entry.created_at)}</td>
                <td style={tdStyle}>{entry.agent_name}</td>
                <td style={tdStyle}><code>{entry.tool_name}</code></td>
                <td style={tdStyle}>{entry.action_category}</td>
                <td style={tdStyle}>
                  <StatusBadge status={entry.authority_decision} />
                </td>
                <td style={tdStyle}>{entry.executed ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- Config Tab ---

function ConfigTab() {
  const [config, setConfig] = useState<AuthorityConfig | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddOverride, setShowAddOverride] = useState(false);
  const [showAddRule, setShowAddRule] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [cRes, sRes] = await Promise.all([
        fetch(`${API}/api/authority/config`),
        fetch(`${API}/api/authority/learning/suggestions`),
      ]);
      setConfig(await cRes.json());
      setSuggestions(await sRes.json());
    } catch (err) {
      console.error("Failed to load config:", err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const updateConfig = async (updates: Partial<AuthorityConfig>) => {
    try {
      await fetch(`${API}/api/authority/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      await refresh();
    } catch (err) {
      console.error("Failed to update config:", err);
    }
  };

  const handleAcceptSuggestion = async (s: Suggestion) => {
    try {
      await fetch(`${API}/api/authority/learning/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: s.actionCategory, tool_name: s.toolName }),
      });
      await refresh();
    } catch (err) {
      console.error("Failed to accept suggestion:", err);
    }
  };

  const handleDismissSuggestion = async (s: Suggestion) => {
    try {
      await fetch(`${API}/api/authority/learning/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: s.actionCategory, tool_name: s.toolName }),
      });
      await refresh();
    } catch (err) {
      console.error("Failed to dismiss suggestion:", err);
    }
  };

  const toggleGoverned = (category: string) => {
    if (!config) return;
    const current = config.governed_categories;
    const updated = current.includes(category)
      ? current.filter(c => c !== category)
      : [...current, category];
    updateConfig({ governed_categories: updated });
  };

  const removeOverride = (index: number) => {
    if (!config) return;
    const updated = [...config.overrides];
    updated.splice(index, 1);
    updateConfig({ overrides: updated });
  };

  const addOverride = (override: AuthorityConfig["overrides"][0]) => {
    if (!config) return;
    updateConfig({ overrides: [...config.overrides, override] });
    setShowAddOverride(false);
  };

  const removeContextRule = (id: string) => {
    if (!config) return;
    updateConfig({ context_rules: config.context_rules.filter(r => r.id !== id) });
  };

  const addContextRule = (rule: AuthorityConfig["context_rules"][0]) => {
    if (!config) return;
    updateConfig({ context_rules: [...config.context_rules, rule] });
    setShowAddRule(false);
  };

  if (loading || !config) return <div style={{ color: "var(--j-text-muted)" }}>Loading...</div>;

  const allCategories = [
    "read_data", "write_data", "delete_data", "execute_command", "access_browser",
    "control_app", "send_email", "send_message",
    "make_payment", "spawn_agent", "terminate_agent",
    "install_software", "modify_settings",
  ];

  const levelLabels: Record<number, string> = {
    1: "Read-only", 2: "Suggest", 3: "Conservative", 4: "Moderate",
    5: "Capable", 6: "Autonomous", 7: "Trusted", 8: "High trust",
    9: "Near-full", 10: "Full autonomy",
  };

  return (
    <div style={{ display: "flex", gap: "24px" }}>
      {/* Left: Authority Level + Governed Categories + Overrides */}
      <div style={{ flex: 1 }}>
        {/* Authority Level Slider */}
        <h3 style={sectionHeading}>Default Authority Level</h3>
        <div style={{
          padding: "16px",
          background: "var(--j-surface)",
          border: "1px solid var(--j-border)",
          borderRadius: "8px",
          marginBottom: "20px",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <span style={{ fontSize: "13px", color: "var(--j-text)" }}>
              Level {config.default_level} — {levelLabels[config.default_level] ?? "Custom"}
            </span>
            <span style={{
              fontSize: "20px",
              fontWeight: 700,
              color: config.default_level <= 3 ? "var(--j-success)" :
                     config.default_level <= 6 ? "#ffc107" :
                     config.default_level <= 8 ? "#ff9800" : "#f44336",
            }}>
              {config.default_level}/10
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            value={config.default_level}
            onChange={(e) => updateConfig({ default_level: Number(e.target.value) })}
            style={{ width: "100%", accentColor: "var(--j-accent)", cursor: "pointer" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px" }}>
            <span style={{ fontSize: "10px", color: "var(--j-text-muted)" }}>1 — Read-only</span>
            <span style={{ fontSize: "10px", color: "var(--j-text-muted)" }}>10 — Full autonomy</span>
          </div>
        </div>

        {/* Learning Suggestions */}
        {suggestions.length > 0 && (
          <div style={{ marginBottom: "20px" }}>
            <h3 style={sectionHeading}>Auto-Approve Suggestions</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {suggestions.map((s, i) => (
                <div key={i} style={{
                  background: "rgba(0, 212, 255, 0.05)",
                  border: "1px solid rgba(0, 212, 255, 0.2)",
                  borderRadius: "6px",
                  padding: "12px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}>
                  <div>
                    <div style={{ fontSize: "13px", color: "var(--j-text)" }}>
                      <code>{s.actionCategory}</code> via <code>{s.toolName || "any tool"}</code>
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--j-text-muted)", marginTop: "2px" }}>
                      Approved {s.consecutiveApprovals} times in a row
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button onClick={() => handleDismissSuggestion(s)} style={{ ...actionBtnStyle, background: "transparent", color: "var(--j-text-dim)" }}>
                      Dismiss
                    </button>
                    <button onClick={() => handleAcceptSuggestion(s)} style={{ ...actionBtnStyle, background: "rgba(0, 200, 83, 0.15)", color: "#00c853" }}>
                      Accept
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Governed Categories */}
        <h3 style={sectionHeading}>Governed Categories</h3>
        <div style={{ fontSize: "12px", color: "var(--j-text-muted)", marginBottom: "10px" }}>
          Actions requiring user approval before execution
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "20px" }}>
          {allCategories.map(cat => {
            const isGoverned = config.governed_categories.includes(cat);
            return (
              <button
                key={cat}
                onClick={() => toggleGoverned(cat)}
                style={{
                  ...chipStyle,
                  background: isGoverned ? "rgba(255, 193, 7, 0.15)" : "transparent",
                  color: isGoverned ? "#ffc107" : "var(--j-text-dim)",
                  borderColor: isGoverned ? "rgba(255, 193, 7, 0.4)" : "var(--j-border)",
                }}
              >
                {cat}
              </button>
            );
          })}
        </div>

        {/* Overrides */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <h3 style={{ ...sectionHeading, margin: 0 }}>Permission Overrides</h3>
          <button onClick={() => setShowAddOverride(!showAddOverride)} style={{ ...actionBtnStyle, background: "rgba(0, 212, 255, 0.1)", color: "var(--j-accent)" }}>
            {showAddOverride ? "Cancel" : "+ Add"}
          </button>
        </div>
        {showAddOverride && <AddOverrideForm categories={allCategories} onAdd={addOverride} />}
        {config.overrides.length === 0 && !showAddOverride ? (
          <div style={emptyStyle}>No overrides configured</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {config.overrides.map((o, i) => (
              <div key={i} style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 12px",
                background: "var(--j-surface)",
                border: "1px solid var(--j-border)",
                borderRadius: "6px",
              }}>
                <div>
                  <code style={{ fontSize: "12px" }}>{o.action}</code>
                  <span style={{ fontSize: "11px", color: "var(--j-text-muted)", marginLeft: "8px" }}>
                    {o.role_id ? `[${o.role_id}]` : "[global]"} &mdash; {o.allowed ? (o.requires_approval ? "allowed w/ approval" : "always allowed") : "denied"}
                  </span>
                </div>
                <button onClick={() => removeOverride(i)} style={{ ...linkBtnStyle, color: "#f44336" }}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right: Context Rules + Learning Settings */}
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <h3 style={{ ...sectionHeading, margin: 0 }}>Context Rules</h3>
          <button onClick={() => setShowAddRule(!showAddRule)} style={{ ...actionBtnStyle, background: "rgba(0, 212, 255, 0.1)", color: "var(--j-accent)" }}>
            {showAddRule ? "Cancel" : "+ Add"}
          </button>
        </div>
        {showAddRule && <AddContextRuleForm categories={allCategories} onAdd={addContextRule} />}
        {config.context_rules.length === 0 && !showAddRule ? (
          <div style={emptyStyle}>No context rules configured</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {config.context_rules.map(rule => (
              <div key={rule.id} style={{
                padding: "10px 12px",
                background: "var(--j-surface)",
                border: "1px solid var(--j-border)",
                borderRadius: "6px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
              }}>
                <div>
                  <div style={{ fontSize: "13px", color: "var(--j-text)" }}>{rule.description}</div>
                  <div style={{ fontSize: "11px", color: "var(--j-text-muted)", marginTop: "2px" }}>
                    {rule.action} &middot; {rule.condition} &middot; effect: {rule.effect}
                  </div>
                </div>
                <button onClick={() => removeContextRule(rule.id)} style={{ ...linkBtnStyle, color: "#f44336", flexShrink: 0 }}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Learning Settings */}
        <h3 style={{ ...sectionHeading, marginTop: "24px" }}>Learning</h3>
        <div style={{
          padding: "14px 16px",
          background: "var(--j-surface)",
          border: "1px solid var(--j-border)",
          borderRadius: "8px",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
            <div>
              <div style={{ fontSize: "13px", color: "var(--j-text)" }}>Auto-approve learning</div>
              <div style={{ fontSize: "11px", color: "var(--j-text-muted)", marginTop: "2px" }}>
                Suggest auto-approve rules after repeated approvals
              </div>
            </div>
            <button
              onClick={() => updateConfig({ learning: { ...config.learning, enabled: !config.learning.enabled } })}
              style={{
                width: "40px",
                height: "22px",
                borderRadius: "11px",
                border: "none",
                background: config.learning.enabled ? "var(--j-accent)" : "var(--j-border)",
                cursor: "pointer",
                position: "relative",
                transition: "background 0.2s",
              }}
            >
              <div style={{
                width: "16px",
                height: "16px",
                borderRadius: "50%",
                background: "#fff",
                position: "absolute",
                top: "3px",
                left: config.learning.enabled ? "21px" : "3px",
                transition: "left 0.2s",
              }} />
            </button>
          </div>
          {config.learning.enabled && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "13px", color: "var(--j-text)" }}>Suggestion threshold</span>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <button
                  onClick={() => {
                    const v = Math.max(1, config.learning.suggest_threshold - 1);
                    updateConfig({ learning: { ...config.learning, suggest_threshold: v } });
                  }}
                  style={{ ...stepBtnStyle }}
                >-</button>
                <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--j-accent)", minWidth: "20px", textAlign: "center" }}>
                  {config.learning.suggest_threshold}
                </span>
                <button
                  onClick={() => {
                    const v = Math.min(50, config.learning.suggest_threshold + 1);
                    updateConfig({ learning: { ...config.learning, suggest_threshold: v } });
                  }}
                  style={{ ...stepBtnStyle }}
                >+</button>
                <span style={{ fontSize: "11px", color: "var(--j-text-muted)" }}>approvals</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Add Override Form ---

function AddOverrideForm({ categories, onAdd }: { categories: string[]; onAdd: (o: AuthorityConfig["overrides"][0]) => void }) {
  const [action, setAction] = useState(categories[0] ?? "read_data");
  const [roleId, setRoleId] = useState("");
  const [effect, setEffect] = useState<"deny" | "allow" | "allow_approval">("deny");

  return (
    <div style={{
      padding: "14px 16px",
      background: "var(--j-surface)",
      border: "1px solid rgba(0, 212, 255, 0.3)",
      borderRadius: "8px",
      marginBottom: "12px",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
    }}>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <label style={formLabelStyle}>Action</label>
        <select value={action} onChange={e => setAction(e.target.value)} style={selectStyle}>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <label style={formLabelStyle}>Role</label>
        <input
          value={roleId}
          onChange={e => setRoleId(e.target.value)}
          placeholder="Leave empty for global"
          style={inputStyle}
        />
      </div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <label style={formLabelStyle}>Effect</label>
        <select value={effect} onChange={e => setEffect(e.target.value as typeof effect)} style={selectStyle}>
          <option value="deny">Deny</option>
          <option value="allow">Always allow</option>
          <option value="allow_approval">Allow with approval</option>
        </select>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={() => onAdd({
            action,
            role_id: roleId || undefined,
            allowed: effect !== "deny",
            requires_approval: effect === "allow_approval" ? true : undefined,
          })}
          style={{ ...actionBtnStyle, background: "rgba(0, 200, 83, 0.15)", color: "#00c853" }}
        >
          Add Override
        </button>
      </div>
    </div>
  );
}

// --- Add Context Rule Form ---

function AddContextRuleForm({ categories, onAdd }: { categories: string[]; onAdd: (r: AuthorityConfig["context_rules"][0]) => void }) {
  const [action, setAction] = useState(categories[0] ?? "read_data");
  const [condition, setCondition] = useState<"always" | "time_range" | "tool_name">("always");
  const [effect, setEffect] = useState<"deny" | "allow" | "require_approval">("deny");
  const [description, setDescription] = useState("");
  const [startTime, setStartTime] = useState("22:00");
  const [endTime, setEndTime] = useState("06:00");
  const [toolName, setToolName] = useState("");

  const buildParams = (): Record<string, unknown> => {
    if (condition === "time_range") return { start: startTime, end: endTime };
    if (condition === "tool_name") return { name: toolName };
    return {};
  };

  return (
    <div style={{
      padding: "14px 16px",
      background: "var(--j-surface)",
      border: "1px solid rgba(0, 212, 255, 0.3)",
      borderRadius: "8px",
      marginBottom: "12px",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
    }}>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <label style={formLabelStyle}>Action</label>
        <select value={action} onChange={e => setAction(e.target.value)} style={selectStyle}>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <label style={formLabelStyle}>Condition</label>
        <select value={condition} onChange={e => setCondition(e.target.value as typeof condition)} style={selectStyle}>
          <option value="always">Always</option>
          <option value="time_range">Time range</option>
          <option value="tool_name">Specific tool</option>
        </select>
      </div>
      {condition === "time_range" && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <label style={formLabelStyle}>Time</label>
          <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} style={{ ...inputStyle, width: "120px" }} />
          <span style={{ fontSize: "12px", color: "var(--j-text-muted)" }}>to</span>
          <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} style={{ ...inputStyle, width: "120px" }} />
        </div>
      )}
      {condition === "tool_name" && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <label style={formLabelStyle}>Tool</label>
          <input value={toolName} onChange={e => setToolName(e.target.value)} placeholder="e.g. run_command" style={inputStyle} />
        </div>
      )}
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <label style={formLabelStyle}>Effect</label>
        <select value={effect} onChange={e => setEffect(e.target.value as typeof effect)} style={selectStyle}>
          <option value="deny">Deny</option>
          <option value="allow">Allow</option>
          <option value="require_approval">Require approval</option>
        </select>
      </div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <label style={formLabelStyle}>Description</label>
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Block payments at night" style={inputStyle} />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={() => {
            if (!description.trim()) return;
            onAdd({
              id: `rule_${Date.now()}`,
              action,
              condition,
              params: buildParams(),
              effect,
              description: description.trim(),
            });
          }}
          style={{ ...actionBtnStyle, background: "rgba(0, 200, 83, 0.15)", color: "#00c853" }}
        >
          Add Rule
        </button>
      </div>
    </div>
  );
}

// --- Shared Components ---

function EmergencyButton({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 14px",
        borderRadius: "4px",
        border: `1px solid ${color}`,
        background: "transparent",
        color,
        fontSize: "12px",
        fontWeight: 600,
        cursor: "pointer",
        transition: "all 0.15s ease",
      }}
      onMouseEnter={e => { e.currentTarget.style.background = `${color}20`; }}
      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
    >
      {label}
    </button>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "10px 18px",
        border: "none",
        borderBottom: active ? "2px solid var(--j-accent)" : "2px solid transparent",
        background: "transparent",
        color: active ? "var(--j-accent)" : "var(--j-text-dim)",
        fontSize: "13px",
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    allowed: { bg: "rgba(0, 200, 83, 0.15)", fg: "#00c853" },
    approved: { bg: "rgba(0, 200, 83, 0.15)", fg: "#00c853" },
    executed: { bg: "rgba(0, 212, 255, 0.15)", fg: "var(--j-accent)" },
    denied: { bg: "rgba(244, 67, 54, 0.15)", fg: "#f44336" },
    expired: { bg: "rgba(158, 158, 158, 0.15)", fg: "#9e9e9e" },
    approval_required: { bg: "rgba(255, 193, 7, 0.15)", fg: "#ffc107" },
    pending: { bg: "rgba(255, 193, 7, 0.15)", fg: "#ffc107" },
  };
  const c = colors[status] ?? { bg: "var(--j-surface-hover)", fg: "var(--j-text-dim)" };
  return (
    <span style={{
      fontSize: "11px",
      padding: "2px 8px",
      borderRadius: "3px",
      background: c.bg,
      color: c.fg,
      fontWeight: 600,
    }}>
      {status.replace("_", " ")}
    </span>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      flex: 1,
      padding: "14px 16px",
      background: "var(--j-surface)",
      border: "1px solid var(--j-border)",
      borderRadius: "8px",
      textAlign: "center",
    }}>
      <div style={{ fontSize: "24px", fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: "11px", color: "var(--j-text-muted)", marginTop: "2px" }}>{label}</div>
    </div>
  );
}

// --- Helpers ---

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
         d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function tryFormatJSON(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

// --- Styles ---

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "12px",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--j-border)",
  color: "var(--j-text-muted)",
  fontWeight: 500,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--j-border)",
  color: "var(--j-text-dim)",
};

const emptyStyle: React.CSSProperties = {
  padding: "24px",
  textAlign: "center",
  color: "var(--j-text-muted)",
  fontSize: "13px",
  background: "var(--j-surface)",
  borderRadius: "8px",
  border: "1px solid var(--j-border)",
};

const actionBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: "4px",
  border: "none",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
};

const linkBtnStyle: React.CSSProperties = {
  padding: "4px 8px",
  border: "none",
  background: "transparent",
  color: "var(--j-accent)",
  fontSize: "12px",
  cursor: "pointer",
};

const chipStyle: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: "4px",
  border: "1px solid var(--j-border)",
  background: "transparent",
  fontSize: "12px",
  cursor: "pointer",
};

const sectionHeading: React.CSSProperties = {
  fontSize: "14px",
  fontWeight: 600,
  color: "var(--j-text)",
  margin: "0 0 10px 0",
};

const selectStyle: React.CSSProperties = {
  flex: 1,
  padding: "6px 10px",
  borderRadius: "4px",
  border: "1px solid var(--j-border)",
  background: "var(--j-bg)",
  color: "var(--j-text)",
  fontSize: "12px",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "6px 10px",
  borderRadius: "4px",
  border: "1px solid var(--j-border)",
  background: "var(--j-bg)",
  color: "var(--j-text)",
  fontSize: "12px",
};

const formLabelStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--j-text-muted)",
  minWidth: "70px",
};

const stepBtnStyle: React.CSSProperties = {
  width: "24px",
  height: "24px",
  borderRadius: "4px",
  border: "1px solid var(--j-border)",
  background: "var(--j-bg)",
  color: "var(--j-text)",
  fontSize: "14px",
  fontWeight: 600,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
