/**
 * SystemCronService - publishes time-based events onto the shared workflow
 * event bus so other subsystems can react to them without polling timers.
 *
 * Currently emits:
 *   - `cron.morning`  - default `0 7 * * *` (7am local)
 *   - `cron.evening`  - default `0 20 * * *` (8pm local)
 *   - `cron.hourly`   - default `37 * * * *` (every hour at :37 to avoid :00 spikes)
 *
 * Phase 2 will hook the goal system / commitment executor / chat-stale watcher
 * onto these events so the 15-minute heartbeat poll can be deleted. Phase 1
 * just lights up the infrastructure; nothing in the daemon subscribes yet.
 *
 * Reuses the zero-dependency CronScheduler that already powers workflow
 * triggers (extracted to src/lib/cron-scheduler.ts).
 */

import { CronScheduler } from '../lib/cron-scheduler.ts';
import type { WorkflowEventBus } from '../workflows/runtime/event-bus.ts';

export type SystemCronEvent = 'cron.morning' | 'cron.evening' | 'cron.hourly';

export type SystemCronConfig = {
  /** Cron expression for the morning trigger. Default `0 7 * * *`. */
  morning?: string;
  /** Cron expression for the evening trigger. Default `0 20 * * *`. */
  evening?: string;
  /** Cron expression for the hourly trigger. Default `37 * * * *` (avoids :00 spike). */
  hourly?: string;
};

export const DEFAULT_SYSTEM_CRON: Required<SystemCronConfig> = {
  morning: '0 7 * * *',
  evening: '0 20 * * *',
  hourly: '37 * * * *',
};

export class SystemCronService {
  private readonly scheduler = new CronScheduler();
  private readonly bus: WorkflowEventBus;
  private readonly config: Required<SystemCronConfig>;
  private started = false;

  constructor(bus: WorkflowEventBus, config?: SystemCronConfig) {
    this.bus = bus;
    this.config = {
      morning: config?.morning ?? DEFAULT_SYSTEM_CRON.morning,
      evening: config?.evening ?? DEFAULT_SYSTEM_CRON.evening,
      hourly: config?.hourly ?? DEFAULT_SYSTEM_CRON.hourly,
    };
  }

  start(): void {
    if (this.started) return;
    this.register('cron.morning', this.config.morning);
    this.register('cron.evening', this.config.evening);
    this.register('cron.hourly', this.config.hourly);
    this.started = true;
    console.log(
      `[SystemCron] Started (morning=${this.config.morning}, evening=${this.config.evening}, hourly=${this.config.hourly})`,
    );
  }

  stop(): void {
    if (!this.started) return;
    this.scheduler.cancelAll();
    this.started = false;
  }

  private register(eventType: SystemCronEvent, expression: string): void {
    try {
      this.scheduler.schedule(eventType, expression, () => {
        this.bus.publish(eventType, { firedAt: Date.now(), expression });
      });
    } catch (err) {
      console.error(`[SystemCron] Failed to schedule ${eventType} (${expression}):`, err);
    }
  }

  /** Diagnostic: list active jobs with next-run timestamps. */
  getJobs() {
    return this.scheduler.getJobs();
  }
}
