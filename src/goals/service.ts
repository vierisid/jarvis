/**
 * GoalService — Core service for M16 Autonomous Goal Pursuit
 *
 * Manages goal lifecycle, daily rhythm (morning plan + evening review),
 * accountability checks, health recalculation, and escalation.
 * Implements the Service interface for daemon integration.
 */

import type { Service, ServiceStatus } from '../daemon/services.ts';
import type { GoalEvent } from './events.ts';
import type { GoalConfig } from '../config/types.ts';
import type { Goal, GoalLevel, GoalStatus, GoalHealth } from './types.ts';
import type { DailyRhythm } from './rhythm.ts';
import type { WorkflowEventBus } from '../workflows/runtime/event-bus.ts';
import { CronScheduler } from '../lib/cron-scheduler.ts';
import * as vault from '../vault/goals.ts';

export class GoalService implements Service {
  name = 'goals';
  private _status: ServiceStatus = 'stopped';
  private config: GoalConfig;
  private eventCallback: ((event: GoalEvent) => void) | null = null;
  private chatCallback: ((text: string) => void) | null = null;
  private rhythm: DailyRhythm | null = null;
  private eventBus: WorkflowEventBus | null = null;

  // Cron scheduler for morning/evening rhythm fire times derived from the
  // goal's own morning_window/evening_window config (which may differ from
  // the system-wide cron.morning/cron.evening defaults).
  private readonly cron = new CronScheduler();

  // Subscriptions to the shared event bus (cron.hourly handles accountability
  // + health refresh that depend on elapsed time). Stored so stop() can unsub.
  private unsubscribers: Array<() => void> = [];

  constructor(config: GoalConfig, eventBus?: WorkflowEventBus) {
    this.config = config;
    this.eventBus = eventBus ?? null;
  }

  /**
   * Inject the shared event bus after construction. Used by the daemon when
   * the bus is built after GoalService but before start().
   */
  setEventBus(bus: WorkflowEventBus): void {
    this.eventBus = bus;
  }

  /**
   * Set callback for broadcasting goal events via WebSocket.
   */
  setEventCallback(cb: (event: GoalEvent) => void): void {
    this.eventCallback = cb;
  }

  /**
   * Set callback for sending proactive messages to the user's chat.
   */
  setChatCallback(cb: (text: string) => void): void {
    this.chatCallback = cb;
  }

  /**
   * Set the DailyRhythm instance for morning/evening planning.
   */
  setRhythm(rhythm: DailyRhythm): void {
    this.rhythm = rhythm;
  }

  private emit(event: GoalEvent): void {
    if (this.eventCallback) {
      this.eventCallback(event);
    }
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this._status = 'stopped';
      console.log('[GoalService] Disabled by config');
      return;
    }

    // Idempotency guard. Cron.schedule auto-cancels duplicates by id, but
    // eventBus.subscribe creates a fresh subscription each call - without
    // this guard a re-start would double accountability/health checks.
    if (this._status === 'running' || this._status === 'starting') {
      console.log('[GoalService] start() called while already running - ignoring');
      return;
    }

    this._status = 'starting';

    // Morning/evening rhythm: fire once at the start hour of each window using
    // a dedicated cron job. The previous 60s timer was a polling approximation
    // of "trigger sometime within the window"; once-at-start is more precise.
    // Clamp to a valid cron hour (0-23) so an out-of-range config value falls
    // back to a sane default rather than failing the schedule call.
    const clampHour = (h: number, fallback: number): number => {
      const n = Math.floor(h);
      return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback;
    };
    const morningHour = clampHour(this.config.morning_window?.start ?? 7, 7);
    const eveningHour = clampHour(this.config.evening_window?.start ?? 20, 20);

    try {
      this.cron.schedule('goals:morning', `0 ${morningHour} * * *`, () => {
        this.runMorningPlan().catch(err =>
          console.error('[GoalService] Morning plan error:', err),
        );
      });
    } catch (err) {
      console.error('[GoalService] Failed to schedule morning cron:', err);
    }

