import { useCallback, useMemo } from "react";

import { readArray, readObject, useRemoteData } from "../../hooks/useRemoteData";

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
  execution_mode?: "inline" | "deferred" | "workflow";
  execution_outcome?: "committed" | "failed" | "blocked" | "not_started" | "unknown" | "closed" | null;
  resolved_at?: number | null;
  resolved_by?: string | null;
  resolution_note?: string | null;
  // enrichment from server
  execution_state?: string;
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
  /** Approved before a restart and never receipted; they need a decision too. */
  unresolved_approvals?: number;
  config?: AuthorityConfig;
}

interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Authority Room data hook — polls 8 endpoints independently + exposes
 * write actions for approve/deny, config mutations, learning accept/
 * dismiss, emergency state changes, and the new quick-override (voice
 * "grant Jarvis email access" path).
 *
 * Designed so failures in any one endpoint don't block the others —
 * the Room renders partial data when, say, learning suggestions fail
 * but config still loads.
 */
export function useAuthorityData() {
  const inbox = useAuthorityInbox();
  const statusData = useRemoteData("/api/authority/status", readStatus, POLL_INTERVAL_MS);
  const historyData = useRemoteData("/api/authority/approvals?limit=20", readArray<ApprovalRequest>, POLL_INTERVAL_MS);
  const auditData = useRemoteData("/api/authority/audit?limit=100", readArray<AuditEntry>, POLL_INTERVAL_MS);
  const auditStatsData = useRemoteData("/api/authority/audit/stats", readAuditStats, POLL_INTERVAL_MS);
  const configData = useRemoteData("/api/authority/config", readConfig, POLL_INTERVAL_MS);
  const suggestionData = useRemoteData("/api/authority/learning/suggestions", readArray<LearningSuggestion>, POLL_INTERVAL_MS);
  const status = statusData.data;
  const pendingApprovals = inbox.pending.data ?? EMPTY_APPROVALS;
  const unresolvedApprovals = inbox.unresolved.data ?? EMPTY_APPROVALS;
  const historyApprovals = historyData.data ?? EMPTY_APPROVALS;
  const auditEntries = auditData.data ?? EMPTY_AUDIT;
  const auditStats = auditStatsData.data;
  const config = configData.data;
  const suggestions = suggestionData.data ?? EMPTY_SUGGESTIONS;
  const sections = { ...inbox, status: statusData, history: historyData, audit: auditData, auditStats: auditStatsData, config: configData, suggestions: suggestionData };
  const loading = Object.values(sections).some(s => s.availability === "loading");
  const error = Object.values(sections).map(s => s.error).filter(Boolean).join(" ") || null;
  const refresh = useCallback(async () => {
    await Promise.all([inbox.pending.refresh(), inbox.unresolved.refresh(), statusData.refresh(), historyData.refresh(), auditData.refresh(), auditStatsData.refresh(), configData.refresh(), suggestionData.refresh()]);
  }, [inbox.pending.refresh, inbox.unresolved.refresh, statusData.refresh, historyData.refresh, auditData.refresh, auditStatsData.refresh, configData.refresh, suggestionData.refresh]);

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

  // Resolutions for approvals a restart left without a receipt. The server
  // refuses to run an interrupted one and says why; surface that reason.
  const resolveUnresolved = useCallback(
    async (id: string, action: "execute" | "close", done: string): Promise<ActionResult> => {
      try {
        const resp = await fetch(`/api/authority/approvals/${encodeURIComponent(id)}/${action}`, {
          method: "POST",
        });
        const body = (await resp.json().catch(() => null)) as { error?: string; result?: string } | null;
        if (!resp.ok) throw new Error(body?.error ?? `HTTP ${resp.status}`);
        refresh();
        // For a row that came from a conversation, this toast is the only
        // place the user will ever see what the tool returned.
        const result = typeof body?.result === "string" && body.result.trim() ? `: ${body.result.slice(0, 120)}` : "";
        return { ok: true, message: `${done}${result}` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );
  const executeUnresolved = useCallback(
    (id: string) => resolveUnresolved(id, "execute", "Ran once"),
    [resolveUnresolved],
  );
  const closeUnresolved = useCallback(
    (id: string) => resolveUnresolved(id, "close", "Closed without running."),
    [resolveUnresolved],
  );

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
      unresolved: unresolvedApprovals.length,
      allowed,
      denied,
      total,
    };
  }, [pendingApprovals, unresolvedApprovals, historyApprovals]);

  return {
    sections,
    status,
    pendingApprovals,
    unresolvedApprovals,
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
    executeUnresolved,
    closeUnresolved,
    updateConfig,
    quickOverride,
    acceptSuggestion,
    dismissSuggestion,
    setEmergency,
  };
}

const EMPTY_APPROVALS: ApprovalRequest[] = [];
const EMPTY_AUDIT: AuditEntry[] = [];
const EMPTY_SUGGESTIONS: LearningSuggestion[] = [];

/** Also used by Now: a connected event stream alone is not an inbox snapshot. */
export function useAuthorityInbox() {
  const pending = useRemoteData("/api/authority/approvals?status=pending", readArray<ApprovalRequest>, POLL_INTERVAL_MS);
  const unresolved = useRemoteData("/api/authority/approvals?status=unresolved", readArray<ApprovalRequest>, POLL_INTERVAL_MS);
  return { pending, unresolved };
}
function readStatus(value: unknown): AuthorityStatus {
  const status = readObject<AuthorityStatus>(value);
  if (!["normal", "paused", "killed"].includes(status.emergency_state)) throw new Error("Unexpected emergency state.");
  return status;
}
function readConfig(value: unknown): AuthorityConfig {
  const config = readObject<AuthorityConfig>(value);
  if (typeof config.default_level !== "number" || !Array.isArray(config.governed_categories) ||
      !Array.isArray(config.overrides) || !Array.isArray(config.context_rules) ||
      typeof config.learning?.enabled !== "boolean" || typeof config.learning?.suggest_threshold !== "number") throw new Error("Unexpected configuration.");
  return config;
}
function readAuditStats(value: unknown): AuditStats {
  const stats = readObject<AuditStats>(value);
  if ([stats.total, stats.allowed, stats.denied, stats.approvalRequired].some(n => typeof n !== "number" || !Number.isFinite(n))) throw new Error("Unexpected audit statistics.");
  readObject(stats.byCategory);
  return stats;
}
