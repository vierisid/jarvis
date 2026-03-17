import React, { useState, useEffect, useCallback } from "react";
import "../styles/authority.css";

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

const LEVEL_LABELS: Record<number, string> = {
  1: "Read-only", 2: "Suggest", 3: "Conservative", 4: "Moderate",
  5: "Capable", 6: "Autonomous", 7: "Trusted", 8: "High trust",
  9: "Near-full", 10: "Full autonomy",
};

const ALL_CATEGORIES = [
  "read_data", "write_data", "delete_data", "execute_command", "access_browser",
  "control_app", "send_email", "send_message",
  "make_payment", "spawn_agent", "terminate_agent",
  "install_software", "modify_settings",
];

function getLevelColor(level: number): string {
  if (level <= 3) return "#34D399";
  if (level <= 6) return "#FBBF24";
  if (level <= 8) return "#FF9800";
  return "#FB7185";
}

// Arc gauge: total arc length ~251 for this path
function getArcOffset(level: number): number {
  const totalArc = 251;
  return totalArc - (totalArc * (level / 10));
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
         d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function tryFormatJSON(str: string): string {
  try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; }
}

// ── Main Component ──

export default function AuthorityPage() {
  const [tab, setTab] = useState<Tab>("approvals");
  const [emergencyState, setEmergencyState] = useState("normal");
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [auditStats, setAuditStats] = useState<AuditStats | null>(null);

  // Fetch emergency state on mount
  useEffect(() => {
    fetch(`${API}/api/authority/status`).then(r => r.json()).then(data => {
      if (data.emergency_state) setEmergencyState(data.emergency_state);
    }).catch(() => {});
  }, []);

  // Fetch pending count for gauge panel
  const refreshPending = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/authority/approvals?status=pending`);
      setPending(await res.json());
    } catch {}
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/authority/audit/stats`);
      setAuditStats(await res.json());
    } catch {}
  }, []);

  useEffect(() => { refreshPending(); refreshStats(); }, [refreshPending, refreshStats]);
  useEffect(() => {
    const timer = setInterval(() => { refreshPending(); refreshStats(); }, 5000);
    return () => clearInterval(timer);
  }, [refreshPending, refreshStats]);

  const handleEmergency = async (action: string) => {
    try {
      const res = await fetch(`${API}/api/authority/emergency/${action}`, { method: "POST" });
      const data = await res.json();
      if (data.state) setEmergencyState(data.state);
    } catch (err) {
      console.error("Emergency action failed:", err);
    }
  };

  // Read config for gauge
  const [config, setConfig] = useState<AuthorityConfig | null>(null);
  useEffect(() => {
    fetch(`${API}/api/authority/config`).then(r => r.json()).then(setConfig).catch(() => {});
  }, []);

  const level = config?.default_level ?? 3;
  const levelColor = getLevelColor(level);

  return (
    <div className="au-page">
      <div className="au-atmosphere" />

      {/* Header */}
      <div className="au-header">
        <span className="au-header-title">Authority & Autonomy</span>
        <span className="au-header-spacer" />
        <span className={`au-em-badge ${emergencyState}`}>{emergencyState}</span>
        {emergencyState === "normal" && (
          <>
            <button className="au-em-btn pause" onClick={() => handleEmergency("pause")}>Pause</button>
            <button className="au-em-btn kill" onClick={() => handleEmergency("kill")}>Kill</button>
          </>
        )}
        {emergencyState === "paused" && (
          <>
            <button className="au-em-btn resume" onClick={() => handleEmergency("resume")}>Resume</button>
            <button className="au-em-btn kill" onClick={() => handleEmergency("kill")}>Kill</button>
          </>
        )}
        {emergencyState === "killed" && (
          <button className="au-em-btn reset" onClick={() => handleEmergency("reset")}>Reset</button>
        )}
      </div>

      {/* Split layout */}
      <div className="au-main-layout">

        {/* Left: Gauge panel */}
        <div className="au-gauge-panel">
          {/* Arc gauge */}
          <div className="au-arc-container">
            <svg viewBox="0 0 200 120" style={{ width: 200, height: 120 }}>
              <path d="M 20 110 A 80 80 0 0 1 180 110" className="au-arc-bg" />
              <path
                d="M 20 110 A 80 80 0 0 1 180 110"
                className="au-arc-fill"
                style={{
                  stroke: levelColor,
                  strokeDasharray: 251,
                  strokeDashoffset: getArcOffset(level),
                  filter: `drop-shadow(0 0 6px ${levelColor})`,
                }}
              />
            </svg>
            <div className="au-gauge-value">
              <div className="au-gauge-number" style={{ color: levelColor }}>{level}</div>
              <div className="au-gauge-sublabel">{LEVEL_LABELS[level] ?? "Custom"}</div>
            </div>
          </div>
          <div className="au-level-range">
            <span>1</span>
            <span>5</span>
            <span>10</span>
          </div>

          {/* Stats */}
          <div className="au-gauge-stats">
            <div className="au-g-stat">
              <div className="au-g-dot" style={{ background: "#FBBF24", boxShadow: "0 0 6px rgba(251,191,36,0.4)" }} />
              <div className="au-g-info">
                <div className="au-g-label">Pending</div>
                <div className="au-g-val" style={{ color: "#FBBF24" }}>{pending.length}</div>
              </div>
            </div>
            <div className="au-g-stat">
              <div className="au-g-dot" style={{ background: "#34D399" }} />
              <div className="au-g-info">
                <div className="au-g-label">Approved Today</div>
                <div className="au-g-val" style={{ color: "#34D399" }}>{auditStats?.allowed ?? 0}</div>
              </div>
            </div>
            <div className="au-g-stat">
              <div className="au-g-dot" style={{ background: "#FB7185" }} />
              <div className="au-g-info">
                <div className="au-g-label">Denied Today</div>
                <div className="au-g-val" style={{ color: "#FB7185" }}>{auditStats?.denied ?? 0}</div>
              </div>
            </div>
            <div className="au-g-stat">
              <div className="au-g-dot" style={{ background: "#8B5CF6" }} />
              <div className="au-g-info">
                <div className="au-g-label">Total Audit</div>
                <div className="au-g-val" style={{ color: "#A78BFA" }}>{auditStats?.total ?? 0}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Content panel */}
        <div className="au-content-panel">
          <div className="au-tabs">
            <button className={`au-tab-btn${tab === "approvals" ? " active" : ""}`} onClick={() => setTab("approvals")}>
              Approvals <span className="au-tab-count" style={{ color: "#FBBF24" }}>{pending.length}</span>
            </button>
            <button className={`au-tab-btn${tab === "audit" ? " active" : ""}`} onClick={() => setTab("audit")}>
              Audit Trail
            </button>
            <button className={`au-tab-btn${tab === "config" ? " active" : ""}`} onClick={() => setTab("config")}>
              Rules & Config
            </button>
          </div>

          {tab === "approvals" && <ApprovalQueue onRefresh={refreshPending} />}
          {tab === "audit" && <AuditTrailTab />}
          {tab === "config" && <ConfigTab onConfigChange={() => {
            fetch(`${API}/api/authority/config`).then(r => r.json()).then(setConfig).catch(() => {});
          }} />}
        </div>
      </div>
    </div>
  );
}

