import { defaultConversationWorkspace } from './conversation-schema';
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { getDb } from './schema';
import { getFact, type Fact } from './facts';
import { isCurrentRecallFact } from './recall-ranking';
import type { BriefMemoryUse, BriefTurnRef } from '../brief/contracts';
import type { MemoryUsageReader } from '../brief/memory-stream-contracts';

export const MEMORY_USE_LIMITS = { days: 90, rows: 50_000, summary: 1000, captures: 32 } as const;
export const memoryDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type MemoryFactRef = { factId: string; sourceRevision: string };
export type MemoryUseTarget =
  | { purpose: 'conversation_context'; turn: BriefTurnRef; runId: null; workflowId: null; callId: string }
  | { purpose: 'workflow_context'; turn: null; runId: string; workflowId: string; callId: string };
export interface MemoryUsageCoverage {
  startedAt: number;
  retainedFrom: number;
  retentionDays: number;
  maxRecords: number;
  paths: readonly ['brief_conversation_recall', 'workflow_ask_recall'];
  meaning: 'retained_provider_handoffs_not_model_reliance';
  completeness: 'recorded_events_only';
}
export interface MemoryUseRecord extends BriefMemoryUse {
  purpose: MemoryUseTarget['purpose'];
  workflowId: string | null;
  callId: string;
}
type Stored = { use_id: string; fact_id: string; source_revision: string; stage: BriefMemoryUse['stage'];
  purpose: MemoryUseTarget['purpose']; conversation_id: string | null; turn_id: string | null; request_id: string | null;
  run_id: string | null; workflow_id: string | null; call_id: string; recorded_at: number };
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\\/\u0000-\u001f\u007f]/.test(v);
export class MemoryUsageError extends Error {}

/** Revision of the canonical assertion/evidence, independent of the changing use ledger. */
export function memoryFactRef(fact: Fact, subjectName: string): MemoryFactRef {
  const { evidence, basis, binding_eligible, ...row } = fact;
  return { factId: fact.id, sourceRevision: memoryDigest([subjectName, row,
    [...evidence].sort((a, b) => a.id.localeCompare(b.id)), basis, binding_eligible]) };
}
const project = (r: Stored): MemoryUseRecord => ({ useId: r.use_id, factId: r.fact_id,
  sourceRevision: r.source_revision, stage: r.stage, purpose: r.purpose, workflowId: r.workflow_id,
  callId: r.call_id, runId: r.run_id, at: r.recorded_at,
  turn: r.conversation_id === null ? null : { conversationId: r.conversation_id, turnId: r.turn_id!, requestId: r.request_id! } });

