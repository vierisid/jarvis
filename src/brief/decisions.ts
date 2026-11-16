import type { DocumentReviewRow } from '../authority/decision-document-schema';
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { getDb } from '../vault/schema';
import { approvalIntentFromContext, DASHBOARD_DECIDER, executionState } from '../authority/approval';
import { applyApprovalDecision, applyExecutionResolution, heldApprovalMessage, type ApprovalDecisionDeps } from '../daemon/approval-decision';
import { checkWorkResult, decideWorkItem, getWorkItem, NEEDS_YOU_DONE_REF, NEEDS_YOU_NOT_DOING_REF, WorkItemError } from '../goals/work-items';
import { DEFAULT_IDS } from '../workflows/db/index';
import { getFlowInProject } from '../workflows/db/repos/flow';
import { getFlowVersion } from '../workflows/db/repos/flow-version';
import { getFlowRunInProject } from '../workflows/db/repos/flow-run';
import { getWorkflowEffect, type EffectStatus } from '../workflows/db/repos/workflow-effect';
import type { BriefReadProviders } from './providers';
import type { BriefWorkflowRef } from './contracts';
import type { DecisionAction, DecisionQuery, DecisionResolution, QueuedDecision } from './decision-contracts';
import { ensureDecisionSchema } from './decision-schema';
import { HELD_RUN_EFFECT } from '../workflows/runtime/deferred-cards';
import { WORKFLOW_REVIEWED_UI_TOOLS } from '../authority/ui-intent';
import { approvalHeldByAwareness, AWARENESS_HELD_APPROVAL_MESSAGE } from '../authority/approval-provenance';

export class DecisionError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_request') { super(message); }
}
type Clock = { epoch: string; generation: number };
type Key = { id: string; created: number; position: number };
type Cursor = Clock & { after: Key; runId: string | null };
type Effect = { id: string; run_id: string; approval_id: string | null; status: EffectStatus; created: number; title: string };
const EFFECT_COLUMNS = "e.id, e.run_id, e.approval_id, e.status, json_extract(e.record, '$.createdAt') AS created, json_extract(e.record, '$.toolName') AS title";
/** Effects of runs whose flow is in the queue's project (#729, #841); `?1` is that project. */
const SCOPED_EFFECTS = 'workflow_effect e JOIN flow_run sr ON sr.id = e.run_id JOIN flow sf ON sf.id = sr.flow_id AND sf.project_id = ?1';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;

/**
 * An effect whose permission the user denied. It is settled: it closes its
 * approval card and must not keep an accepted commitment's work card hidden.
 */
const DENIED_EFFECT = `(e.status = 'blocked' AND json_extract(e.record, '$.decision') = 'denied'
  AND EXISTS (SELECT 1 FROM approval_requests da WHERE da.id = e.approval_id AND da.status = 'denied'))`;
/**
 * A step that waited for a place behind its flow's card budget and was stopped
 * with its run (Kill, turn-off, cancel) before it ever raised a card: the run
 * stop records it `not_started`. Nothing happened and there is nothing to
 * decide, as #1364 rules for a run stopped before any step ran, so it is not
 * queued and does not keep an accepted commitment's work card hidden. Without
 * this a Kill would turn one held group back into one raw row per run.
 */
const NEVER_ASKED_EFFECT = `(e.status = 'blocked' AND e.approval_id IS NULL
  AND json_extract(e.record, '$.deferral.budget') IS NOT NULL
  AND json_extract(e.record, '$.outcome.effect') = 'not_started'
  AND json_extract(e.record, '$.outcome.code') IN ('WORKFLOW_CANCELED','WORKFLOW_FINISHED'))`;
/**
 * Every unresolved queue source, in sort-key order. Binds `?1` (run filter or
 * null) and `?6` (the queue's project); effects outside that project never appear.
 */
