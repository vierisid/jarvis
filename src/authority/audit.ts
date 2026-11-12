/**
 * Audit Trail — Logs every tool execution decision for review.
 */

import { getDb, generateId } from '../vault/schema.ts';
import type { ActionCategory } from '../roles/authority.ts';

export type AuthorityDecisionType = 'allowed' | 'denied' | 'approval_required';

/**
 * The resolution channel for an approval decision. `click` is the
 * dashboard card path; `voice` is the spoken-yes/no path; `chat` a reply in
 * Telegram or Discord; `notification` a desktop toast button; `system` is
 * for automatic decisions (heartbeat-driven cleanup, expired requests, an
 * emergency Kill, etc.). `null` is allowed for backward compatibility with
 * rows written before this column existed.
 */
export type ResolutionChannel = 'click' | 'voice' | 'chat' | 'notification' | 'system';

/**
 * How a side effect ended, written on the row that settles it:
 * `succeeded` ran, `failed` ran and errored, `not_started` was refused or
 * denied before anything ran, `unknown` may have run, and `dispatched` was
 * handed to its provider with the receipt still to come.
 */
export type AuditOutcome = 'succeeded' | 'failed' | 'not_started' | 'unknown' | 'dispatched';

export type AuditEntry = {
  id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  action_category: ActionCategory;
  authority_decision: AuthorityDecisionType;
  approval_id: string | null;
  executed: number; // 0 or 1
  execution_time_ms: number | null;
  created_at: number;
  channel: ResolutionChannel | null;
  effect_id?: string | null;
  outcome?: AuditOutcome | null;
  /** The device or session that decided: `dashboard:<device id>`, or the surface name. */
  decided_by?: string | null;
  entry_key?: string | null;
};

/**
 * One owner-facing entry: every row of one side effect read as one. The ledger
 * itself is append-only (a decision, a dispatch and a receipt are separate
 * rows); this is how it is read.
 */
export type AuditLedgerEntry = AuditEntry & {
  /** Rows written for this entry. */
  events: number;
  /** When the last row was written. */
  updated_at: number;
  /** The name of the enrolled device named in `decided_by`, when it is still enrolled. */
  decided_device?: string | null;
};

/** The most entries or rows one ledger read returns. */
export const AUDIT_PAGE_MAX = 500;

/** A requested page size, clamped to 1..AUDIT_PAGE_MAX (default 100). */
export function auditPageLimit(limit: number | undefined): number {
  const n = Math.floor(Number(limit ?? 100));
  return Number.isFinite(n) && n > 0 ? Math.min(n, AUDIT_PAGE_MAX) : 100;
}

