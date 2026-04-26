import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Check,
  GraduationCap,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { Chip, Icon } from "../../ui";
import { RoomShell } from "../RoomShell";
import { useRoomActions } from "../useRoomActionBus";
import { useRovingTabs } from "../useRovingTabs";
import {
  ACTION_CATEGORIES,
  useAuthorityData,
  type ActionCategory,
  type AuditEntry,
  type AuthorityDecisionType,
  type ContextRule,
  type EmergencyState,
  type LearningSuggestion,
  type PerActionOverride,
} from "./useAuthorityData";
import "./AuthorityRoom.css";

type TabId = "approvals" | "audit" | "grants" | "learning";

const TAB_LABEL: Record<TabId, string> = {
  approvals: "Approvals",
  audit: "Audit",
  grants: "Grants",
  learning: "Learning",
};

const TAB_ICON: Record<TabId, LucideIcon> = {
  approvals: ShieldAlert,
  audit: BarChart3,
  grants: ShieldCheck,
  learning: GraduationCap,
};

type AuditFilter = "all" | AuthorityDecisionType;

const AUDIT_FILTER_LABEL: Record<AuditFilter, string> = {
  all: "All",
  allowed: "Allowed",
  denied: "Denied",
  approval_required: "Approval req.",
};

export type RoomBodyMode = "inline" | "expanded";

