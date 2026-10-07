import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { getDb } from '../vault/schema';
import { createWorkItem, decideWorkItem, getWorkItem } from '../goals/work-items';
import { getGoal } from '../vault/goals';
import type { DecisionQueue } from './decisions';
import type { RecommendationPlan, RecommendationPlanner, RecommendationReceipt, StoredRecommendation } from './recommendation-contracts';
import { checkedRecommendationPlan } from './recommendation-planner';
import { ensureRecommendationSchema } from './recommendation-schema';

export class RecommendationError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_request') { super(message); }
}
type Row = { id: string; request_id: string; plan: string; created_at: number;
  disposition: 'open' | 'accepted' | 'dismissed'; accept_request_id: string | null; acceptance: string | null };
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const choice = ({ generatedAt: _generated, expiresAt: _expires, basis: _basis, ...decision }: RecommendationPlan) => hash(decision);
const idText = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 512;

export class Recommendations {
  constructor(private readonly db: Database, private readonly queue: DecisionQueue,
    private readonly planner: RecommendationPlanner | null, private readonly now = Date.now) {
    ensureRecommendationSchema(db);
  }
  readiness(): 'ready' | 'unavailable' {
    try { return getDb() === this.db && this.queue.readiness() === 'ready' && this.planner?.readiness() === 'ready' ? 'ready' : 'unavailable'; }
    catch { return 'unavailable'; }
  }
  private available() {
    if (this.readiness() !== 'ready') throw new RecommendationError('Recommendation planner or decision queue is unavailable', 503, 'unavailable');
  }
  private plan(now: number): RecommendationPlan {
    try { return checkedRecommendationPlan(this.planner!.plan(now), now); }
    catch { throw new RecommendationError('Recommendation planning is unavailable', 503, 'unavailable'); }
  }
  private row(id: string): Row {
    if (!idText(id)) throw new RecommendationError('Invalid recommendation ID');
    const row = this.db.query<Row, [string]>('SELECT * FROM brief_recommendation WHERE id = ?').get(id);
    if (!row) throw new RecommendationError('Recommendation not found', 404, 'not_found');
    return row;
  }
  private project(row: Row, now: number): StoredRecommendation {
    const plan = JSON.parse(row.plan) as RecommendationPlan;
    let state: StoredRecommendation['state'] = row.disposition === 'open' ? 'available' : row.disposition;
    let reason: string | null = null;
    if (row.disposition === 'open') {
      if (plan.expiresAt <= now) { state = 'expired'; reason = 'This recommendation expired. Request a fresh next step.'; }
      else {
        const fresh = this.plan(now);
        if (fresh.basis !== plan.basis || choice(fresh) !== choice(plan)) { state = 'blocked'; reason = 'Your goal, work or available capabilities changed. Request a fresh next step.'; }
        else if (plan.outcome === 'ask') { state = 'ask'; reason = plan.question; }
        else if (plan.outcome === 'none') { state = 'none'; reason = plan.reason; }
      }
    }
    const acceptance = row.acceptance ? JSON.parse(row.acceptance) as RecommendationReceipt : null;
    return { recommendationId: row.id, requestId: row.request_id, plan, state, reason, acceptance,
      revision: hash({ id: row.id, plan, disposition: row.disposition, acceptance, state }) };
  }
  get(id: string): StoredRecommendation {
    this.available();
    return this.db.transaction(() => this.project(this.row(id), this.now()))();
  }
  /** Return/reopen is a read, not regeneration. Explicit generation gets a new request ID. */
  read(requestId?: string): StoredRecommendation | null {
    this.available();
    if (requestId !== undefined && !idText(requestId)) throw new RecommendationError('Invalid request ID');
    return this.db.transaction(() => {
      const row = requestId === undefined
        ? this.db.query<Row, []>('SELECT * FROM brief_recommendation ORDER BY rowid DESC LIMIT 1').get()
        : this.db.query<Row, [string]>('SELECT * FROM brief_recommendation WHERE request_id = ?').get(requestId);
      return row ? this.project(row, this.now()) : null;
    })();
  }
  generate(requestId: string): StoredRecommendation {
    this.available();
    if (!idText(requestId)) throw new RecommendationError('Supply a request ID');
    return this.db.transaction(() => {
      const existing = this.db.query<Row, [string]>('SELECT * FROM brief_recommendation WHERE request_id = ?').get(requestId);
      const now = this.now();
      if (existing) return this.project(existing, now);
      const plan = this.plan(now), id = crypto.randomUUID();
      this.db.run('INSERT INTO brief_recommendation(id,request_id,plan,created_at) VALUES (?,?,?,?)', [id, requestId, JSON.stringify(plan), now]);
      return this.project(this.row(id), now);
    }).immediate();
  }
  dismiss(id: string, revision: string): StoredRecommendation {
    this.available();
    return this.db.transaction(() => {
      const row = this.row(id), now = this.now(), current = this.project(row, now);
      if (!idText(revision) || current.revision !== revision) throw new RecommendationError('Recommendation changed; read it again', 409, 'revision_conflict');
      if (row.disposition === 'accepted') throw new RecommendationError('Accepted work cannot be dismissed as a recommendation', 409, 'already_accepted');
      this.db.run("UPDATE brief_recommendation SET disposition = 'dismissed' WHERE id = ?", [id]);
      return this.project(this.row(id), now);
    }).immediate();
  }
  accept(id: string, requestId: string, revision: string): RecommendationReceipt {
    this.available();
    if (!idText(requestId) || !idText(revision)) throw new RecommendationError('Supply requestId and revision');
    return this.db.transaction(() => {
      const row = this.row(id), now = this.now(), current = this.project(row, now);
      const owner = this.db.query<{ id: string }, [string]>('SELECT id FROM brief_recommendation WHERE accept_request_id = ?').get(requestId);
      if (owner && owner.id !== id) throw new RecommendationError('Request ID belongs to another recommendation', 409, 'request_conflict');
      if (current.acceptance) {
        if (revision !== current.acceptance.revision && revision !== current.revision) throw new RecommendationError('Recommendation changed; read it again', 409, 'revision_conflict');
        return { ...current.acceptance, requestId };
      }
      if (current.revision !== revision) throw new RecommendationError('Recommendation changed; read it again', 409, 'revision_conflict');
      if (current.state !== 'available' || current.plan.outcome !== 'recommend') throw new RecommendationError(current.reason ?? 'Recommendation is not available', 409, 'not_available');
      const action = current.plan.action;
      // Q-18's basis, re-observed under this write lock, is the concurrency check.
      // Goal read revisions are context, not a replacement for that basis.
      if (action.goal && !getGoal(action.goal.goalId)) throw new RecommendationError('Goal no longer exists', 409, 'not_available');
      let workId = action.workItemId;
      const created = workId === null;
      if (workId) {
        const work = getWorkItem(workId);
        // Deleting a goal retains the work's historical goalId. Q-18 projects
        // that missing goal as null; compare the same live context without rewriting history.
        const liveGoalId = work.goalId && getGoal(work.goalId) ? work.goalId : null;
        if (liveGoalId !== (action.goal?.goalId ?? null)) throw new RecommendationError('Work no longer belongs to this goal', 409, 'not_available');
      } else {
        const work = createWorkItem({ title: action.title, goalId: action.goal?.goalId ?? null, mode: 'manual' });
        decideWorkItem(work.id, { outcome: 'accepted', reason: 'Accepted this next-step recommendation' });
        workId = work.id;
      }
      const decision = this.queue.recommendWork(workId, created);
      const receipt: RecommendationReceipt = { receiptId: crypto.randomUUID(), recommendationId: id, requestId, revision, acceptedAt: now,
        destination: { decisionId: decision.decisionId, workItemId: workId, title: decision.title }, created };
      this.db.run("UPDATE brief_recommendation SET disposition = 'accepted', accept_request_id = ?, acceptance = ? WHERE id = ?",
        [requestId, JSON.stringify(receipt), id]);
      return receipt;
    }).immediate();
  }
}