const DECISION_CANDIDATES = `
        WITH candidates AS (
          SELECT coalesce(d.decision_id, 'approval:' || a.id) AS id, coalesce(d.created_at, a.created_at) AS created FROM approval_requests a
          LEFT JOIN brief_decision_document d ON d.approval_id = a.id
          WHERE (d.decision_id IS NOT NULL AND d.disposition != 'rejected' AND a.status IN ('pending','expired') OR a.status = 'pending' OR (a.status = 'approved' AND a.execution_outcome IN ('unknown','not_started'))
            OR (a.status = 'executed' AND (a.execution_outcome IS NULL OR a.execution_outcome IN ('failed','blocked','unknown')))
            OR EXISTS (SELECT 1 FROM workflow_effect e WHERE e.approval_id = a.id AND e.status != 'succeeded' AND NOT ${DENIED_EFFECT}))
            AND (?1 IS NULL OR EXISTS (SELECT 1 FROM workflow_effect e JOIN flow_run sr ON sr.id = e.run_id
              JOIN flow sf ON sf.id = sr.flow_id AND sf.project_id = ?6 WHERE e.approval_id = a.id AND e.run_id = ?1))
          UNION ALL
          SELECT 'work:' || w.work_id, c.created_at FROM commitment_work w JOIN commitments c ON c.id = w.work_id
          LEFT JOIN flow_run r ON r.id = w.run_id
          WHERE (w.decision IS NULL OR (json_extract(w.decision, '$.outcome') = 'accepted' AND w.result_check IS NULL
            AND (r.status IS NULL OR r.status NOT IN ('RUNNING','QUEUED'))))
            AND NOT EXISTS (SELECT 1 FROM workflow_effect e WHERE e.run_id = w.run_id AND e.status != 'succeeded' AND NOT ${DENIED_EFFECT}
              AND NOT ${NEVER_ASKED_EFFECT})
            AND (?1 IS NULL OR w.run_id = ?1)
          UNION ALL
          SELECT 'effect:' || e.id, json_extract(e.record, '$.createdAt') FROM workflow_effect e
          JOIN flow_run sr ON sr.id = e.run_id JOIN flow sf ON sf.id = sr.flow_id AND sf.project_id = ?6
          WHERE e.status != 'succeeded' AND NOT EXISTS (SELECT 1 FROM approval_requests a WHERE a.id = e.approval_id)
            AND NOT (${HELD_RUN_EFFECT}) AND NOT ${NEVER_ASKED_EFFECT}
            AND (?1 IS NULL OR e.run_id = ?1)
          UNION ALL
          -- Sorted first (created 0), not by its oldest run: that age moves as
          -- runs are released, and a sort key that moves without a generation
          -- bump would repeat the entry across pages. The UI shows it apart.
          SELECT 'held:' || sr.flow_id, 0 FROM workflow_effect e
          JOIN flow_run sr ON sr.id = e.run_id JOIN flow sf ON sf.id = sr.flow_id AND sf.project_id = ?6
          WHERE ${HELD_RUN_EFFECT} AND (?1 IS NULL OR e.run_id = ?1)
          GROUP BY sr.flow_id
        ), ordered AS (
          SELECT c.*, coalesce(p.position, 0) AS position FROM candidates c
          LEFT JOIN brief_decision_placement p ON p.decision_id = c.id
        )`;