export function AuthorityRoomBody({ mode }: { mode: RoomBodyMode }) {
  const data = useAuthorityData();
  const [activeTab, setActiveTab] = useState<TabId>("approvals");
  const TAB_KEYS = useMemo(() => Object.keys(TAB_LABEL) as TabId[], []);
  const tabsApi = useRovingTabs<TabId>(TAB_KEYS, activeTab, setActiveTab, "v2-auth");
  const [auditFilter, setAuditFilter] = useState<AuditFilter>("all");
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const filteredAudit = useMemo(() => {
    if (auditFilter === "all") return data.auditEntries;
    return data.auditEntries.filter((e) => e.authority_decision === auditFilter);
  }, [data.auditEntries, auditFilter]);

  // Phase 6.3.5 — voice room actions for Authority. Emergency commands
  // are intentionally excluded (per the safety constraint locked in
  // Phase 6.6 plan): pause/kill/reset only via the buttons.
  useRoomActions("authority", (action, args) => {
    switch (action) {
      case "switch_tab": {
        const t = String(args.tab);
        if (t === "approvals" || t === "audit" || t === "grants" || t === "learning") {
          setActiveTab(t);
          return true;
        }
        return false;
      }
      case "set_filter": {
        const f = String(args.decision);
        if (f === "all" || f === "allowed" || f === "denied" || f === "approval_required") {
          setAuditFilter(f);
          setActiveTab("audit");
          return true;
        }
        return false;
      }
      case "grant_access":
      case "revoke_access": {
        const cat = String(args.action) as ActionCategory;
        if (!ACTION_CATEGORIES.includes(cat)) return false;
        const allow = action === "grant_access";
        (async () => {
          const r = await data.quickOverride(cat, allow);
          setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
        })();
        return true;
      }
      default:
        return false;
    }
  });

  return (
    <div className={`v2-auth v2-auth--${mode}`}>
      {/* Always-visible Emergency band */}
      <EmergencyBand
        state={data.status?.emergency_state ?? "normal"}
        onTransition={async (t) => {
          const r = await data.setEmergency(t);
          setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
        }}
      />

      {/* Stats strip */}
      <div className="v2-auth__stats">
        <StatCard label="Pending" value={data.stats.pending} sub="awaiting decision" tone={data.stats.pending > 0 ? "accent" : "neutral"} />
        <StatCard label="Default level" value={data.config?.default_level ?? "—"} sub="1-10 authority floor" />
        <StatCard label="Allowed (recent)" value={data.stats.allowed} sub={`of ${data.stats.total}`} />
        <StatCard label="Denied (recent)" value={data.stats.denied} sub="last 20 decisions" />
      </div>

      {/* Tabs */}
      {mode === "expanded" && (
        <div
          className="v2-auth__tabs"
          role="tablist"
          aria-label="Authority view"
          ref={tabsApi.tablistRef}
        >
          {TAB_KEYS.map((t) => (
            <button
              key={t}
              type="button"
              className="v2-auth__tab"
              data-active={activeTab === t}
              {...tabsApi.getTabProps(t)}
            >
              <Icon icon={TAB_ICON[t]} size="sm" />
              <span>{TAB_LABEL[t]}</span>
              {t === "approvals" && data.stats.pending > 0 && (
                <span className="v2-auth__tab-badge" data-tone="accent">
                  {data.stats.pending}
                </span>
              )}
              {t === "learning" && data.suggestions.length > 0 && (
                <span className="v2-auth__tab-badge">{data.suggestions.length}</span>
              )}
            </button>
          ))}
          <button
            type="button"
            className="v2-auth__refresh"
            onClick={data.refresh}
            aria-label="Refresh"
            title="Refresh"
          >
            <Icon icon={RefreshCw} size="sm" />
          </button>
        </div>
      )}

      {data.error && <div className="v2-auth__error">{data.error}</div>}

      {/* Content */}
      {(mode === "inline" || activeTab === "approvals") && (
        <ApprovalsTab
          pending={data.pendingApprovals}
          history={data.historyApprovals}
          loading={data.loading}
          onApprove={async (id) => {
            const r = await data.approve(id);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
          onDeny={async (id) => {
            const r = await data.deny(id);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
        />
      )}
      {mode === "expanded" && activeTab === "audit" && (
        <AuditTab
          entries={filteredAudit}
          totalCount={data.auditEntries.length}
          stats={data.auditStats}
          filter={auditFilter}
          onFilterChange={setAuditFilter}
        />
      )}
      {mode === "expanded" && activeTab === "grants" && data.config && (
        <GrantsTab
          config={data.config}
          onUpdate={async (patch) => {
            const r = await data.updateConfig(patch);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
          onQuickOverride={async (action, allow) => {
            const r = await data.quickOverride(action, allow);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
        />
      )}
      {mode === "expanded" && activeTab === "learning" && data.config && (
        <LearningTab
          enabled={data.config.learning.enabled}
          threshold={data.config.learning.suggest_threshold}
          suggestions={data.suggestions}
          onUpdate={async (patch) => {
            const r = await data.updateConfig({
              learning: { ...data.config!.learning, ...patch },
            });
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
          onAccept={async (action, tool_name) => {
            const r = await data.acceptSuggestion(action, tool_name);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
          onDismiss={async (action, tool_name) => {
            const r = await data.dismissSuggestion(action, tool_name);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
        />
      )}

      {toast && (
        <div role="status" aria-live="polite" className="v2-auth__toast" data-tone={toast.tone}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

export function AuthorityRoom() {
  return (
    <RoomShell
      title="Authority"
      subtitle="approvals · audit · grants · learning"
      breadcrumb={["Authority"]}
    >
      <AuthorityRoomBody mode="expanded" />
    </RoomShell>
  );
}

/* ─────────── Emergency band ─────────── */

function EmergencyBand({
  state,
  onTransition,
}: {
  state: EmergencyState;
  onTransition: (t: "pause" | "resume" | "kill" | "reset") => void;
}) {
  return (
    <div className="v2-auth__emergency" data-state={state}>
      <div className="v2-auth__emergency-meta">
        <span className="v2-auth__emergency-dot" aria-hidden="true" />
        <span className="v2-auth__emergency-label">
          Emergency · {state === "normal" ? "all systems normal" : state === "paused" ? "execution paused" : "killed"}
        </span>
      </div>
      <div className="v2-auth__emergency-actions">
        {state === "normal" && (
          <>
            <button
              type="button"
              className="v2-auth__emergency-btn"
              onClick={() => onTransition("pause")}
            >
              <Icon icon={Pause} size="sm" />
              Pause
            </button>
            <button
              type="button"
              className="v2-auth__emergency-btn v2-auth__emergency-btn--danger"
              onClick={() => onTransition("kill")}
            >
              <Icon icon={Square} size="sm" />
              Kill
            </button>
          </>
        )}
        {state === "paused" && (
          <>
            <button
              type="button"
              className="v2-auth__emergency-btn"
              onClick={() => onTransition("resume")}
            >
              <Icon icon={Play} size="sm" />
              Resume
            </button>
            <button
              type="button"
              className="v2-auth__emergency-btn v2-auth__emergency-btn--danger"
              onClick={() => onTransition("kill")}
            >
              <Icon icon={Square} size="sm" />
              Kill
            </button>
          </>
        )}
        {state === "killed" && (
          <button
            type="button"
            className="v2-auth__emergency-btn"
            onClick={() => onTransition("reset")}
          >
            <Icon icon={RotateCcw} size="sm" />
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

/* ─────────── Stat card ─────────── */

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number | string;
  sub: string;
  tone?: "neutral" | "accent" | "warn";
}) {
  return (
    <div className="v2-auth__stat" data-tone={tone ?? "neutral"}>
      <div className="v2-auth__stat-label">{label}</div>
      <div className="v2-auth__stat-value">{value}</div>
      <div className="v2-auth__stat-sub">{sub}</div>
    </div>
  );
}

/* ─────────── Approvals tab ─────────── */

function ApprovalsTab({
  pending,
  history,
  loading,
  onApprove,
  onDeny,
}: {
  pending: ReturnType<typeof useAuthorityData>["pendingApprovals"];
  history: ReturnType<typeof useAuthorityData>["historyApprovals"];
  loading: boolean;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const recentDecisions = history.filter((a) => a.status !== "pending").slice(0, 20);

  return (
    <div className="v2-auth__approvals">
      <section className="v2-auth__section">
        <div className="v2-auth__section-head">
          <h3 className="v2-auth__section-title">Pending</h3>
          <span className="v2-auth__section-count">{pending.length}</span>
        </div>
        {loading && pending.length === 0 ? (
          <div className="v2-auth__empty">Loading…</div>
        ) : pending.length === 0 ? (
          <div className="v2-auth__empty">No pending approvals.</div>
        ) : (
          <ul className="v2-auth__pending-list">
            {pending.map((a) => (
              <li key={a.id}>
                <PendingApprovalCard approval={a} onApprove={onApprove} onDeny={onDeny} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="v2-auth__section">
        <div className="v2-auth__section-head">
          <h3 className="v2-auth__section-title">Recent decisions</h3>
          <span className="v2-auth__section-count">{recentDecisions.length}</span>
        </div>
        {recentDecisions.length === 0 ? (
          <div className="v2-auth__empty">No recent decisions.</div>
        ) : (
          <ul className="v2-auth__history-list">
            {recentDecisions.map((a) => (
              <li key={a.id} className="v2-auth__history-row">
                <span className="v2-auth__history-time">{formatTime(a.created_at)}</span>
                <span className="v2-auth__history-agent">{a.agent_name}</span>
                <span className="v2-auth__history-tool">{a.tool_name}</span>
                <Chip
                  tone={a.status === "approved" || a.status === "executed" ? "ok" : a.status === "denied" ? "accent" : "neutral"}
                  dot
                >
                  {a.status}
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PendingApprovalCard({
  approval,
  onApprove,
  onDeny,
}: {
  approval: ReturnType<typeof useAuthorityData>["pendingApprovals"][number];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const tone =
    approval.impact === "destructive"
      ? "accent"
      : approval.impact === "external"
        ? "warn"
        : "neutral";
  return (
    <article className="v2-auth__pending" data-urgency={approval.urgency} data-tone={tone}>
      <header className="v2-auth__pending-head">
        <div className="v2-auth__pending-meta">
          <Chip tone={tone === "accent" ? "accent" : tone === "warn" ? "warn" : "neutral"} dot>
            {approval.impact ?? "write"}
          </Chip>
          {approval.urgency === "urgent" && (
            <span className="v2-auth__pending-urgent">URGENT</span>
          )}
          <span className="v2-auth__pending-time">{formatTime(approval.created_at)}</span>
        </div>
        <span className="v2-auth__pending-agent">{approval.agent_name}</span>
      </header>
      <div className="v2-auth__pending-intent">{approval.intent ?? approval.reason}</div>
      <div className="v2-auth__pending-meta-row">
        <span className="v2-auth__pending-tool">{approval.tool_name}</span>
        <span className="v2-auth__pending-cat">{approval.action_category}</span>
      </div>
      <div className="v2-auth__pending-actions">
        <button
          type="button"
          className="v2-auth__btn v2-auth__btn--secondary"
          onClick={() => onDeny(approval.id)}
        >
          <Icon icon={X} size="sm" />
          Deny
        </button>
        <button
          type="button"
          className="v2-auth__btn v2-auth__btn--primary"
          onClick={() => onApprove(approval.id)}
        >
          <Icon icon={Check} size="sm" />
          Approve
        </button>
      </div>
    </article>
  );
}

/* ─────────── Audit tab ─────────── */

function AuditTab({
  entries,
  totalCount,
  stats,
  filter,
  onFilterChange,
}: {
  entries: AuditEntry[];
  totalCount: number;
  stats: ReturnType<typeof useAuthorityData>["auditStats"];
  filter: AuditFilter;
  onFilterChange: (f: AuditFilter) => void;
}) {
  return (
    <div className="v2-auth__audit">
      {stats && (
        <div className="v2-auth__audit-stats">
          <StatCard label="Total" value={stats.total} sub="all decisions" />
          <StatCard label="Allowed" value={stats.allowed} sub="auto-approved" />
          <StatCard label="Denied" value={stats.denied} sub="rejected" tone={stats.denied > 0 ? "warn" : "neutral"} />
          <StatCard label="Required approval" value={stats.approvalRequired} sub="user-decided" />
        </div>
      )}

      <div className="v2-auth__filter-row" role="tablist" aria-label="Filter audit entries">
        {(Object.keys(AUDIT_FILTER_LABEL) as AuditFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            className="v2-auth__filter-btn"
            data-active={filter === f}
            onClick={() => onFilterChange(f)}
          >
            {AUDIT_FILTER_LABEL[f]}
          </button>
        ))}
        <span className="v2-auth__filter-meta">
          {entries.length} of {totalCount}
        </span>
      </div>

      {entries.length === 0 ? (
        <div className="v2-auth__empty">No audit entries match the current filter.</div>
      ) : (
        <ul className="v2-auth__audit-list">
          {entries.map((e) => (
            <li key={e.id} className="v2-auth__audit-row" data-decision={e.authority_decision}>
              <span className="v2-auth__audit-time">{formatTime(e.created_at)}</span>
              <Chip
                tone={
                  e.authority_decision === "allowed"
                    ? "ok"
                    : e.authority_decision === "denied"
                      ? "accent"
                      : "warn"
                }
                dot
              >
                {e.authority_decision.replace("_", " ")}
              </Chip>
              <span className="v2-auth__audit-agent">{e.agent_name}</span>
              <span className="v2-auth__audit-tool">{e.tool_name}</span>
              <span className="v2-auth__audit-cat">{e.action_category}</span>
              {e.execution_time_ms != null && (
                <span className="v2-auth__audit-ms">{e.execution_time_ms}ms</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─────────── Grants tab ─────────── */

function GrantsTab({
  config,
  onUpdate,
  onQuickOverride,
}: {
  config: ReturnType<typeof useAuthorityData>["config"];
  onUpdate: (patch: Partial<NonNullable<ReturnType<typeof useAuthorityData>["config"]>>) => void;
  onQuickOverride: (action: ActionCategory, allow: boolean) => void;
}) {
  if (!config) return <div className="v2-auth__empty">Loading config…</div>;

  return (
    <div className="v2-auth__grants">
      {/* Default authority level */}
      <section className="v2-auth__section">
        <div className="v2-auth__section-head">
          <h3 className="v2-auth__section-title">Default authority level</h3>
          <span className="v2-auth__section-count">{config.default_level} / 10</span>
        </div>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={config.default_level}
          onChange={(e) => onUpdate({ default_level: parseInt(e.target.value, 10) })}
          className="v2-auth__slider"
          data-zone={levelZone(config.default_level)}
          aria-label="Default authority level"
        />
        <div className="v2-auth__slider-scale">
          <span>1 cautious</span>
          <span>5 balanced</span>
          <span>10 trusted</span>
        </div>
      </section>

      {/* Governed categories */}
      <section className="v2-auth__section">
        <div className="v2-auth__section-head">
          <h3 className="v2-auth__section-title">Governed categories</h3>
          <span className="v2-auth__section-count">{config.governed_categories.length}</span>
        </div>
        <p className="v2-auth__section-desc">
          These categories always require approval, regardless of authority level.
        </p>
        <div className="v2-auth__chip-row">
          {ACTION_CATEGORIES.map((cat) => {
            const active = config.governed_categories.includes(cat);
            return (
              <button
                key={cat}
                type="button"
                className="v2-auth__chip"
                data-active={active}
                onClick={() => {
                  const next = active
                    ? config.governed_categories.filter((c) => c !== cat)
                    : [...config.governed_categories, cat];
                  onUpdate({ governed_categories: next });
                }}
              >
                {cat.replace(/_/g, " ")}
              </button>
            );
          })}
        </div>
      </section>

      {/* Per-action overrides */}
      <section className="v2-auth__section">
        <div className="v2-auth__section-head">
          <h3 className="v2-auth__section-title">Overrides</h3>
          <span className="v2-auth__section-count">{config.overrides.length}</span>
        </div>
        <p className="v2-auth__section-desc">
          Explicit allow/deny rules per action. Role-scoped overrides take precedence over global ones.
        </p>
        <OverrideTable
          overrides={config.overrides}
          onRemove={(idx) => {
            const next = config.overrides.filter((_, i) => i !== idx);
            onUpdate({ overrides: next });
          }}
          onQuickOverride={onQuickOverride}
        />
      </section>

      {/* Context rules */}
      <section className="v2-auth__section">
        <div className="v2-auth__section-head">
          <h3 className="v2-auth__section-title">Context rules</h3>
          <span className="v2-auth__section-count">{config.context_rules.length}</span>
        </div>
        <p className="v2-auth__section-desc">
          Conditional rules — fire when conditions match (time of day, specific tool, always).
        </p>
        <ContextRuleTable
          rules={config.context_rules}
          onRemove={(id) => {
            const next = config.context_rules.filter((r) => r.id !== id);
            onUpdate({ context_rules: next });
          }}
        />
      </section>
    </div>
  );
}

function OverrideTable({
  overrides,
  onRemove,
  onQuickOverride,
}: {
  overrides: PerActionOverride[];
  onRemove: (idx: number) => void;
  onQuickOverride: (action: ActionCategory, allow: boolean) => void;
}) {
  const [pickAction, setPickAction] = useState<ActionCategory>("send_email");

  return (
    <div>
      {overrides.length === 0 ? (
        <div className="v2-auth__empty-line">No overrides yet.</div>
      ) : (
        <table className="v2-auth__table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Role</th>
              <th>Effect</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {overrides.map((o, idx) => (
              <tr key={`${o.action}-${o.role_id ?? "global"}-${idx}`}>
                <td>{o.action.replace(/_/g, " ")}</td>
                <td>{o.role_id ?? <em>global</em>}</td>
                <td>
                  <Chip
                    tone={
                      !o.allowed
                        ? "accent"
                        : o.requires_approval
                          ? "warn"
                          : "ok"
                    }
                    dot
                  >
                    {!o.allowed ? "deny" : o.requires_approval ? "require approval" : "allow"}
                  </Chip>
                </td>
                <td>
                  <button
                    type="button"
                    className="v2-auth__icon-btn"
                    aria-label="Remove override"
                    onClick={() => onRemove(idx)}
                  >
                    <Icon icon={Trash2} size="sm" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="v2-auth__add-row">
        <select
          className="v2-auth__select"
          value={pickAction}
          onChange={(e) => setPickAction(e.target.value as ActionCategory)}
        >
          {ACTION_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="v2-auth__btn v2-auth__btn--secondary"
          onClick={() => onQuickOverride(pickAction, false)}
        >
          Deny
        </button>
        <button
          type="button"
          className="v2-auth__btn v2-auth__btn--primary"
          onClick={() => onQuickOverride(pickAction, true)}
        >
          Allow
        </button>
      </div>
    </div>
  );
}

function ContextRuleTable({
  rules,
  onRemove,
}: {
  rules: ContextRule[];
  onRemove: (id: string) => void;
}) {
  if (rules.length === 0) {
    return <div className="v2-auth__empty-line">No context rules yet.</div>;
  }
  return (
    <table className="v2-auth__table">
      <thead>
        <tr>
          <th>Action</th>
          <th>Condition</th>
          <th>Effect</th>
          <th>Description</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rules.map((r) => (
          <tr key={r.id}>
            <td>{r.action.replace(/_/g, " ")}</td>
            <td>{r.condition.replace(/_/g, " ")}</td>
            <td>
              <Chip
                tone={r.effect === "deny" ? "accent" : r.effect === "require_approval" ? "warn" : "ok"}
                dot
              >
                {r.effect.replace(/_/g, " ")}
              </Chip>
            </td>
            <td>{r.description}</td>
            <td>
              <button
                type="button"
                className="v2-auth__icon-btn"
                aria-label="Remove rule"
                onClick={() => onRemove(r.id)}
              >
                <Icon icon={Trash2} size="sm" />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ─────────── Learning tab ─────────── */

function LearningTab({
  enabled,
  threshold,
  suggestions,
  onUpdate,
  onAccept,
  onDismiss,
}: {
  enabled: boolean;
  threshold: number;
  suggestions: LearningSuggestion[];
  onUpdate: (patch: { enabled?: boolean; suggest_threshold?: number }) => void;
  onAccept: (action: ActionCategory, tool_name: string) => void;
  onDismiss: (action: ActionCategory, tool_name: string) => void;
}) {
  return (
    <div className="v2-auth__learning">
      <section className="v2-auth__section">
        <div className="v2-auth__section-head">
          <h3 className="v2-auth__section-title">Learning</h3>
          <button
            type="button"
            className="v2-auth__chip"
            data-active={enabled}
            onClick={() => onUpdate({ enabled: !enabled })}
          >
            {enabled ? "Enabled" : "Disabled"}
          </button>
        </div>
        <p className="v2-auth__section-desc">
          Suggests auto-approve overrides when you've approved the same action repeatedly.
        </p>

        <div className="v2-auth__threshold-row">
          <label className="v2-auth__label">
            Suggest after {threshold} consecutive approvals
          </label>
          <input
            type="range"
            min={1}
            max={50}
            step={1}
            value={threshold}
            onChange={(e) => onUpdate({ suggest_threshold: parseInt(e.target.value, 10) })}
            className="v2-auth__slider"
            disabled={!enabled}
            aria-label="Suggestion threshold"
          />
        </div>
      </section>

      <section className="v2-auth__section">
        <div className="v2-auth__section-head">
          <h3 className="v2-auth__section-title">Suggestions</h3>
          <span className="v2-auth__section-count">{suggestions.length}</span>
        </div>
        {suggestions.length === 0 ? (
          <div className="v2-auth__empty">No suggestions yet — keep approving and we'll surface patterns.</div>
        ) : (
          <ul className="v2-auth__suggestions">
            {suggestions.map((s) => (
              <li key={`${s.actionCategory}-${s.toolName}`} className="v2-auth__suggestion">
                <div className="v2-auth__suggestion-meta">
                  <Chip tone="ok" dot>{s.consecutiveApprovals}× approved</Chip>
                  <span className="v2-auth__suggestion-tool">{s.toolName}</span>
                </div>
                <div className="v2-auth__suggestion-text">
                  Auto-allow <strong>{s.actionCategory.replace(/_/g, " ")}</strong> when called via <code>{s.toolName}</code>?
                </div>
                <div className="v2-auth__suggestion-actions">
                  <button
                    type="button"
                    className="v2-auth__btn v2-auth__btn--secondary"
                    onClick={() => onDismiss(s.actionCategory, s.toolName)}
                  >
                    Dismiss
                  </button>
                  <button
                    type="button"
                    className="v2-auth__btn v2-auth__btn--primary"
                    onClick={() => onAccept(s.actionCategory, s.toolName)}
                  >
                    Accept
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ─────────── helpers ─────────── */

function formatTime(ts: number): string {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function levelZone(level: number): "ok" | "neutral" | "warn" | "accent" {
  if (level <= 3) return "ok";
  if (level <= 6) return "neutral";
  if (level <= 8) return "warn";
  return "accent";
}

// silence unused-import lints
void AlertTriangle;
