import type { Database } from 'bun:sqlite';
import { getDb } from '../vault/schema.ts';
import * as vault from '../vault/goals.ts';
import type { Goal, GoalStatus, GoalHealth, GoalUpdate, EscalationStage } from './types.ts';
import type { GoalEvent } from './events.ts';
import { GoalEventDelivery, queueGoalEvent } from './event-delivery.ts';
import { calculateGoalHealth } from './health.ts';
import { validateProposal, planProposal } from './proposal.ts';
import { enumeration, invalid, number, record, keys, text, validateGoalFields, GOAL_LEVELS } from './validation.ts';
import { validateReviewScores, saveGoalReviewRecord, type GoalReviewBundle } from './review-evidence.ts';

const terminal = (status: GoalStatus) => ['completed', 'failed', 'killed'].includes(status);
const applications = new WeakMap<Database, GoalApplicationService>();
/** Shared by API, tools, proposal confirmation, awareness and rhythms for this vault connection. */
export function getGoalApplication(): GoalApplicationService {
  const db = getDb();
  let application = applications.get(db);
  if (!application) { application = new GoalApplicationService(db); applications.set(db, application); }
  return application;
}

export class GoalApplicationService {
  private readonly delivery: GoalEventDelivery;
  constructor(private readonly db: Database) { this.delivery = new GoalEventDelivery(db); }
  setEventCallback(callback: (event: GoalEvent) => void): void { this.delivery.setCallback(callback); }
  startDelivery(): void { this.delivery.start(); }
  stopDelivery(): void { this.delivery.stop(); }
  flushEvents(retryFailed = true): void {
    try { this.delivery.flush(retryFailed); }
    catch { console.warn('[Goals] Delivery unavailable; committed events remain pending.'); }
  }
  /** Nested callers persist events but only the outermost successful boundary delivers them. */
  transaction<T>(operation: () => T): T {
    if (getDb() !== this.db) throw new Error('Goal application belongs to a closed vault connection');
    const outer = this.db.inTransaction;
    const result = this.db.transaction(operation).immediate();
    if (!outer) this.flushEvents(false);
    return result;
  }
  recordEvent(event: GoalEvent, completion?: Goal): void {
    this.transaction(() => queueGoalEvent(event, completion));
  }
  createGoal(title: unknown, level: unknown, options?: Parameters<typeof vault.createGoal>[2]): Goal {
    return this.transaction(() => {
      const goal = vault.createGoal(text(title, 'goal.title'), enumeration(level, GOAL_LEVELS, 'goal.level'), options);
      queueGoalEvent({ type: 'goal_created', goalId: goal.id, data: { title, level, parent_id: goal.parent_id }, timestamp: goal.created_at }, terminal(goal.status) ? goal : undefined);
      return goal;
    });
  }
  createFromProposal(input: unknown, parentId?: string): Goal[] {
    const proposal = validateProposal(input);
    if (parentId !== undefined) text(parentId, 'parent_id', true, 512);
    return this.transaction(() => {
      const id = parentId ?? proposal.parent_id;
      const parent = id === undefined ? null : vault.getGoal(id);
      if (id !== undefined && !parent) invalid('parent_id', 'goal does not exist');
      const plan = planProposal(proposal, parent, Date.now());
      const created: Goal[] = [];
      for (const node of plan) {
        const parent_id = node.parentIndex === null ? parent?.id : created[node.parentIndex]!.id;
        created.push(this.createGoal(node.title, node.level, { ...node.options, parent_id }));
      }
      return created;
    });
  }
  updateGoal(id: string, updates: GoalUpdate): Goal | null {
    text(id, 'goal_id');
    const checked = validateGoalFields(updates, 'update') as GoalUpdate;
    return this.transaction(() => {
      const before = vault.getGoal(id);
      if (!before) return null;
      const changed = Object.fromEntries(Object.entries(checked).filter(([key, value]) => value !== undefined && JSON.stringify(value) !== JSON.stringify(before[key as keyof Goal])));
      if (!Object.keys(changed).length) return before;
      const goal = vault.updateGoal(id, checked)!;
      queueGoalEvent({ type: 'goal_updated', goalId: id, data: { updates: changed }, timestamp: goal.updated_at });
      return checked.deadline === undefined ? goal : this.refreshHealth(goal);
    });
  }
  scoreGoal(id: string, score: number, reason = '', source = 'user'): Goal | null {
    return this.recordScore(id, score, reason, source)?.goal ?? null;
  }
  /** Returns the exact progress receipt needed by a checked work result's atomic write. */
  recordScore(id: string, score: number, reason: string, source = 'user') {
    text(id, 'goal_id');
    number(score, 'score', 0, 1);
    text(reason, 'reason', false);
    text(source, 'source', true, 512);
    if (source === 'daily_review') invalid('source', 'Automatic goal reviews require a verified measurement-to-score mapping');
    return this.transaction(() => {
      const before = vault.getGoal(id);
      if (!before) return null;
      const progress = vault.addProgressEntry(id, 'manual', before.score, score, reason, source);
      this.db.run('UPDATE goals SET score = ?, score_reason = ?, updated_at = ? WHERE id = ?', [score, reason, progress.created_at, id]);
      const goal = vault.getGoal(id)!;
      queueGoalEvent({ type: 'goal_scored', goalId: id, data: { score, reason, source, progressId: progress.id }, timestamp: progress.created_at });
      return { goal: this.refreshHealth(goal), progress };
    });
  }
  updateStatus(id: string, status: GoalStatus): Goal | null {
    text(id, 'goal_id');
    enumeration(status, ['draft', 'active', 'paused', 'completed', 'failed', 'killed'], 'status');
    return this.transaction(() => {
      const before = vault.getGoal(id);
      if (!before || before.status === status) return before;
      const goal = vault.updateGoalStatus(id, status)!;
      const type = status === 'completed' ? 'goal_completed' : status === 'failed' ? 'goal_failed' : status === 'killed' ? 'goal_killed' : 'goal_status_changed';
      queueGoalEvent({ type, goalId: id, data: { status }, timestamp: goal.updated_at }, terminal(status) ? goal : undefined);
      return goal;
    });
  }
  updateHealth(id: string, health: GoalHealth): Goal | null {
    text(id, 'goal_id');
    enumeration(health, ['on_track', 'at_risk', 'behind', 'critical'], 'health');
    return this.transaction(() => {
      const before = vault.getGoal(id);
      if (!before || before.health === health) return before;
      const goal = vault.updateGoalHealth(id, health)!;
      queueGoalEvent({ type: 'goal_health_changed', goalId: id, data: { health }, timestamp: goal.updated_at });
      return goal;
    });
  }
  private refreshHealth(goal: Goal): Goal {
    return this.updateHealth(goal.id, calculateGoalHealth(goal))!;
  }
  deleteGoal(id: string): boolean {
    text(id, 'goal_id');
    return this.transaction(() => {
      if (!vault.deleteGoal(id)) return false;
      queueGoalEvent({ type: 'goal_deleted', goalId: id, data: {}, timestamp: Date.now() });
      return true;
    });
  }
  reorderGoals(input: unknown): void {
    if (!Array.isArray(input) || input.length > 1000) invalid('items', 'must be an array of at most 1000 goals');
    const items = input.map((entry, index) => {
      const item = record(entry, `items[${index}]`);
      keys(item, ['id', 'sort_order'], `items[${index}]`);
      return { id: text(item.id, `items[${index}].id`), sort_order: number(item.sort_order, `items[${index}].sort_order`, 0, Number.MAX_SAFE_INTEGER, true) };
    });
    this.transaction(() => {
      for (const item of items) {
        if (!this.updateGoal(item.id, { sort_order: item.sort_order })) invalid('items', 'goal does not exist');
      }
    });
  }
  updateEscalation(id: string, stage: EscalationStage, data: Record<string, unknown>): void {
    text(id, 'goal_id');
    enumeration(stage, ['none', 'pressure', 'root_cause', 'suggest_kill'], 'stage');
    this.transaction(() => {
      const before = vault.getGoal(id);
      if (!before || before.escalation_stage === stage) return;
      const goal = vault.updateGoalEscalation(id, stage)!;
      queueGoalEvent({ type: 'goal_escalated', goalId: id, data: { ...data, stage }, timestamp: goal.updated_at });
    });
  }
  recordActivity(id: string, note: string, observedAt: number): void {
    text(id, 'goal_id');
    text(note, 'note');
    number(observedAt, 'observedAt', 0, 8640000000000000, true);
    this.transaction(() => {
      const goal = vault.getGoal(id);
      if (!goal || goal.status !== 'active' || vault.hasRecentAutoDetectedProgress(id, Date.now() - 30 * 60 * 1000)) return;
      const progress = vault.addProgressEntry(id, 'auto_detected', goal.score, goal.score, note, 'awareness');
      queueGoalEvent({ type: 'goal_activity_recorded', goalId: id, data: { progressId: progress.id, observedAt }, timestamp: progress.created_at });
    });
  }
  recordEveningReview(bundle: GoalReviewBundle, review: Record<string, unknown>) {
    const prose = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value.slice(0, 6000) : fallback;
    const assessment = prose(review.assessment, 'No assessment available.');
    const message = prose(review.message, 'Check your goals manually.');
    return this.transaction(() => {
      const reviewEvidence = { bundle, ...validateReviewScores(bundle, review.score_updates) };
      // There is no verified measurement mapping yet. Qualitative outcomes and activity never authorize a score.
      const scoreUpdates: { goalId: string; newScore: number; reason: string }[] = [];
      const completed = bundle.goals.flatMap(goal => goal.verifiedOutcomes).filter(outcome => outcome.verdict === 'passed').map(outcome => `[${outcome.id}] ${outcome.summary}`);
      const saved = vault.createCheckIn('evening_review', assessment, bundle.goals.map(goal => goal.goalId), [], completed);
      saveGoalReviewRecord(saved.id, reviewEvidence);
      const checkIn = { ...saved, review_evidence: reviewEvidence };
      queueGoalEvent({ type: 'check_in_evening', data: { checkInId: checkIn.id, bundleId: bundle.id, scoreUpdates, assessment,
        rejectedScoreUpdates: reviewEvidence.rejectedScoreUpdates, scorePolicy: bundle.scorePolicy }, timestamp: saved.created_at });
      return { checkIn, reviewEvidence, scoreUpdates, assessment, message };
    });
  }
}