/** One authenticated daemon/workspace. No client-supplied tenant or execution registry. */
export class DecisionQueue implements NonNullable<BriefReadProviders['decisions']> {
  constructor(private readonly db: Database, private readonly authority: ApprovalDecisionDeps, private readonly projectId: string = DEFAULT_IDS.project) {
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
    const match = /^(approval|work|effect|held):(.+)$/.exec(id);
    if (!match || !text(match[2])) throw new DecisionError('Invalid decision ID');
    return [match[1]!, match[2]!];
  }
  private workflow(flowId: string | null, versionId: string | null): BriefWorkflowRef | null {
    if (!flowId || !versionId) return null;
    const flow = getFlowInProject(this.projectId, flowId), version = getFlowVersion(versionId);
    return flow && version?.flowId === flow.id
      ? { flowId, versionId, activation: flow.status, versionState: version.state } : null;
  }
  private effects(column: 'approval_id' | 'run_id' | 'id', id: string) {
    // Read at most 51 references. Aggregate all statuses so a later unknown
    // receipt cannot be hidden by the reference cap or a successful run upload.
    const counts = this.db.query<{ status: EffectStatus; n: number }, [string, string]>(
      `SELECT e.status, count(*) AS n FROM ${SCOPED_EFFECTS} WHERE e.${column} = ?2 GROUP BY e.status`,
    ).all(this.projectId, id);
    const rows = this.db.query<Effect, [string, string]>(
      `SELECT ${EFFECT_COLUMNS} FROM ${SCOPED_EFFECTS} WHERE e.${column} = ?2 ORDER BY e.id LIMIT 51`,
    ).all(this.projectId, id);
    const states = new Set(counts.map(row => row.status));
    const unresolved = ['unknown', 'blocked', 'failed', 'dispatching', 'pending'].find(s => states.has(s as EffectStatus)) as EffectStatus | undefined;
    return { rows: rows.slice(0, 50), truncated: rows.length > 50, unresolved, counts };
  }
  /**
   * The runs of one workflow held behind its approval-card limit (#1039): one
   * entry per workflow, never one per run. Nothing to decide, so inspect only.
   */
  private projectHeld(id: string, flowId: string): QueuedDecision {
    const rows = this.db.query<{ n: number; created: number; run_id: string }, [string, string]>(
      `SELECT count(DISTINCT e.run_id) AS n, min(json_extract(e.record, '$.createdAt')) AS created, min(e.run_id) AS run_id
        FROM workflow_effect e JOIN flow_run sr ON sr.id = e.run_id JOIN flow sf ON sf.id = sr.flow_id AND sf.project_id = ?1
        WHERE sr.flow_id = ?2 AND ${HELD_RUN_EFFECT}`).get(this.projectId, flowId);
    if (!rows || !rows.n) throw new DecisionError('Decision not found', 404, 'not_found');
    const run = getFlowRunInProject(this.projectId, rows.run_id);
    const workflow = run ? this.workflow(run.flowId, run.flowVersionId) : null;
    const workflowName = (run && getFlowVersion(run.flowVersionId)?.displayName) || 'this workflow';
    const placement = this.db.query<{ position: number }, [string]>(
      'SELECT position FROM brief_decision_placement WHERE decision_id = ?').get(id)?.position ?? 0;
    const item: QueuedDecision = {
      decisionId: id, revision: '', kind: 'held', state: 'pending',
      title: `${rows.n} more ${rows.n === 1 ? 'run' : 'runs'} of ${workflowName} ${rows.n === 1 ? 'is' : 'are'} waiting. Answer a request above to let the next one ask.`,
      refs: [], relatedTruncated: false, approval: null, workItemId: null, workStatus: null, workflow, run: null,
      actions: ['inspect'], supportedActions: ['inspect'], placement, createdAt: rows.created ?? 0,
      held: { workflowName, count: rows.n },
    };
    item.revision = hash({ item });
    return item;
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
      const row = this.db.query<Effect, [string, string]>(`SELECT ${EFFECT_COLUMNS} FROM ${SCOPED_EFFECTS} WHERE e.id = ?2`).get(this.projectId, sourceId);
      if (!row) throw new DecisionError('Decision not found', 404, 'not_found');
      if (row.approval_id && this.authority.approvalManager.getRequest(row.approval_id)) return this.project(`approval:${row.approval_id}`);
    }
    if (kind === 'held') return this.projectHeld(id, sourceId);
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
      item.review = { toolName: approval.tool_name, reason: approval.reason };
      if (approval.tool_name.startsWith('browser_')) {
        try {
          const args = JSON.parse(approval.tool_arguments);
          if (typeof args.target === 'string') item.review.target = args.target.slice(0, 160);
          if (typeof args.url === 'string') { const url = new URL(args.url); if (['http:', 'https:'].includes(url.protocol)) item.review.origin = url.origin; }
        } catch { /* Details remain available from the permission reason. */ }
        // What the call acts on as its card was raised (the page a click or
        // scroll lands on, the element a click names). Display only.
        try {
          const subject = (JSON.parse(approval.context ?? '') as { reviewSubject?: { origin?: unknown; element?: unknown } }).reviewSubject;
          if (!item.review.origin && typeof subject?.origin === 'string' && /^https?:\/\//.test(subject.origin)) item.review.origin = subject.origin.slice(0, 160);
          if (typeof subject?.element === 'string' && subject.element.trim()) item.review.element = subject.element.slice(0, 160);
        } catch { /* An approval raised without a subject shows its tool and reason. */ }
      }
      // A reviewed browser or desktop workflow card (#1314): the card the
      // effect boundary wrote, shown whole. Display only, bounded at source.
      try {
        // Only the effect boundary writes one: a workflow card for a reviewed UI tool (#1314 review).
        const card = approval.execution_mode === 'workflow' && approval.agent_id.startsWith('workflow:') && WORKFLOW_REVIEWED_UI_TOOLS.has(approval.tool_name)
          ? (JSON.parse(approval.context ?? '') as { uiCard?: Record<string, unknown> }).uiCard : undefined;
        if (card && typeof card.computer === 'string' && Array.isArray(card.values) && card.values.length <= 20) {
          item.review.computer = card.computer.slice(0, 160);
          if (typeof card.page === 'string' && /^https?:\/\//.test(card.page)) item.review.origin = card.page.slice(0, 160);
          if (typeof card.element === 'string') item.review.element = card.element.slice(0, 200);
          if (typeof card.window === 'string') item.review.window = card.window.slice(0, 200);
          item.review.values = card.values.filter((v): v is { name: string; value: string; source: 'workflow' | 'run_data' | 'agent' } =>
            !!v && typeof v.name === 'string' && typeof v.value === 'string' && ['workflow', 'run_data', 'agent'].includes(v.source))
            .map(v => ({ name: v.name.slice(0, 64), value: v.value, source: v.source }));
        }
      } catch { /* A card raised before #1314 shows its tool and reason. */ }
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
        // The Brief is the dashboard: a click-only card (Q-08) is approvable
        // here too, decided as DASHBOARD_DECIDER through the same executor path.
        item.actions = ['approve', 'reject', 'inspect'];
        item.supportedActions = ['approve_permission', 'reject_permission', 'inspect'];
        // Raised from the screen, with screen awareness off: approving waits
        // and says so; rejecting still works (#1314 follow-up).
        if (approvalHeldByAwareness(approval)) item.awarenessHeld = AWARENESS_HELD_APPROVAL_MESSAGE;
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
      // An accepted step the founder does themselves ends in their own word: done, or not doing it.
      // Workflow work finishes through its run, so it is not offered here.
      else if (work.status === 'ready' && work.mode === 'manual' && !linked.unresolved) item.supportedActions = ['mark_done', 'not_doing', 'inspect'];
    } else {
      linked = this.effects('id', sourceId);
      const effect = linked.rows[0]!;
      source = effect; item.title = effect.title.slice(0, 1000); item.state = effect.status;
      item.createdAt = effect.created; runId = effect.run_id;
    }
    item.refs.push(...linked.rows.map(row => ({ kind: 'effect' as const, id: row.id, runId: row.run_id, status: row.status })));
    item.relatedTruncated = linked.truncated;
    if (runId) {
      const run = getFlowRunInProject(this.projectId, runId);
      const workflow = run ? this.workflow(run.flowId, run.flowVersionId) : null;
      item.workflow ??= workflow;
      item.run = workflow && run ? { ...workflow, runId: run.id, status: run.status } : null;
      if (item.review && run) {
        item.review.workflowName = getFlowVersion(run.flowVersionId)?.displayName;
        item.review.requestedAt = run.startTime ?? run.created;
        // Project only reviewed notification fields from its immutable effect, never generic tool arguments.
        // `title` is the effect's toolName, so only notification rows load their full record.
        const frozen = linked.rows.filter(row => row.title === 'workflow_notify').map(row => getWorkflowEffect(row.id)).find(effect => effect?.route === 'notify' && effect.toolName === 'workflow_notify');
        if (frozen && typeof frozen.arguments.message === 'string' && Array.isArray(frozen.arguments.channels)) {
          item.review.message = frozen.arguments.message.slice(0, 20_000);
          item.review.channels = frozen.arguments.channels.filter((channel): channel is string => typeof channel === 'string').slice(0, 20);
          // Q-19: the frozen desktop fallback is part of what the user reviews.
          if (frozen.arguments.fallback === 'desktop') item.review.fallback = 'desktop';
          item.title = `Send notification: ${frozen.arguments.message.slice(0, 120)}`;
        }
      }
      if (!item.workItemId) {
        const work = this.db.query<{ work_id: string }, [string]>('SELECT work_id FROM commitment_work WHERE run_id = ?').get(runId);
        if (work) { item.workItemId = work.work_id; item.workStatus = getWorkItem(work.work_id).status;
          item.refs.push({ kind: 'work_item', id: work.work_id }); }
      }
    }
    // A kept draft reads deferred only while its effect is still pending: run
    // cancellation blocks the effect without denying the expired approval (#1094).
    const kept = document && linked.rows.find(row => row.id === document!.effect_id);
    if (document?.disposition === 'deferred' && (!kept || kept.status === 'pending')
      && !['denied','approved','executed'].includes(item.approval?.status ?? '')) {
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
      `).all(query.runId ?? null, cursor?.after.id ?? null, cursor?.after.position ?? 0, cursor?.after.created ?? 0, limit + 1, this.projectId);
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
      const key = this.db.query<Key, [null, string, null, null, null, string]>(`${DECISION_CANDIDATES}
        SELECT * FROM ordered WHERE id = 'work:' || ?2 OR EXISTS (
          SELECT 1 FROM commitment_work w JOIN workflow_effect e ON e.run_id = w.run_id JOIN flow_run sr ON sr.id = e.run_id
          WHERE w.work_id = ?2 AND (ordered.id = 'effect:' || e.id OR ordered.id = 'approval:' || e.approval_id
            OR ordered.id = (SELECT decision_id FROM brief_decision_document WHERE approval_id=e.approval_id)
            -- A run held behind its flow's card limit is represented by its flow's held group.
            OR (ordered.id = 'held:' || sr.flow_id AND ${HELD_RUN_EFFECT}))
        ) ORDER BY position, created, id LIMIT 1`).get(null, workId, null, null, null, this.projectId);
      if (!key) throw new DecisionError('Work no longer has an unresolved queue item', 409, 'work_not_queued');
      if (created) {
        const tail = this.db.query<{ position: number | null }, [null, string, null, null, null, string]>(`${DECISION_CANDIDATES}
          SELECT MAX(position) AS position FROM ordered WHERE id != ?2`).get(null, key.id, null, null, null, this.projectId)!;
        const position = tail.position === null ? 0 : tail.position + 1;
        if (!Number.isSafeInteger(position) || position > 1_000_000) throw new DecisionError('Queue placement is full; reorder before adding work', 409, 'placement_full');
        this.db.run('INSERT INTO brief_decision_placement(decision_id,position) VALUES (?,?) ON CONFLICT(decision_id) DO UPDATE SET position = excluded.position', [key.id, position]);
        // A placement write changes a sort key, so open keyset cursors must reload (see place()).
        this.db.run('UPDATE brief_decision_queue_clock SET generation = generation + 1 WHERE singleton = 1');
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
      // A position is the only part of a decision's sort key that ever changes,
      // so it is the only write that can make a keyset cursor skip or repeat one.
      this.db.run('UPDATE brief_decision_queue_clock SET generation = generation + 1 WHERE singleton = 1');
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
    const finish = body.action === 'mark_done' || body.action === 'not_doing';
    const intent = body.action === 'accept_intent' || body.action === 'reject_intent' || finish;
    if (intent ? !text(body.reason, 10_000) || body.note !== undefined : body.reason !== undefined) throw new DecisionError('Intent decisions require a reason; permission decisions do not accept one');
    if (body.note !== undefined && (body.action !== 'close_without_running' || !text(body.note, 500))) throw new DecisionError('Only closing accepts a note of at most 500 characters');
    // The existing writers commit approval/claims before dispatch. The optional
    // guard checks this projection in that same write transaction, including
    // changes by legacy surfaces or another process. Never wrap tool execution.
    const authority = { ...this.authority, assertCurrent: validate };
    if (intent) {
      try {
        this.db.transaction(() => {
          validate();
          if (finish) {
            // The user's own words are the evidence of an explicit result check. Doing it
            // is a passed check; not doing it is a failed one, which never counts as saved time.
            // Its ref keeps a choice not to do it apart from a failed attempt (next-action).
            const done = body.action === 'mark_done';
            checkWorkResult(item.workItemId!, { verdict: done ? 'passed' : 'failed', summary: body.reason,
              evidence: [{ ref: done ? NEEDS_YOU_DONE_REF : NEEDS_YOU_NOT_DOING_REF, description: body.reason! }] });
          } else decideWorkItem(item.workItemId!, { outcome: body.action === 'accept_intent' ? 'accepted' : 'rejected', reason: body.reason });
        }).immediate();
      } catch (e) {
        // A refusal from the work item (such as a reason with no visible text) is the caller's to fix, not an unknown outcome.
        if (e instanceof WorkItemError) throw new DecisionError(e.message, e.status, e.status === 409 ? 'revision_conflict' : 'invalid_request');
        throw e;
      }
    } else if (body.action === 'approve_permission' || body.action === 'reject_permission') {
      const result = await applyApprovalDecision(body.action === 'approve_permission' ? 'approve' : 'deny', item.approval!.approvalId, DASHBOARD_DECIDER, authority);
      if (result.status === 'already_decided') throw new DecisionError('Decision already changed', 409, 'revision_conflict');
      // Pause holds and Kill stops (Q-08): the card stays pending and says why.
      if (result.status === 'held') throw new DecisionError(heldApprovalMessage(result.state), 409, 'held');
      if (result.status === 'needs_dashboard') throw new DecisionError('Approve this on its dashboard approval card', 409, 'needs_dashboard');
    } else {
      const result = await applyExecutionResolution(body.action === 'execute_once' ? 'execute' : 'close', item.approval!.approvalId, DASHBOARD_DECIDER, authority, body.note);
      if (result.status === 'not_unresolved') throw new DecisionError('Execution resolution changed; read it by ID', 409, 'revision_conflict');
      if (result.status === 'not_executable') throw new DecisionError(result.reason, 409, 'not_executable');
    }
    return this.get(item.decisionId);
  }
}