// ── Approval Queue Tab ──

function ApprovalQueue({ onRefresh }: { onRefresh: () => void }) {
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
    } catch (err) { console.error("Failed to load approvals:", err); }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleAction = async (id: string, action: "approve" | "deny") => {
    try {
      await fetch(`${API}/api/authority/approvals/${id}/${action}`, { method: "POST" });
      await refresh();
      onRefresh();
    } catch (err) { console.error(`Failed to ${action}:`, err); }
  };

  if (loading) return <div className="au-loading">Loading...</div>;

  const historyFiltered = history.filter(h => h.status !== "pending");

  return (
    <div className="au-tab-content">
      {pending.length === 0 ? (
        <div className="au-empty">No pending approval requests</div>
      ) : (
        pending.map((req, i) => (
          <ApprovalCard
            key={req.id}
            request={req}
            index={i}
            onApprove={() => handleAction(req.id, "approve")}
            onDeny={() => handleAction(req.id, "deny")}
          />
        ))
      )}

      {historyFiltered.length > 0 && (
        <>
          <div className="au-config-label" style={{ marginTop: 24 }}>Recent History</div>
          {historyFiltered.map((req, i) => (
            <div key={req.id} className="au-audit-entry" style={{ animationDelay: `${i * 0.03}s` }}>
              <div className={`au-ae-dot ${req.status === "approved" || req.status === "executed" ? "allowed" : req.status === "denied" ? "denied" : "approval_required"}`} />
              <div className="au-ae-body">
                <div className="au-ae-tool">{req.tool_name}</div>
                <div className="au-ae-detail">{req.agent_name} · {req.action_category} · {req.status}{req.decided_by ? ` by ${req.decided_by}` : ""}</div>
              </div>
              <div className="au-ae-time">{formatTime(req.created_at)}</div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function ApprovalCard({ request, index, onApprove, onDeny }: {
  request: ApprovalRequest; index: number; onApprove: () => void; onDeny: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="au-af-card" style={{ animationDelay: `${index * 0.05}s` }}>
      <div className={`au-af-indicator ${request.urgency === "urgent" ? "urgent" : "pending"}`} />
      <div className="au-af-body">
        <div className="au-af-tool">{request.tool_name}</div>
        <div className="au-af-detail">{request.reason || request.action_category}</div>
        <div className="au-af-meta">{request.agent_name} · {timeAgo(request.created_at)} · {request.action_category}</div>
        <button className="au-af-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Hide details" : "Show details"}
        </button>
        {expanded && <pre className="au-af-pre">{tryFormatJSON(request.tool_arguments)}</pre>}
      </div>
      <div className="au-af-actions">
        <button className="au-af-btn approve" title="Approve" onClick={onApprove}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20,6 9,17 4,12" /></svg>
        </button>
        <button className="au-af-btn deny" title="Deny" onClick={onDeny}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
    </div>
  );
}

// ── Audit Trail Tab ──

function AuditTrailTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const filterParam = filter !== "all" ? `&decision=${filter}` : "";
      const res = await fetch(`${API}/api/authority/audit?limit=100${filterParam}`);
      setEntries(await res.json());
    } catch (err) { console.error("Failed to load audit:", err); }
    setLoading(false);
  }, [filter]);

  useEffect(() => { refresh(); }, [refresh]);

  if (loading) return <div className="au-loading">Loading...</div>;

  return (
    <div className="au-tab-content">
      <div className="au-filter-row">
        <span className="au-filter-label">Filter:</span>
        {["all", "allowed", "denied", "approval_required"].map(f => (
          <button
            key={f}
            className={`au-filter-pill${filter === f ? " active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : f.replace("_", " ")}
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        <div className="au-empty">No audit entries</div>
      ) : (
        entries.map((entry, i) => (
          <div key={entry.id} className="au-audit-entry" style={{ animationDelay: `${i * 0.02}s` }}>
            <div className={`au-ae-dot ${entry.authority_decision}`} />
            <div className="au-ae-body">
              <div className="au-ae-tool">{entry.tool_name}</div>
              <div className="au-ae-detail">
                {entry.agent_name} · {entry.action_category} · {entry.authority_decision.replace("_", " ")}
                {entry.executed ? " · executed" : ""}
              </div>
            </div>
            <div className="au-ae-time">{formatTime(entry.created_at)}</div>
          </div>
        ))
      )}
    </div>
  );
}

// ── Config Tab ──

function ConfigTab({ onConfigChange }: { onConfigChange: () => void }) {
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
    } catch (err) { console.error("Failed to load config:", err); }
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
      onConfigChange();
    } catch (err) { console.error("Failed to update config:", err); }
  };

  const handleAcceptSuggestion = async (s: Suggestion) => {
    try {
      await fetch(`${API}/api/authority/learning/accept`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: s.actionCategory, tool_name: s.toolName }),
      });
      await refresh();
    } catch {}
  };

  const handleDismissSuggestion = async (s: Suggestion) => {
    try {
      await fetch(`${API}/api/authority/learning/dismiss`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: s.actionCategory, tool_name: s.toolName }),
      });
      await refresh();
    } catch {}
  };

  if (loading || !config) return <div className="au-loading">Loading...</div>;

  const level = config.default_level;
  const levelColor = getLevelColor(level);

  return (
    <div className="au-tab-content">
      {/* Authority Level */}
      <div className="au-config-section">
        <div className="au-config-label">Authority Level</div>
        <div className="au-cfg-card">
          <div className="au-level-row">
            <span className="au-lr-num" style={{ color: levelColor }}>{level}</span>
            <div>
              <div className="au-lr-name">{LEVEL_LABELS[level] ?? "Custom"}</div>
              <div className="au-lr-desc">
                {level <= 3 ? "Low autonomy, most actions require approval" :
                 level <= 6 ? "Moderate autonomy with oversight" :
                 level <= 8 ? "High trust, minimal approval needed" :
                 "Full autonomy, no restrictions"}
              </div>
            </div>
          </div>
          <input
            type="range" min={1} max={10} value={level}
            className="au-level-slider"
            style={{ "--thumb-color": levelColor } as React.CSSProperties}
            onChange={(e) => updateConfig({ default_level: Number(e.target.value) })}
          />
          <div className="au-slider-range"><span>1 — Read-only</span><span>10 — Full autonomy</span></div>
        </div>
      </div>

      {/* Learning Suggestions */}
      {suggestions.length > 0 && (
        <div className="au-config-section">
          <div className="au-config-label">Auto-Approve Suggestions</div>
          {suggestions.map((s, i) => (
            <div key={i} className="au-suggestion">
              <div>
                <div className="au-sg-tool">{s.actionCategory} via {s.toolName || "any tool"}</div>
                <div className="au-sg-count">Approved {s.consecutiveApprovals} times in a row</div>
              </div>
              <div className="au-sg-actions">
                <button className="au-sg-btn dismiss" onClick={() => handleDismissSuggestion(s)}>Dismiss</button>
                <button className="au-sg-btn accept" onClick={() => handleAcceptSuggestion(s)}>Accept</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Governed Categories */}
      <div className="au-config-section">
        <div className="au-config-label">Governed Categories</div>
        <div className="au-cat-chips">
          {ALL_CATEGORIES.map(cat => (
            <button
              key={cat}
              className={`au-cat-chip${config.governed_categories.includes(cat) ? " governed" : ""}`}
              onClick={() => {
                const current = config.governed_categories;
                const updated = current.includes(cat) ? current.filter(c => c !== cat) : [...current, cat];
                updateConfig({ governed_categories: updated });
              }}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Overrides */}
      <div className="au-config-section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div className="au-config-label" style={{ margin: 0 }}>Permission Overrides</div>
          <button className="au-add-btn" onClick={() => setShowAddOverride(!showAddOverride)}>
            {showAddOverride ? "Cancel" : "+ Add"}
          </button>
        </div>
        {showAddOverride && (
          <AddOverrideForm onAdd={(o) => {
            updateConfig({ overrides: [...config.overrides, o] });
            setShowAddOverride(false);
          }} />
        )}
        {config.overrides.length === 0 && !showAddOverride ? (
          <div className="au-empty" style={{ padding: 16 }}>No overrides configured</div>
        ) : (
          config.overrides.map((o, i) => (
            <div key={i} className="au-rule-entry">
              <div>
                <span className="au-re-code">{o.action}</span>
                <span className="au-re-detail">
                  {o.role_id ? `[${o.role_id}]` : "[global]"} — {o.allowed ? (o.requires_approval ? "allowed w/ approval" : "always allowed") : "denied"}
                </span>
              </div>
              <button className="au-re-remove" onClick={() => {
                const updated = [...config.overrides];
                updated.splice(i, 1);
                updateConfig({ overrides: updated });
              }}>Remove</button>
            </div>
          ))
        )}
      </div>

      {/* Context Rules */}
      <div className="au-config-section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div className="au-config-label" style={{ margin: 0 }}>Context Rules</div>
          <button className="au-add-btn" onClick={() => setShowAddRule(!showAddRule)}>
            {showAddRule ? "Cancel" : "+ Add"}
          </button>
        </div>
        {showAddRule && (
          <AddContextRuleForm onAdd={(r) => {
            updateConfig({ context_rules: [...config.context_rules, r] });
            setShowAddRule(false);
          }} />
        )}
        {config.context_rules.length === 0 && !showAddRule ? (
          <div className="au-empty" style={{ padding: 16 }}>No context rules configured</div>
        ) : (
          config.context_rules.map(rule => (
            <div key={rule.id} className="au-rule-entry">
              <div>
                <span className="au-re-code">{rule.description}</span>
                <span className="au-re-detail"> {rule.action} · {rule.condition} · {rule.effect}</span>
              </div>
              <button className="au-re-remove" onClick={() => {
                updateConfig({ context_rules: config.context_rules.filter(r => r.id !== rule.id) });
              }}>Remove</button>
            </div>
          ))
        )}
      </div>

      {/* Learning */}
      <div className="au-config-section">
        <div className="au-config-label">Learning</div>
        <div className="au-cfg-card">
          <div className="au-toggle-row" style={{ marginBottom: config.learning.enabled ? 14 : 0 }}>
            <div>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.92)" }}>Auto-approve learning</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.30)", marginTop: 2 }}>Suggest rules after repeated approvals</div>
            </div>
            <button
              className={`au-toggle-sw ${config.learning.enabled ? "on" : "off"}`}
              onClick={() => updateConfig({ learning: { ...config.learning, enabled: !config.learning.enabled } })}
            >
              <div className="au-toggle-knob" />
            </button>
          </div>
          {config.learning.enabled && (
            <div className="au-toggle-row">
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>Suggestion threshold</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
                <button className="au-step-btn" onClick={() => {
                  const v = Math.max(1, config.learning.suggest_threshold - 1);
                  updateConfig({ learning: { ...config.learning, suggest_threshold: v } });
                }}>-</button>
                <span style={{ fontSize: 16, fontWeight: 700, color: "#A78BFA", fontFamily: "'JetBrains Mono', monospace", minWidth: 20, textAlign: "center" as const }}>
                  {config.learning.suggest_threshold}
                </span>
                <button className="au-step-btn" onClick={() => {
                  const v = Math.min(50, config.learning.suggest_threshold + 1);
                  updateConfig({ learning: { ...config.learning, suggest_threshold: v } });
                }}>+</button>
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.30)" }}>approvals</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Add Override Form ──

function AddOverrideForm({ onAdd }: { onAdd: (o: AuthorityConfig["overrides"][0]) => void }) {
  const [action, setAction] = useState(ALL_CATEGORIES[0]!);
  const [roleId, setRoleId] = useState("");
  const [effect, setEffect] = useState<"deny" | "allow" | "allow_approval">("deny");

  return (
    <div className="au-inline-form">
      <div className="au-form-row">
        <label className="au-form-label">Action</label>
        <select value={action} onChange={e => setAction(e.target.value)} className="au-form-select">
          {ALL_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="au-form-row">
        <label className="au-form-label">Role</label>
        <input value={roleId} onChange={e => setRoleId(e.target.value)} placeholder="Leave empty for global" className="au-form-input" />
      </div>
      <div className="au-form-row">
        <label className="au-form-label">Effect</label>
        <select value={effect} onChange={e => setEffect(e.target.value as typeof effect)} className="au-form-select">
          <option value="deny">Deny</option>
          <option value="allow">Always allow</option>
          <option value="allow_approval">Allow with approval</option>
        </select>
      </div>
      <button className="au-form-submit" onClick={() => onAdd({
        action, role_id: roleId || undefined,
        allowed: effect !== "deny",
        requires_approval: effect === "allow_approval" ? true : undefined,
      })}>Add Override</button>
    </div>
  );
}

// ── Add Context Rule Form ──

function AddContextRuleForm({ onAdd }: { onAdd: (r: AuthorityConfig["context_rules"][0]) => void }) {
  const [action, setAction] = useState(ALL_CATEGORIES[0]!);
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
    <div className="au-inline-form">
      <div className="au-form-row">
        <label className="au-form-label">Action</label>
        <select value={action} onChange={e => setAction(e.target.value)} className="au-form-select">
          {ALL_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="au-form-row">
        <label className="au-form-label">Condition</label>
        <select value={condition} onChange={e => setCondition(e.target.value as typeof condition)} className="au-form-select">
          <option value="always">Always</option>
          <option value="time_range">Time range</option>
          <option value="tool_name">Specific tool</option>
        </select>
      </div>
      {condition === "time_range" && (
        <div className="au-form-row">
          <label className="au-form-label">Time</label>
          <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className="au-form-input" style={{ maxWidth: 120 }} />
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.30)" }}>to</span>
          <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} className="au-form-input" style={{ maxWidth: 120 }} />
        </div>
      )}
      {condition === "tool_name" && (
        <div className="au-form-row">
          <label className="au-form-label">Tool</label>
          <input value={toolName} onChange={e => setToolName(e.target.value)} placeholder="e.g. run_command" className="au-form-input" />
        </div>
      )}
      <div className="au-form-row">
        <label className="au-form-label">Effect</label>
        <select value={effect} onChange={e => setEffect(e.target.value as typeof effect)} className="au-form-select">
          <option value="deny">Deny</option>
          <option value="allow">Allow</option>
          <option value="require_approval">Require approval</option>
        </select>
      </div>
      <div className="au-form-row">
        <label className="au-form-label">Description</label>
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Block payments at night" className="au-form-input" />
      </div>
      <button className="au-form-submit" onClick={() => {
        if (!description.trim()) return;
        onAdd({ id: `rule_${Date.now()}`, action, condition, params: buildParams(), effect, description: description.trim() });
      }}>Add Rule</button>
    </div>
  );
}
