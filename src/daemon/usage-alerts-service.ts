import { CronScheduler } from '../lib/cron-scheduler.ts';
import type { JarvisConfig } from '../config/types.ts';
import { readHostedUsage, type HostedUsageMeter } from './hosted-usage.ts';
import { decideUsageAlerts, FLAG_PREFIX, staleFlagKeys, type UsageAlert } from './usage-alerts.ts';
import { deleteSetting, getSetting, getSettingsByPrefix, setSetting } from '../vault/settings.ts';

/**
 * The job that turns a usage reading into an OS notification.
 *
 * ## Why 15 minutes, and why a NAMED job
 *
 * `cron.hourly` is too coarse: a six-hour window can go from three-quarters to
 * full inside one hour, so the warning that was supposed to arrive first would
 * land after the wall. This is a registered CronScheduler job rather than a
 * revival of the deleted 15-minute heartbeat — it appears in the scheduler's
 * job list, it stops with the daemon, and it does one thing.
 *
 * The check costs nothing upstream when a room is already open: both this and
 * the Usage room read through the same 60s-cached reader.
 */

/** The fifth reason Jarvis interrupts (sidecar/notification.go's closed set). */
export const USAGE_NOTIFY_KIND = 'usage';
export const USAGE_CHECK_EXPRESSION = '@every 15m';

export interface UsageAlertsDeps {
  getConfig: () => JarvisConfig;
  /** Sends a `notify.show` payload to every connected sidecar. */
  notify: (payload: Record<string, unknown>) => void;
  /** True when at least one sidecar is connected — a notification with nowhere
   *  to go must not burn the once-per-window flag. */
  canNotify: () => boolean;
  /** Seams for tests; default to the settings table and the shared reader. */
  readMeter?: (config: JarvisConfig) => Promise<HostedUsageMeter | null>;
  store?: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    keys(): string[];
    delete(key: string): void;
  };
  now?: () => number;
}

const settingsStore = {
  get: (key: string) => getSetting(key),
  set: (key: string, value: string) => setSetting(key, value),
  keys: () => Object.keys(getSettingsByPrefix(FLAG_PREFIX)),
  delete: (key: string) => deleteSetting(key),
};

export class UsageAlertsService {
  private readonly scheduler = new CronScheduler();
  private started = false;
  private running = false;

  constructor(private readonly deps: UsageAlertsDeps) {}

  start(): void {
    if (this.started) return;
    try {
      this.scheduler.schedule('usage.thresholds', USAGE_CHECK_EXPRESSION, () => {
        void this.check().catch((err) => console.warn('[usage] threshold check failed:', err));
      });
      this.started = true;
    } catch (err) {
      console.error('[usage] failed to schedule the threshold check:', err);
    }
  }

  stop(): void {
    if (!this.started) return;
    this.scheduler.cancelAll();
    this.started = false;
  }

  /** One pass. Exposed so tests drive it without waiting on a timer. */
  async check(): Promise<UsageAlert[]> {
    // A slow control plane must not let two passes overlap and double-notify
    // through the gap between deciding and recording.
    if (this.running) return [];
    this.running = true;
    try {
      const store = this.deps.store ?? settingsStore;
      const read = this.deps.readMeter ?? readHostedUsage;
      const meter = await read(this.deps.getConfig());
      if (!meter) return [];

      const due = decideUsageAlerts(meter, (key) => store.get(key) !== null);
      // Nowhere to deliver: leave the flags unset so the warning still lands
      // once a sidecar connects, rather than being silently consumed here.
      //
      // Sampled HERE, after the meter read, rather than before it: the read is
      // a network round trip, and a sidecar that disconnects across it would
      // otherwise have its warning recorded as delivered against a closed door.
      // A `week.100` lost that way is lost for the rest of the week.
      if (due.length > 0 && !this.deps.canNotify()) return [];

      const at = String(this.deps.now?.() ?? Date.now());
      for (const alert of due) {
        // Recorded BEFORE sending. A notify that throws would otherwise leave
        // the flag unset and re-fire the same toast every 15 minutes.
        store.set(alert.key, at);
        this.deps.notify({
          id: alert.key,
          kind: USAGE_NOTIFY_KIND,
          title: alert.title,
          body: alert.body,
          meta: 'usage',
          destructive: false,
          actions: [
            { id: 'review', label: 'Open Jarvis', primary: true },
            { id: 'dismiss', label: 'Dismiss' },
          ],
        });
      }
      for (const stale of staleFlagKeys(store.keys(), meter)) store.delete(stale);
      return due;
    } finally {
      this.running = false;
    }
  }

  getJobs() {
    return this.scheduler.getJobs();
  }
}
