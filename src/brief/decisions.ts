import type { DocumentReviewRow } from '../authority/decision-document-schema';
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { getDb } from '../vault/schema';
import { approvalIntentFromContext, executionState } from '../authority/approval';
import { applyApprovalDecision, applyExecutionResolution, type ApprovalDecisionDeps } from '../daemon/approval-decision';
import { decideWorkItem, getWorkItem } from '../goals/work-items';
import { getFlow } from '../workflows/db/repos/flow';
import { getFlowVersion } from '../workflows/db/repos/flow-version';
import { getFlowRun } from '../workflows/db/repos/flow-run';
import type { EffectStatus } from '../workflows/db/repos/workflow-effect';
import type { BriefReadProviders } from './providers';
import type { BriefWorkflowRef } from './contracts';
import type { DecisionAction, DecisionQuery, DecisionResolution, QueuedDecision } from './decision-contracts';
import { ensureDecisionSchema } from './decision-schema';

export class DecisionError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_request') { super(message); }
}
type Clock = { epoch: string; generation: number };
type Key = { id: string; created: number; position: number };
type Cursor = Clock & { after: Key; runId: string | null };
type Effect = { id: string; run_id: string; approval_id: string | null; status: EffectStatus; created: number; title: string };
const EFFECT_COLUMNS = "id, run_id, approval_id, status, json_extract(record, '$.createdAt') AS created, json_extract(record, '$.toolName') AS title";
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;

const DECISION_CANDIDATES = `
        WITH candidates AS (
          SELECT coalesce(d.decision_id, 'approval:' || a.id) AS id, coalesce(d.created_at, a.created_at) AS created FROM approval_requests a
          LEFT JOIN brief_decision_document d ON d.approval_id = a.id
          WHERE (d.decision_id IS NOT NULL AND d.disposition != 'rejected' AND a.status IN ('pending','expired') OR a.status = 'pending' OR (a.status = 'approved' AND a.execution_outcome IN ('unknown','not_started'))
            OR (a.status = 'executed' AND (a.execution_outcome IS NULL OR a.execution_outcome IN ('failed','blocked','unknown')))
            OR EXISTS (SELECT 1 FROM workflow_effect e WHERE e.approval_id = a.id AND e.status != 'succeeded'))
            AND (?1 IS NULL OR EXISTS (SELECT 1 FROM workflow_effect e WHERE e.approval_id = a.id AND e.run_id = ?1))
          UNION ALL
          SELECT 'work:' || w.work_id, c.created_at FROM commitment_work w JOIN commitments c ON c.id = w.work_id
          LEFT JOIN flow_run r ON r.id = w.run_id
          WHERE (w.decision IS NULL OR (json_extract(w.decision, '$.outcome') = 'accepted' AND w.result_check IS NULL
            AND (r.status IS NULL OR r.status NOT IN ('RUNNING','QUEUED'))))
            AND NOT EXISTS (SELECT 1 FROM workflow_effect e WHERE e.run_id = w.run_id AND e.status != 'succeeded')
            AND (?1 IS NULL OR w.run_id = ?1)
          UNION ALL
          SELECT 'effect:' || e.id, json_extract(e.record, '$.createdAt') FROM workflow_effect e
          WHERE e.status != 'succeeded' AND NOT EXISTS (SELECT 1 FROM approval_requests a WHERE a.id = e.approval_id)
            AND (?1 IS NULL OR e.run_id = ?1)
        ), ordered AS (
          SELECT c.*, coalesce(p.position, 0) AS position FROM candidates c
          LEFT JOIN brief_decision_placement p ON p.decision_id = c.id
        )`;