    try {
      this.cron.schedule('goals:evening', `0 ${eveningHour} * * *`, () => {
        this.runEveningReview().catch(err =>
          console.error('[GoalService] Evening review error:', err),
        );
      });
    } catch (err) {
      console.error('[GoalService] Failed to schedule evening cron:', err);
    }

    // Accountability + global health sweep: piggyback on cron.hourly so
    // escalation-by-weeks and deadline-ratio-driven health transitions update
    // on a steady cadence. Per-goal health is ALSO recalculated immediately
    // when scoreGoal() runs (see below) so a score change reflects in health
    // without waiting for the next hourly tick.
    if (this.eventBus) {
      this.unsubscribers.push(
        this.eventBus.subscribe('cron.hourly', () => {
          this.checkAccountability().catch(err =>
            console.error('[GoalService] Accountability check error:', err),
          );
          this.recalculateAllHealth().catch(err =>
            console.error('[GoalService] Health recalc error:', err),
          );
        }),
      );
    } else {
      console.warn(
        '[GoalService] No event bus wired - accountability/health will only update on score changes',
      );
    }

    this._status = 'running';
    console.log(
      `[GoalService] Started (morning=0 ${morningHour} * * *, evening=0 ${eveningHour} * * *, accountability+health=cron.hourly)`,
    );
  }

  async stop(): Promise<void> {
    this._status = 'stopping';

    this.cron.cancelAll();
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];

    this._status = 'stopped';
    console.log('[GoalService] Stopped');
  }

  status(): ServiceStatus {
    return this._status;
  }

  // ── Goal CRUD with events ─────────────────────────────────────────

  createGoal(title: string, level: GoalLevel, opts?: Parameters<typeof vault.createGoal>[2]): Goal {
    const goal = vault.createGoal(title, level, opts);
    this.emit({
      type: 'goal_created',
      goalId: goal.id,
      data: { title, level, parent_id: goal.parent_id },
      timestamp: Date.now(),
    });
    return goal;
  }

  getGoal(id: string): Goal | null {
    return vault.getGoal(id);
  }

  updateGoal(id: string, updates: Parameters<typeof vault.updateGoal>[1]): Goal | null {
    const goal = vault.updateGoal(id, updates);
    if (goal) {
      this.emit({
        type: 'goal_updated',
        goalId: id,
        data: { updates },
        timestamp: Date.now(),
      });
    }
    return goal;
  }

  scoreGoal(id: string, score: number, reason: string, source = 'user'): Goal | null {
    const goal = vault.updateGoalScore(id, score, reason, source);
    if (goal) {
      this.emit({
        type: 'goal_scored',
        goalId: id,
        data: { score: goal.score, reason, source },
        timestamp: Date.now(),
      });
      // Health depends on score+deadline, so a score change can change health
      // immediately. Previously this was caught by the 15-min healthTimer; now
      // we recalc just this goal on the score-change event.
      const newHealth = this.calculateHealth(goal);
      if (newHealth !== goal.health) {
        this.updateHealth(goal.id, newHealth);
      }
    }
    return goal;
  }

  updateStatus(id: string, status: GoalStatus): Goal | null {
    const goal = vault.updateGoalStatus(id, status);
    if (!goal) return null;

    const eventType = status === 'completed' ? 'goal_completed'
      : status === 'failed' ? 'goal_failed'
      : status === 'killed' ? 'goal_killed'
      : 'goal_status_changed';

    this.emit({
      type: eventType,
      goalId: id,
      data: { status },
      timestamp: Date.now(),
    });

    // Extract goal completion data for vault knowledge
    if (status === 'completed' || status === 'failed' || status === 'killed') {
      try {
        const { extractGoalCompletion } = require('../vault/extractor.ts');
        extractGoalCompletion(goal);
      } catch {
        // Extractor may not be available — ignore
      }
    }

    return goal;
  }

  updateHealth(id: string, health: GoalHealth): Goal | null {
    const goal = vault.updateGoalHealth(id, health);
    if (goal) {
      this.emit({
        type: 'goal_health_changed',
        goalId: id,
        data: { health },
        timestamp: Date.now(),
      });
    }
    return goal;
  }

  deleteGoal(id: string): boolean {
    const result = vault.deleteGoal(id);
    if (result) {
      this.emit({
        type: 'goal_deleted',
        goalId: id,
        data: {},
        timestamp: Date.now(),
      });
    }
    return result;
  }

  // ── Daily Rhythm ──────────────────────────────────────────────────

  /**
   * Check if we're in a morning or evening window and trigger check-ins.
   * Calls DailyRhythm to generate the plan/review and sends the message to chat.
   */
  /**
   * Run the morning plan via DailyRhythm. Skipped if already run today.
   * Triggered by the goals:morning cron job.
   */
  private async runMorningPlan(): Promise<void> {
    if (vault.getTodayCheckIn('morning_plan')) return;
    if (!this.rhythm) return;

    console.log('[GoalService] Morning cron fired - running morning plan');
    try {
      const result = await this.rhythm.runMorningPlan();
      if (this.chatCallback) {
        const parts: string[] = [];
        parts.push(`**Morning Plan**\n`);
        parts.push(result.message);
        if (result.warnings.length > 0) {
          parts.push(`\n\n**Warnings:**`);
          for (const w of result.warnings) parts.push(`- ${w}`);
        }
        if (result.focusAreas.length > 0) {
          parts.push(`\n\n**Focus Areas:**`);
          for (const f of result.focusAreas) parts.push(`- ${f}`);
        }
        if (result.dailyActions.length > 0) {
          parts.push(`\n\n**Today's Actions:**`);
          for (const a of result.dailyActions) parts.push(`- ${a}`);
        }
        this.chatCallback(parts.join('\n'));
      }
    } catch (err) {
      console.error('[GoalService] Morning plan failed:', err);
    }
  }

  /**
   * Run the evening review via DailyRhythm. Skipped if already run today.
   * Triggered by the goals:evening cron job.
   */
  private async runEveningReview(): Promise<void> {
    if (vault.getTodayCheckIn('evening_review')) return;
    if (!this.rhythm) return;

    console.log('[GoalService] Evening cron fired - running evening review');
    try {
      const result = await this.rhythm.runEveningReview();
      if (this.chatCallback) {
        const parts: string[] = [];
        parts.push(`**Evening Review**\n`);
        parts.push(result.message);
        parts.push(`\n\n${result.assessment}`);
        if (result.scoreUpdates.length > 0) {
          parts.push(`\n\n**Score Updates:**`);
          for (const u of result.scoreUpdates) {
            parts.push(`- ${u.reason} (${u.newScore.toFixed(1)})`);
          }
        }
        this.chatCallback(parts.join('\n'));
      }
    } catch (err) {
      console.error('[GoalService] Evening review failed:', err);
    }
  }

  // ── Accountability ────────────────────────────────────────────────

  /**
   * Check active goals for escalation needs.
   * Full drill-sergeant logic is in src/goals/accountability.ts (Phase 4).
   */
  private async checkAccountability(): Promise<void> {
    const needingEscalation = vault.getGoalsNeedingEscalation();
    const overdue = vault.getOverdueGoals();

    for (const goal of needingEscalation) {
      if (goal.escalation_stage === 'none') {
        // Auto-escalate to 'pressure' stage
        const escalationWeeks = this.config.escalation_weeks ?? { pressure: 1, root_cause: 3, suggest_kill: 4 };
        const behindSince = goal.updated_at;
        const weeksBehind = (Date.now() - behindSince) / (7 * 24 * 60 * 60 * 1000);

        if (weeksBehind >= escalationWeeks.pressure) {
          vault.updateGoalEscalation(goal.id, 'pressure');
          this.emit({
            type: 'goal_escalated',
            goalId: goal.id,
            data: { stage: 'pressure', weeksBehind },
            timestamp: Date.now(),
          });
        }
      } else if (goal.escalation_stage === 'pressure') {
        const escalationWeeks = this.config.escalation_weeks ?? { pressure: 1, root_cause: 3, suggest_kill: 4 };
        const startedAt = goal.escalation_started_at ?? goal.updated_at;
        const weeksSinceEscalation = (Date.now() - startedAt) / (7 * 24 * 60 * 60 * 1000);

        if (weeksSinceEscalation >= escalationWeeks.root_cause) {
          vault.updateGoalEscalation(goal.id, 'root_cause');
          this.emit({
            type: 'goal_escalated',
            goalId: goal.id,
            data: { stage: 'root_cause', weeksSinceEscalation },
            timestamp: Date.now(),
          });
        }
      } else if (goal.escalation_stage === 'root_cause') {
        const escalationWeeks = this.config.escalation_weeks ?? { pressure: 1, root_cause: 3, suggest_kill: 4 };
        const startedAt = goal.escalation_started_at ?? goal.updated_at;
        const weeksSinceEscalation = (Date.now() - startedAt) / (7 * 24 * 60 * 60 * 1000);

        if (weeksSinceEscalation >= escalationWeeks.suggest_kill) {
          vault.updateGoalEscalation(goal.id, 'suggest_kill');
          this.emit({
            type: 'goal_escalated',
            goalId: goal.id,
            data: { stage: 'suggest_kill', weeksSinceEscalation },
            timestamp: Date.now(),
          });
        }
      }
    }

    // Log overdue goals (Phase 4 will handle the drill-sergeant messaging)
    if (overdue.length > 0) {
      console.log(`[GoalService] ${overdue.length} overdue goal(s) detected`);
    }
  }

  // ── Health Recalculation ──────────────────────────────────────────

  /**
   * Recalculate health for all active goals based on score and deadline.
   */
  private async recalculateAllHealth(): Promise<void> {
    const activeGoals = vault.findGoals({ status: 'active' });
    let changed = 0;

    for (const goal of activeGoals) {
      const newHealth = this.calculateHealth(goal);
      if (newHealth !== goal.health) {
        this.updateHealth(goal.id, newHealth);
        changed++;
      }
    }

    if (changed > 0) {
      console.log(`[GoalService] Health recalculated: ${changed} goal(s) changed`);
    }
  }

  /**
   * Calculate health for a single goal based on score progress vs time elapsed.
   */
  private calculateHealth(goal: Goal): GoalHealth {
    // If no deadline, base purely on score
    if (!goal.deadline) {
      if (goal.score >= 0.6) return 'on_track';
      if (goal.score >= 0.3) return 'at_risk';
      return 'behind';
    }

    const now = Date.now();
    const startTime = goal.started_at ?? goal.created_at;
    const totalDuration = goal.deadline - startTime;
    const elapsed = now - startTime;

    // If past deadline
    if (now > goal.deadline) {
      if (goal.score >= 0.7) return 'on_track'; // nearly done
      if (goal.score >= 0.4) return 'behind';
      return 'critical';
    }

    // Ratio: how far along are we in time vs score
    const timeRatio = totalDuration > 0 ? elapsed / totalDuration : 0;
    const expectedScore = timeRatio * 0.7; // expecting 0.7 = good at deadline

    const gap = expectedScore - goal.score;

    if (gap <= 0) return 'on_track';      // ahead of pace
    if (gap <= 0.15) return 'at_risk';     // slightly behind
    if (gap <= 0.3) return 'behind';       // significantly behind
    return 'critical';                      // way behind
  }

  // ── Metrics ───────────────────────────────────────────────────────

  getMetrics() {
    return vault.getGoalMetrics();
  }
}