/** Append-only event stages, except explicit age/row retention. No prompt or fact text is persisted. */
export class MemoryUsageLedger implements MemoryUsageReader {
  private started = false;
  constructor(readonly db: Database, private readonly enabled = () => process.env.JARVIS_BRIEF_MEMORY_USAGE === '1',
    private readonly limits: { days: number; rows: number; summary: number } = MEMORY_USE_LIMITS) {
    for (const key of ['days', 'rows', 'summary'] as const) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > MEMORY_USE_LIMITS[key]) throw new MemoryUsageError('Invalid retention limits');
  }
  start(): void {
    if (!this.enabled() || this.started) return;
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run('INSERT OR IGNORE INTO memory_use_state VALUES (1, ?, ?)', [now, now]);
      this.prune();
    }).immediate();
    this.started = true;
  }
  readiness(): 'ready' | 'unavailable' {
    try {
      return this.enabled() && getDb() === this.db && this.db.query('SELECT singleton FROM memory_use_state WHERE singleton = 1').get()
        ? 'ready' : 'unavailable';
    } catch { return 'unavailable'; }
  }
  private assertReady() {
    if (this.readiness() !== 'ready') throw new MemoryUsageError('Memory provenance unavailable');
  }
  coverage(): MemoryUsageCoverage {
    this.assertReady();
    const row = this.db.query<{ started_at: number; retained_from: number }, []>('SELECT * FROM memory_use_state WHERE singleton = 1').get()!;
    return { startedAt: row.started_at, retainedFrom: Math.max(row.retained_from, this.cutoff()),
      retentionDays: this.limits.days, maxRecords: this.limits.rows,
      paths: ['brief_conversation_recall', 'workflow_ask_recall'], meaning: 'retained_provider_handoffs_not_model_reliance',
      completeness: 'recorded_events_only' };
  }
  private cutoff() { return Date.now() - this.limits.days * 86_400_000; }
  private checkTarget(target: MemoryUseTarget) {
    if (!validId(target.callId)) throw new MemoryUsageError('Invalid memory context');
    if (target.purpose === 'conversation_context') {
      const t = target.turn;
      if (!t || !validId(t.conversationId) || !validId(t.turnId) || !validId(t.requestId) || target.runId !== null || target.workflowId !== null
        || !this.db.query(`SELECT turn_id FROM brief_chat_turns WHERE turn_id = ? AND conversation_id = ? AND request_id = ? AND workspace_id = ? AND state = 'running'`)
          .get(t.turnId, t.conversationId, t.requestId, defaultConversationWorkspace(this.db))) throw new MemoryUsageError('Memory turn is no longer running');
    } else if (target.purpose !== 'workflow_context' || target.turn !== null || !validId(target.runId) || !validId(target.workflowId)
      || !this.db.query("SELECT id FROM flow_run WHERE id = ? AND flow_id = ? AND status = 'RUNNING'").get(target.runId, target.workflowId)) {
      throw new MemoryUsageError('Memory run is no longer running');
    }
  }
  record(target: MemoryUseTarget, refs: readonly MemoryFactRef[], stage: 'selected' | 'supplied'): void {
    this.assertReady();
    if (!['selected', 'supplied'].includes(stage) || refs.length > 54 || refs.some(ref => !validId(ref.factId) || !/^[a-f0-9]{64}$/.test(ref.sourceRevision))) throw new MemoryUsageError('Invalid memory evidence');
    this.db.transaction(() => {
      this.checkTarget(target);
      const now = Date.now();
      for (const ref of refs) {
        if (stage === 'supplied') {
          const fact = getFact(ref.factId), entity = fact && this.db.query<{ name: string }, [string]>('SELECT name FROM entities WHERE id = ?').get(fact.subject_id);
          if (!fact || !entity || !isCurrentRecallFact(fact, now) || memoryFactRef(fact, entity.name).sourceRevision !== ref.sourceRevision) {
            throw new MemoryUsageError('Memory changed before provider handoff; refresh the context');
          }
        }
        const id = memoryDigest([target.purpose, target.turn?.conversationId ?? null, target.turn?.turnId ?? null, target.turn?.requestId ?? null,
          target.runId, target.workflowId, target.callId, ref.factId, ref.sourceRevision, stage]);
        this.db.run(`INSERT OR IGNORE INTO memory_use_events
          (use_id, fact_id, source_revision, stage, purpose, conversation_id, turn_id, request_id, run_id, workflow_id, call_id, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, ref.factId, ref.sourceRevision, stage, target.purpose, target.turn?.conversationId ?? null,
            target.turn?.turnId ?? null, target.turn?.requestId ?? null, target.runId, target.workflowId, target.callId, now]);
      }
      this.prune();
    }).immediate();
  }
  private prune() {
    // Keep a conservative completeness watermark when old rows are removed.
    const expired = this.db.query<{ at: number | null }, [number]>('SELECT MAX(recorded_at) AS at FROM memory_use_events WHERE recorded_at < ?').get(this.cutoff())?.at;
    this.db.run('DELETE FROM memory_use_events WHERE recorded_at < ?', [this.cutoff()]);
    const excess = this.db.query<{ at: number | null }, [number]>(`SELECT MAX(recorded_at) AS at FROM
      (SELECT recorded_at FROM memory_use_events ORDER BY recorded_at DESC, use_id DESC LIMIT -1 OFFSET ?)`).get(this.limits.rows)?.at;
    this.db.run(`DELETE FROM memory_use_events WHERE use_id IN
      (SELECT use_id FROM memory_use_events ORDER BY recorded_at DESC, use_id DESC LIMIT -1 OFFSET ?)`, [this.limits.rows]);
    const removedThrough = Math.max(expired ?? -1, excess ?? -1);
    if (removedThrough >= 0) this.db.run('UPDATE memory_use_state SET retained_from = MAX(retained_from, ?) WHERE singleton = 1', [removedThrough + 1]);
  }
  readUses(factIds: readonly string[]) {
    try {
      this.assertReady();
      if (factIds.length > 10_000 || factIds.some(id => !validId(id))) throw new MemoryUsageError('Invalid facts');
      const ids = new Set(factIds);
      const rows = this.db.query<Stored, [number, number]>(`SELECT * FROM memory_use_events WHERE recorded_at >= ? ORDER BY recorded_at DESC, use_id LIMIT ?`)
        .all(this.cutoff(), this.limits.rows + 1);
      if (rows.length > this.limits.rows) throw new MemoryUsageError('Memory history exceeds capacity');
      return { state: 'ready' as const, uses: rows.filter(r => ids.has(r.fact_id)).map(project), coverage: this.coverage() };
    } catch { return { state: 'unavailable' as const }; }
  }
  readTarget(query: { conversationId?: string; runId?: string }) {
    if (Object.keys(query).some(k => !['conversationId', 'runId'].includes(k)) || (!!query.conversationId === !!query.runId)
      || !validId(query.conversationId ?? query.runId)) throw new MemoryUsageError('Choose one conversation or run');
    try {
      this.assertReady();
      return this.db.transaction(() => {
        const column = query.conversationId ? 'conversation_id' : 'run_id';
        const rows = this.db.query<Stored & { fact_state: string | null }, [string, number, number]>(`SELECT u.*, f.status AS fact_state
          FROM memory_use_events u LEFT JOIN facts f ON f.id = u.fact_id
          WHERE u.${column} = ? AND u.recorded_at >= ? ORDER BY u.recorded_at DESC, u.use_id LIMIT ?`)
          .all((query.conversationId ?? query.runId)!, this.cutoff(), this.limits.summary + 1);
        if (rows.length > this.limits.summary) return { state: 'unavailable' as const, reason: 'capacity_exceeded' };
        return { state: rows.length ? 'ready' as const : 'empty' as const,
          data: { uses: rows.map(r => ({ ...project(r), factState: r.fact_state ?? 'missing' })), coverage: this.coverage() } };
      })();
    } catch { return { state: 'unavailable' as const, reason: 'provider_unavailable' }; }
  }
}
const ledgers = new WeakMap<Database, MemoryUsageLedger>();
export function getMemoryUsageLedger(): MemoryUsageLedger {
  const db = getDb();
  let ledger = ledgers.get(db);
  if (!ledger) { ledger = new MemoryUsageLedger(db); ledgers.set(db, ledger); }
  ledger.start();
  return ledger;
}