/** One authenticated daemon/workspace. No client-supplied tenant or execution registry. */
export class DecisionQueue implements NonNullable<BriefReadProviders['decisions']> {
  constructor(private readonly db: Database, private readonly authority: ApprovalDecisionDeps) {
    ensureDecisionSchema(db);
  }
  readiness(): 'ready' | 'unavailable' {
    try { return getDb() === this.db ? 'ready' : 'unavailable'; } catch { return 'unavailable'; }
  }
  private available() {
    if (this.readiness() !== 'ready') throw new DecisionError('Decision queue is unavailable', 503, 'unavailable');
  }
  private clock(): Clock {
    return this.db.query<Clock, []>('SELECT epoch, generation FROM brief_decision_queue_clock WHERE singleton = 1').get()!;
  }
  private parseId(id: string): [string, string] {
    if (!text(id, 300)) throw new DecisionError('Invalid decision ID');
    const match = /^(approval|work|effect):(.+)$/.exec(id);
    if (!match || !text(match[2])) throw new DecisionError('Invalid decision ID');
    return [match[1]!, match[2]!];
  }
  private workflow(flowId: string | null, versionId: string | null): BriefWorkflowRef | null {
    if (!flowId || !versionId) return null;
    const flow = getFlow(flowId), version = getFlowVersion(versionId);
    return flow && version?.flowId === flow.id
      ? { flowId, versionId, activation: flow.status, versionState: version.state } : null;
  }
  private effects(column: 'approval_id' | 'run_id' | 'id', id: string) {
    // Read at most 51 references. Aggregate all statuses so a later unknown
    // receipt cannot be hidden by the reference cap or a successful run upload.
    const counts = this.db.query<{ status: EffectStatus; n: number }, [string]>(
      `SELECT status, count(*) AS n FROM workflow_effect WHERE ${column} = ? GROUP BY status`,
    ).all(id);
    const rows = this.db.query<Effect, [string]>(
      `SELECT ${EFFECT_COLUMNS} FROM workflow_effect WHERE ${column} = ? ORDER BY id LIMIT 51`,
    ).all(id);
    const states = new Set(counts.map(row => row.status));
    const unresolved = ['unknown', 'blocked', 'failed', 'dispatching', 'pending'].find(s => states.has(s as EffectStatus)) as EffectStatus | undefined;
    return { rows: rows.slice(0, 50), truncated: rows.length > 50, unresolved, counts };
  }
  private project(id: string): QueuedDecision {
    let [kind, sourceId] = this.parseId(id);
    let document: DocumentReviewRow | null = null;
    if (kind === 'approval') {
      document = this.db.query<DocumentReviewRow, [string, string, string]>(
        `SELECT * FROM brief_decision_document WHERE decision_id=? OR approval_id=?
          OR decision_id=(SELECT decision_id FROM brief_decision_document_revision WHERE approval_id=?)`).get(id, sourceId, sourceId);
      if (document) { id = document.decision_id; sourceId = document.approval_id; }
    }
    // Effect detail and run detail resolve to the same approval identity as the
    // global queue. A missing approval remains an inspectable effect, never success.
    if (kind === 'effect') {
      const row = this.db.query<Effect, [string]>(`SELECT ${EFFECT_COLUMNS} FROM workflow_effect WHERE id = ?`).get(sourceId);
      if (!row) throw new DecisionError('Decision not found', 404, 'not_found');
      if (row.approval_id && this.authority.approvalManager.getRequest(row.approval_id)) return this.project(`approval:${row.approval_id}`);
    }
    const placement = this.db.query<{ position: number }, [string]>(
      'SELECT position FROM brief_decision_placement WHERE decision_id = ?',
    ).get(id)?.position ?? 0;
    const item: QueuedDecision = {
      decisionId: id, revision: '', kind: 'recovery', title: '', state: 'unknown', refs: [], relatedTruncated: false,
      approval: null, workItemId: null, workStatus: null, workflow: null, run: null,
      actions: ['inspect'], supportedActions: ['inspect'], placement, createdAt: 0,
    };
    let source: unknown;
    let linked: ReturnType<DecisionQueue['effects']>;
    let runId: string | null = null;
    if (kind === 'approval') {
      const approval = this.authority.approvalManager.getRequest(sourceId);
      if (!approval) throw new DecisionError('Decision not found', 404, 'not_found');
      source = approval;
      item.kind = 'permission';
      item.title = (approvalIntentFromContext(approval) ?? approval.reason ?? approval.tool_name).slice(0, 1000);
      item.approval = { approvalId: sourceId, status: approval.status, executionMode: approval.execution_mode,
        executionOutcome: approval.execution_outcome ?? null };
      // A legacy executed row without a receipt is not proof of a committed effect.
      item.state = approval.status === 'executed' && !approval.execution_outcome ? 'unknown' : executionState(approval);
      item.refs.push({ kind: 'approval', id: sourceId });
      item.createdAt = document?.created_at ?? approval.created_at;
      linked = this.effects('approval_id', sourceId);
      runId = linked.rows[0]?.run_id ?? null;
      if (linked.unresolved && linked.unresolved !== 'pending') item.state = linked.unresolved;
      if (approval.status === 'pending' && (!linked.unresolved || linked.unresolved === 'pending')) {
        item.actions = ['approve', 'reject', 'inspect'];
        item.supportedActions = ['approve_permission', 'reject_permission', 'inspect'];
      } else if (approval.execution_mode !== 'workflow' && approval.status === 'approved' &&
        ['unknown', 'not_started'].includes(approval.execution_outcome ?? '') && !linked.rows.length) {
        item.kind = 'recovery';
        item.supportedActions = approval.execution_outcome === 'not_started' && approval.tool_name !== 'request_approval'
          ? ['execute_once', 'close_without_running', 'inspect'] : ['close_without_running', 'inspect'];
      }
    } else if (kind === 'work') {
      if (!this.db.query('SELECT 1 FROM commitment_work WHERE work_id = ?').get(sourceId)) throw new DecisionError('Decision not found', 404, 'not_found');
      const work = getWorkItem(sourceId);
      source = work;
      item.kind = 'intent'; item.title = work.title.slice(0, 1000); item.state = work.status;
      item.workItemId = work.id; item.workStatus = work.status; item.createdAt = work.createdAt;
      item.refs.push({ kind: 'work_item', id: work.id });
      item.workflow = this.workflow(work.workflowId, work.workflowVersionId);
      runId = work.runId;
      linked = this.effects('run_id', runId ?? '');
      if (linked.unresolved) item.state = linked.unresolved;
      if (work.status === 'proposed' && !linked.unresolved) item.supportedActions = ['accept_intent', 'reject_intent', 'inspect'];
    } else {
      linked = this.effects('id', sourceId);
      const effect = linked.rows[0]!;
      source = effect; item.title = effect.title.slice(0, 1000); item.state = effect.status;
      item.createdAt = effect.created; runId = effect.run_id;
    }
    item.refs.push(...linked.rows.map(row => ({ kind: 'effect' as const, id: row.id, runId: row.run_id, status: row.status })));
    item.relatedTruncated = linked.truncated;
    if (runId) {
      const run = getFlowRun(runId);
      const workflow = run ? this.workflow(run.flowId, run.flowVersionId) : null;
      item.workflow ??= workflow;
      item.run = workflow && run ? { ...workflow, runId: run.id, status: run.status } : null;
      if (!item.workItemId) {
        const work = this.db.query<{ work_id: string }, [string]>('SELECT work_id FROM commitment_work WHERE run_id = ?').get(runId);
        if (work) { item.workItemId = work.work_id; item.workStatus = getWorkItem(work.work_id).status;
          item.refs.push({ kind: 'work_item', id: work.work_id }); }
      }
    }
    if (document?.disposition === 'deferred' && !['denied','approved','executed'].includes(item.approval?.status ?? '')) {
      item.state = 'deferred'; item.actions = ['inspect']; item.supportedActions = ['inspect'];
    }
    item.revision = hash({ source, item, effects: linked.counts, ...(document ? { document } : {}) });
    return item;
  }
  get(id: string): QueuedDecision {
    this.available();
    return this.db.transaction(() => this.project(id))();
  }
  async read(query: DecisionQuery = {}) {
    this.available();
    const limit = query.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DecisionError('limit must be an integer from 1 to 100');
    if (query.runId !== undefined && !text(query.runId)) throw new DecisionError('Invalid runId');
    return this.db.transaction(() => {
      const clock = this.clock();
      let cursor: Cursor | undefined;
      if (query.cursor !== undefined) {
        try {
          if (!text(query.cursor, 2048) || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw Error();
          cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
          if (!cursor || !text(cursor.epoch) || !Number.isSafeInteger(cursor.generation) ||
            !text(cursor.after?.id, 300) || !Number.isSafeInteger(cursor.after.created) || !Number.isSafeInteger(cursor.after.position) ||
            cursor.runId !== (query.runId ?? null)) throw Error();
        } catch { throw new DecisionError('Invalid or differently scoped cursor'); }
        if (cursor.epoch !== clock.epoch || cursor.generation !== clock.generation) {
          throw new DecisionError('Queue changed; reload the first page', 409, 'queue_changed');
        }
      }
      // No day boundary. All unresolved sources remain discoverable. A work card
      // waiting on an effect is represented by that effect/approval, not duplicated.
      const keys = this.db.query<Key, (string | number | null)[]>(`
        ${DECISION_CANDIDATES} SELECT * FROM ordered WHERE ?2 IS NULL OR (position, created, id) > (?3, ?4, ?2)
          ORDER BY position, created, id LIMIT ?5
      `).all(query.runId ?? null, cursor?.after.id ?? null, cursor?.after.position ?? 0, cursor?.after.created ?? 0, limit + 1);
      const page = keys.slice(0, limit);
      const nextCursor = keys.length > limit
        ? Buffer.from(JSON.stringify({ ...clock, after: page.at(-1)!, runId: query.runId ?? null } satisfies Cursor)).toString('base64url') : null;
      return { state: 'ready' as const, asOf: Date.now(), data: { items: page.map(key => this.project(key.id)), nextCursor } };
    })();
  }
  /** F-13 links the canonical queue identity; new work goes behind every existing item. */
  recommendWork(workId: string, created: boolean): QueuedDecision {
    this.available();
    return this.db.transaction(() => {
      const key = this.db.query<Key, [null, string]>(`${DECISION_CANDIDATES}
        SELECT * FROM ordered WHERE id = 'work:' || ?2 OR EXISTS (
          SELECT 1 FROM commitment_work w JOIN workflow_effect e ON e.run_id = w.run_id
          WHERE w.work_id = ?2 AND (ordered.id = 'effect:' || e.id OR ordered.id = 'approval:' || e.approval_id
            OR ordered.id = (SELECT decision_id FROM brief_decision_document WHERE approval_id=e.approval_id))
        ) ORDER BY position, created, id LIMIT 1`).get(null, workId);
      if (!key) throw new DecisionError('Work no longer has an unresolved queue item', 409, 'work_not_queued');
      if (created) {
        const tail = this.db.query<{ position: number | null }, [null, string]>(`${DECISION_CANDIDATES}
          SELECT MAX(position) AS position FROM ordered WHERE id != ?2`).get(null, key.id)!;
        const position = tail.position === null ? 0 : tail.position + 1;
        if (!Number.isSafeInteger(position) || position > 1_000_000) throw new DecisionError('Queue placement is full; reorder before adding work', 409, 'placement_full');
        this.db.run('INSERT INTO brief_decision_placement(decision_id,position) VALUES (?,?)', [key.id, position]);
      }
      return this.project(key.id);
    }).immediate();
  }
  place(id: string, revision: string, position: number): QueuedDecision {
    this.available();
    if (!Number.isSafeInteger(position) || Math.abs(position) > 1_000_000) throw new DecisionError('position must be an integer from -1000000 to 1000000');
    return this.db.transaction(() => {
      const item = this.project(id);
      this.match(item, revision);
      this.db.run(`INSERT INTO brief_decision_placement VALUES (?, ?) ON CONFLICT(decision_id) DO UPDATE SET position = excluded.position`, [item.decisionId, position]);
      return this.project(item.decisionId);
    }).immediate();
  }
  private match(item: QueuedDecision, revision: string) {
    if (!text(revision) || item.revision !== revision) throw new DecisionError('Decision changed; read it by ID before acting', 409, 'revision_conflict');
  }
  async resolve(id: string, body: DecisionResolution): Promise<QueuedDecision> {
    this.available();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['revision','action','reason','note'].includes(k))) throw new DecisionError('Invalid resolution');
    const item = this.get(id);
    const validate = () => {
      const current = this.project(item.decisionId);
      this.match(current, body.revision);
      if (body.action === ('inspect' as DecisionAction) || !current.supportedActions.includes(body.action)) throw new DecisionError('Action is not supported for this revision', 409, 'unsupported_action');
    };
    validate();
    const intent = body.action === 'accept_intent' || body.action === 'reject_intent';
    if (intent ? !text(body.reason, 10_000) || body.note !== undefined : body.reason !== undefined) throw new DecisionError('Intent decisions require a reason; permission decisions do not accept one');
    if (body.note !== undefined && (body.action !== 'close_without_running' || !text(body.note, 500))) throw new DecisionError('Only closing accepts a note of at most 500 characters');
    // The existing writers commit approval/claims before dispatch. The optional
    // guard checks this projection in that same write transaction, including
    // changes by legacy surfaces or another process. Never wrap tool execution.
    const authority = { ...this.authority, assertCurrent: validate };
    if (intent) this.db.transaction(() => {
      validate();
      decideWorkItem(item.workItemId!, { outcome: body.action === 'accept_intent' ? 'accepted' : 'rejected', reason: body.reason });
    }).immediate();
    else if (body.action === 'approve_permission' || body.action === 'reject_permission') {
      const result = await applyApprovalDecision(body.action === 'approve_permission' ? 'approve' : 'deny', item.approval!.approvalId, 'dashboard', authority);
      if (result.status === 'already_decided') throw new DecisionError('Decision already changed', 409, 'revision_conflict');
    } else {
      const result = await applyExecutionResolution(body.action === 'execute_once' ? 'execute' : 'close', item.approval!.approvalId, 'dashboard', authority, body.note);
      if (result.status === 'not_unresolved' || result.status === 'not_executable') throw new DecisionError('Execution resolution changed; read it by ID', 409, 'revision_conflict');
    }
    return this.get(item.decisionId);
  }
}
