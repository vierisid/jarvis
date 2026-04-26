import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const POLL_INTERVAL_MS = 5000;

export type ActionCategory =
  | "read_data"
  | "write_data"
  | "delete_data"
  | "send_message"
  | "send_email"
  | "execute_command"
  | "install_software"
  | "make_payment"
  | "modify_settings"
  | "spawn_agent"
  | "terminate_agent"
  | "access_browser"
  | "control_app";

export const ACTION_CATEGORIES: ReadonlyArray<ActionCategory> = [
  "read_data", "write_data", "delete_data",
  "send_message", "send_email",
  "execute_command", "install_software",
  "make_payment", "modify_settings",
  "spawn_agent", "terminate_agent",
  "access_browser", "control_app",
];

export type EmergencyState = "normal" | "paused" | "killed";

export type AuthorityDecisionType = "allowed" | "denied" | "approval_required";

export interface ApprovalRequest {
  id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  tool_arguments: string | null;
  action_category: ActionCategory;
  reason: string;
  context?: string;
  status: "pending" | "approved" | "denied" | "expired" | "executed";
  urgency: "urgent" | "normal";
  decided_at: number | null;
  decided_by: string | null;
  executed_at: number | null;
  execution_result: string | null;
  created_at: number;
  // enrichment from server
  intent?: string;
  impact?: "read" | "write" | "external" | "destructive";
}

export interface AuditEntry {
  id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  action_category: ActionCategory;
  authority_decision: AuthorityDecisionType;
  approval_id: string | null;
  executed: number;
  execution_time_ms: number | null;
  created_at: number;
}

export interface AuditStats {
  total: number;
  allowed: number;
  denied: number;
  approvalRequired: number;
  byCategory: Record<string, number>;
}

export interface PerActionOverride {
  action: ActionCategory;
  role_id?: string;
  allowed: boolean;
  requires_approval?: boolean;
}

export interface ContextRule {
  id: string;
  action: ActionCategory;
  condition: "always" | "time_range" | "tool_name";
  params: Record<string, unknown>;
  effect: "allow" | "deny" | "require_approval";
  description: string;
}

export interface AuthorityConfig {
  default_level: number;
  governed_categories: ActionCategory[];
  overrides: PerActionOverride[];
  context_rules: ContextRule[];
  learning: { enabled: boolean; suggest_threshold: number };
  emergency_state: EmergencyState;
}

export interface LearningSuggestion {
  actionCategory: ActionCategory;
  toolName: string;
  consecutiveApprovals: number;
  suggestedRule: PerActionOverride;
}

export interface AuthorityStatus {
  enabled: boolean;
  emergency_state: EmergencyState;
  pending_approvals: number;
  config?: AuthorityConfig;
}

interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Authority Room data hook — polls 5 endpoints in parallel + exposes
 * write actions for approve/deny, config mutations, learning accept/
 * dismiss, emergency state changes, and the new quick-override (voice
 * "grant Jarvis email access" path).
 *
 * Designed so failures in any one endpoint don't block the others —
 * the Room renders partial data when, say, learning suggestions fail
 * but config still loads.
 */
export function useAuthorityData() {
  const [status, setStatus] = useState<AuthorityStatus | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [historyApprovals, setHistoryApprovals] = useState<ApprovalRequest[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditStats, setAuditStats] = useState<AuditStats | null>(null);
  const [config, setConfig] = useState<AuthorityConfig | null>(null);
  const [suggestions, setSuggestions] = useState<LearningSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const [sResp, pResp, hResp, aResp, asResp, cResp, lResp] = await Promise.all([
        fetch("/api/authority/status"),
        fetch("/api/authority/approvals?status=pending"),
        fetch("/api/authority/approvals?limit=20"),
        fetch("/api/authority/audit?limit=100"),
        fetch("/api/authority/audit/stats"),
        fetch("/api/authority/config"),
        fetch("/api/authority/learning/suggestions"),
      ]);
      if (sResp.ok) setStatus((await sResp.json()) as AuthorityStatus);
      if (pResp.ok) setPendingApprovals((await pResp.json()) as ApprovalRequest[]);
      if (hResp.ok) setHistoryApprovals((await hResp.json()) as ApprovalRequest[]);
      if (aResp.ok) setAuditEntries((await aResp.json()) as AuditEntry[]);
      if (asResp.ok) setAuditStats((await asResp.json()) as AuditStats);
      if (cResp.ok) setConfig((await cResp.json()) as AuthorityConfig);
      if (lResp.ok) setSuggestions((await lResp.json()) as LearningSuggestion[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load authority data");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const approve = useCallback(async (id: string): Promise<ActionResult> => {
    try {
      const resp = await fetch(`/api/authority/approvals/${encodeURIComponent(id)}/approve`, {
        method: "POST",
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      refresh();
      return { ok: true, message: "Approved." };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Failed" };
    }
  }, [refresh]);

  const deny = useCallback(async (id: string): Promise<ActionResult> => {
    try {
      const resp = await fetch(`/api/authority/approvals/${encodeURIComponent(id)}/deny`, {
        method: "POST",
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      refresh();
      return { ok: true, message: "Denied." };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Failed" };
    }
  }, [refresh]);

  const updateConfig = useCallback(async (patch: Partial<AuthorityConfig>): Promise<ActionResult> => {
    try {
      const resp = await fetch("/api/authority/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      refresh();
      return { ok: true, message: "Config updated." };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Failed" };
    }
  }, [refresh]);

  const quickOverride = useCallback(
    async (action: ActionCategory, allow: boolean): Promise<ActionResult> => {
      try {
        const resp = await fetch("/api/authority/config/quick-override", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, allow }),
        });
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        refresh();
        return {
          ok: true,
          message: allow
            ? `Granted: ${action.replace(/_/g, " ")}.`
            : `Revoked: ${action.replace(/_/g, " ")}.`,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const acceptSuggestion = useCallback(
    async (action: ActionCategory, tool_name: string): Promise<ActionResult> => {
      try {
        const resp = await fetch("/api/authority/learning/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, tool_name }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: "Suggestion accepted." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const dismissSuggestion = useCallback(
    async (action: ActionCategory, tool_name: string): Promise<ActionResult> => {
      try {
        const resp = await fetch("/api/authority/learning/dismiss", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, tool_name }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: "Suggestion dismissed." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const setEmergency = useCallback(
    async (transition: "pause" | "resume" | "kill" | "reset"): Promise<ActionResult> => {
      try {
        const resp = await fetch(`/api/authority/emergency/${transition}`, {
          method: "POST",
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: `Emergency: ${transition}.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const stats = useMemo(() => {
    const total = pendingApprovals.length + historyApprovals.length;
    const allowed = historyApprovals.filter((a) => a.status === "approved" || a.status === "executed").length;
    const denied = historyApprovals.filter((a) => a.status === "denied").length;
    return {
      pending: pendingApprovals.length,
      allowed,
      denied,
      total,
    };
  }, [pendingApprovals, historyApprovals]);

  return {
    status,
    pendingApprovals,
    historyApprovals,
    auditEntries,
    auditStats,
    config,
    suggestions,
    stats,
    loading,
    error,
    refresh,
    approve,
    deny,
    updateConfig,
    quickOverride,
    acceptSuggestion,
    dismissSuggestion,
    setEmergency,
  };
}