export class AuditTrail {
  /**
   * Log a tool execution decision.
   */
  log(entry: {
    agent_id: string;
    agent_name: string;
    tool_name: string;
    action_category: ActionCategory;
    authority_decision: AuthorityDecisionType;
    approval_id?: string | null;
    executed: boolean;
    execution_time_ms?: number | null;
    /** Resolution channel for forensics. Optional; defaults to null. */
    channel?: ResolutionChannel | null;
    /** The workflow effect this row belongs to. Found from `approval_id` when omitted. */
    effect_id?: string | null;
    /** How the effect ended, on the row that settles it. */
    outcome?: AuditOutcome | null;
    /** The device or session that decided, on a decision row. */
    decided_by?: string | null;
  }): AuditEntry {
    const db = getDb();
    const id = generateId();
    const now = Date.now();
    // A decision row knows its approval, not its effect: the link is found so
    // the decision lands in the same entry as the effect it decided.
    let effectId = entry.effect_id ?? null;
    if (!effectId && entry.approval_id) {
      try {
        effectId = (db.query('SELECT id FROM workflow_effect WHERE approval_id = ?').get(entry.approval_id) as { id: string } | null)?.id ?? null;
      } catch { /* No workflow tables: not a workflow approval. */ }
    }
    const entryKey = effectId ?? entry.approval_id ?? id;

    db.run(
      `INSERT INTO audit_trail (id, agent_id, agent_name, tool_name, action_category, authority_decision, approval_id, executed, execution_time_ms, created_at, channel, effect_id, outcome, decided_by, entry_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.agent_id,
        entry.agent_name,
        entry.tool_name,
        entry.action_category,
        entry.authority_decision,
        entry.approval_id ?? null,
        entry.executed ? 1 : 0,
        entry.execution_time_ms ?? null,
        now,
        entry.channel ?? null,
        effectId,
        entry.outcome ?? null,
        entry.decided_by ?? null,
        entryKey,
      ]
    );

    return {
      id,
      agent_id: entry.agent_id,
      agent_name: entry.agent_name,
      tool_name: entry.tool_name,
      action_category: entry.action_category as ActionCategory,
      authority_decision: entry.authority_decision,
      approval_id: entry.approval_id ?? null,
      executed: entry.executed ? 1 : 0,
      execution_time_ms: entry.execution_time_ms ?? null,
      created_at: now,
      channel: entry.channel ?? null,
      effect_id: effectId,
      outcome: entry.outcome ?? null,
      decided_by: entry.decided_by ?? null,
      entry_key: entryKey,
    };
  }

  /**
   * Query audit rows with filters, one per write. `queryEntries` is the owner's
   * view, one per side effect.
   */
  query(filters?: {
    agentId?: string;
    action?: ActionCategory;
    tool?: string;
    decision?: AuthorityDecisionType;
    since?: number;
    limit?: number;
  }): AuditEntry[] {
    const db = getDb();
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters?.agentId) {
      conditions.push('agent_id = ?');
      values.push(filters.agentId);
    }
    if (filters?.action) {
      conditions.push('action_category = ?');
      values.push(filters.action);
    }
    if (filters?.tool) {
      conditions.push('tool_name = ?');
      values.push(filters.tool);
    }
    if (filters?.decision) {
      conditions.push('authority_decision = ?');
      values.push(filters.decision);
    }
    if (filters?.since) {
      conditions.push('created_at >= ?');
      values.push(filters.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit ?? 100;

    return db.query(
      `SELECT * FROM audit_trail ${where} ORDER BY created_at DESC LIMIT ?`
    ).all(...[...values, limit] as any[]) as AuditEntry[];
  }

  /**
   * The ledger as the owner reads it: one entry per side effect (a workflow
   * effect, or an approval), not one per row written. An entry carries the
   * first row's identity, `authority_decision` `denied` when any row denied,
   * the `outcome` of the last row that settled it, who decided, and how many
   * rows back it. `executed` is 1 only when the outcome is `succeeded`; an
   * entry with no settling row (written before outcomes were recorded) keeps
   * what its rows said.
   */
  queryEntries(filters?: {
    agentId?: string;
    action?: ActionCategory;
    tool?: string;
    decision?: AuthorityDecisionType;
    since?: number;
    limit?: number;
  }): AuditLedgerEntry[] {
    const db = getDb();
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filters?.agentId) { conditions.push('f.agent_id = ?'); values.push(filters.agentId); }
    if (filters?.action) { conditions.push('f.action_category = ?'); values.push(filters.action); }
    if (filters?.tool) { conditions.push('f.tool_name = ?'); values.push(filters.tool); }
    if (filters?.since) { conditions.push('f.created_at >= ?'); values.push(filters.since); }
    const anyDenied = `EXISTS (SELECT 1 FROM audit_trail d WHERE d.entry_key = f.entry_key AND d.authority_decision = 'denied')`;
    if (filters?.decision === 'denied') conditions.push(`(f.authority_decision = 'denied' OR ${anyDenied})`);
    else if (filters?.decision) { conditions.push(`f.authority_decision = ? AND NOT ${anyDenied}`); values.push(filters.decision); }
    const limit = auditPageLimit(filters?.limit);
    // Bounded: the page is the newest entries' FIRST rows (no earlier row with
    // the same key), read newest first by `idx_audit_created` and stopping at
    // `limit`; each entry's own rows are then read through `idx_audit_entry`.
    // Nothing groups the whole table. Every row has an `entry_key` (written on
    // insert, back-filled by the schema migration).
    const latest = (column: string) => `(SELECT l.${column} FROM audit_trail l WHERE l.entry_key = f.entry_key AND l.${column} IS NOT NULL
            ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1)`;
    const rows = db.query(
      `WITH page AS (
         SELECT f.rowid AS first_rowid FROM audit_trail f
         WHERE NOT EXISTS (SELECT 1 FROM audit_trail e WHERE e.entry_key = f.entry_key AND e.rowid < f.rowid)
           ${conditions.map((c) => `AND ${c}`).join(' ')}
         ORDER BY f.created_at DESC, f.rowid DESC LIMIT ?)
       SELECT f.*,
         (SELECT COUNT(*) FROM audit_trail n WHERE n.entry_key = f.entry_key) AS events,
         (SELECT MAX(m.created_at) FROM audit_trail m WHERE m.entry_key = f.entry_key) AS last_at,
         ${anyDenied} AS any_denied,
         EXISTS (SELECT 1 FROM audit_trail x WHERE x.entry_key = f.entry_key AND x.executed = 1) AS any_executed,
         ${latest('outcome')} AS final_outcome,
         ${latest('decided_by')} AS final_decided_by,
         ${latest('channel')} AS final_channel,
         ${latest('execution_time_ms')} AS final_time
       FROM page JOIN audit_trail f ON f.rowid = page.first_rowid
       ORDER BY f.created_at DESC, f.rowid DESC`,
    ).all(...[...values, limit] as any[]) as Array<AuditEntry & {
      events: number; last_at: number | null; any_denied: number; any_executed: number;
      final_outcome: AuditOutcome | null; final_decided_by: string | null; final_channel: ResolutionChannel | null; final_time: number | null;
    }>;
    return rows.map(({ events, last_at, any_denied, any_executed, final_outcome, final_decided_by, final_channel, final_time, ...row }) => {
      const outcome = final_outcome ?? row.outcome ?? null;
      const decidedBy = final_decided_by ?? row.decided_by ?? null;
      return {
        ...row,
        authority_decision: any_denied || row.authority_decision === 'denied' ? 'denied' as const : row.authority_decision,
        executed: outcome ? (outcome === 'succeeded' ? 1 : 0) : any_executed ? 1 : 0,
        outcome,
        decided_by: decidedBy,
        decided_device: this.deviceName(decidedBy),
        channel: final_channel ?? row.channel ?? null,
        execution_time_ms: final_time ?? row.execution_time_ms ?? null,
        // A row with no key (written outside `log`) is an entry of its own.
        events: events || 1,
        updated_at: last_at ?? row.created_at,
      };
    });
  }

  /** The name of the enrolled device in `dashboard:<device id>`, or null. */
  private deviceName(decidedBy: string | null): string | null {
    const id = decidedBy?.startsWith('dashboard:') ? decidedBy.slice('dashboard:'.length) : null;
    if (!id) return null;
    try {
      return (getDb().query('SELECT name FROM sidecars WHERE id = ?').get(id) as { name: string } | null)?.name ?? null;
    } catch { return null; }
  }

  /**
   * Aggregate statistics over entries, not rows: one approved notification is
   * one, however many rows it wrote. Counted by the entry's own decision
   * (`denied` when any row denied) and by how it ended.
   */
  getStats(since?: number): {
    total: number;
    allowed: number;
    denied: number;
    approvalRequired: number;
    byCategory: Record<string, number>;
    byOutcome: Record<string, number>;
  } {
    const db = getDb();
    const having = since ? `HAVING MIN(created_at) >= ${Math.floor(Number(since))}` : '';
    // The bare columns come from the row `MIN(rowid)` picks: the entry's first row.
    const groups = db.query(
      `SELECT MIN(rowid) AS first_rowid, authority_decision, action_category,
         MAX(authority_decision = 'denied') AS any_denied, MAX(executed) AS any_executed,
         (SELECT o.outcome FROM audit_trail o WHERE o.entry_key = COALESCE(a.entry_key, a.id) AND o.outcome IS NOT NULL
            ORDER BY o.created_at DESC, o.rowid DESC LIMIT 1) AS final_outcome
       FROM audit_trail a GROUP BY COALESCE(entry_key, id) ${having}`,
    ).all() as { authority_decision: string; action_category: string; any_denied: number; any_executed: number; final_outcome: string | null }[];

    const stats = {
      total: 0,
      allowed: 0,
      denied: 0,
      approvalRequired: 0,
      byCategory: {} as Record<string, number>,
      byOutcome: {} as Record<string, number>,
    };
    for (const group of groups) {
      stats.total += 1;
      const decision = group.any_denied ? 'denied' : group.authority_decision;
      if (decision === 'allowed') stats.allowed += 1;
      if (decision === 'denied') stats.denied += 1;
      if (decision === 'approval_required') stats.approvalRequired += 1;
      stats.byCategory[group.action_category] = (stats.byCategory[group.action_category] ?? 0) + 1;
      // No settling row: a denial ran nothing; anything else is not known from
      // the ledger (a pre-execution `executed` flag is not a result), so it is
      // counted as `unrecorded`, never as `succeeded`.
      const outcome = group.final_outcome ?? (group.any_denied ? 'not_started' : 'unrecorded');
      stats.byOutcome[outcome] = (stats.byOutcome[outcome] ?? 0) + 1;
    }
    return stats;
  }
}
