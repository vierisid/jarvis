import type { GoogleAuth } from './google-auth.ts';
import {
  CALENDAR_WATCH_FALLBACK_MS,
  GMAIL_WATCH_RENEW_MS,
  registerCalendarWatch,
  registerGmailWatch,
  renewDelayMs,
  stopCalendarWatch,
  stopGmailWatch,
  type CalendarChannel,
  type WatchTargets,
} from './google-watch.ts';

/**
 * Keeps the Google push watches armed for as long as the observers run
 * (GOOGLE.md "Push bridging"). HOSTED ONLY — self-hosted has no bridge to notify.
 *
 * Owns two things and nothing else: registering each watch once auth is
 * available, and re-arming it before it expires. It deliberately does NOT own
 * what happens when a notification arrives (that is the webhook → observer
 * syncNow path), so a broken watch degrades to polling instead of breaking
 * observation.
 *
 * Every failure is soft and logged. There is no retry loop: the renewal timer IS
 * the retry, and a tighter one would hammer Google while an instance is
 * misconfigured — for a latency optimisation.
 */
/**
 * The Google-facing calls and the scheduler, injectable.
 *
 * Not for purity's sake: the two behaviours worth pinning here are "a Calendar
 * re-registration stops the previous channel first" and "a failed attempt still
 * re-arms", and both are only observable through these. Without the seams the
 * only way to exercise them would be to wait hours for a real timer.
 */
export interface WatchApi {
  registerGmail: typeof registerGmailWatch;
  stopGmail: typeof stopGmailWatch;
  registerCalendar: typeof registerCalendarWatch;
  stopCalendar: typeof stopCalendarWatch;
  /** Defaults to setTimeout; a test captures the callback and fires it itself. */
  schedule: (fn: () => void, ms: number) => { cancel(): void };
}

const defaultApi: WatchApi = {
  registerGmail: registerGmailWatch,
  stopGmail: stopGmailWatch,
  registerCalendar: registerCalendarWatch,
  stopCalendar: stopCalendarWatch,
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // Node/Bun keep the process alive for pending timers; a renewal must never
    // be the reason a daemon will not exit.
    t.unref?.();
    return { cancel: () => clearTimeout(t) };
  },
};

export class GoogleWatchManager {
  private auth: GoogleAuth | null = null;
  private targets: WatchTargets = {};
  private gmailTimer: { cancel(): void } | null = null;
  private calendarTimer: { cancel(): void } | null = null;
  private calendarChannel: CalendarChannel | null = null;
  private running = false;
  private readonly api: WatchApi;

  constructor(api: Partial<WatchApi> = {}) {
    this.api = { ...defaultApi, ...api };
  }

  configure(auth: GoogleAuth | null, targets: WatchTargets): void {
    this.auth = auth;
    this.targets = targets;
  }

  /** True when there is anything to arm at all. */
  get enabled(): boolean {
    return Boolean(
      this.auth?.isAuthenticated() &&
        ((this.targets.pubsubTopic ?? null) !== null ||
          ((this.targets.pushCallback ?? null) !== null &&
            (this.targets.channelToken ?? null) !== null)),
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.enabled) return;
    this.running = true;
    await Promise.all([this.armGmail(), this.armCalendar()]);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.gmailTimer?.cancel();
    this.calendarTimer?.cancel();
    this.gmailTimer = null;
    this.calendarTimer = null;
    // Try to tell Google to stop pushing. Best effort, and often IMPOSSIBLE by
    // design: on a disconnect the tokens file is deleted before this runs, so
    // there is no access token left to call with and Google keeps publishing
    // until the watch expires (up to a week for Gmail). The bridge dropping
    // notifications it cannot route is the actual backstop — this only shortens
    // the window when a token still happens to be available.
    const token = await this.accessToken();
    if (!token) return;
    if (this.targets.pubsubTopic) await this.api.stopGmail(token);
    if (this.calendarChannel) {
      await this.api.stopCalendar(token, this.calendarChannel);
      this.calendarChannel = null;
    }
  }

  private async accessToken(): Promise<string | null> {
    if (!this.auth?.isAuthenticated()) return null;
    try {
      return await this.auth.getAccessToken();
    } catch (err) {
      console.warn(
        '[google-watch] could not get an access token:',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  private async armGmail(): Promise<void> {
    if (!this.running || !this.targets.pubsubTopic) return;
    // Armed BEFORE anything that can fail. "Re-arm even when this attempt
    // failed" only ever covered a failed registration: a token that could not
    // be fetched returned early and scheduled nothing, so push stayed off until
    // the next daemon restart. Under managed refresh that is no longer a rare
    // path — "the control plane was briefly unreachable" is an ordinary
    // transient, and it is likeliest at boot, which is exactly when this runs.
    this.gmailTimer = this.api.schedule(() => void this.armGmail(), GMAIL_WATCH_RENEW_MS);
    const token = await this.accessToken();
    if (!this.running) return this.gmailTimer?.cancel();
    if (!token) return;
    const result = await this.api.registerGmail(token, this.targets.pubsubTopic);
    // Replace the provisional timer with one derived from the real expiry.
    this.gmailTimer?.cancel();
    const delay = renewDelayMs(result?.expiration, Date.now(), GMAIL_WATCH_RENEW_MS);
    this.gmailTimer = this.api.schedule(() => void this.armGmail(), delay);
  }

  private async armCalendar(): Promise<void> {
    if (!this.running || !this.targets.pushCallback || !this.targets.channelToken) return;
    // Provisional re-arm before the fallible work — see armGmail.
    this.calendarTimer = this.api.schedule(
      () => void this.armCalendar(),
      CALENDAR_WATCH_FALLBACK_MS,
    );
    const token = await this.accessToken();
    if (!this.running) return this.calendarTimer?.cancel();
    if (!token) return;
    // Each registration creates a NEW channel, so the old one has to go or Google
    // fans every change out to a growing pile of channels for one instance.
    if (this.calendarChannel) {
      await this.api.stopCalendar(token, this.calendarChannel);
      this.calendarChannel = null;
    }
    this.calendarChannel = await this.api.registerCalendar(token, {
      callbackUrl: this.targets.pushCallback,
      channelToken: this.targets.channelToken,
    });
    this.calendarTimer?.cancel();
    const delay = renewDelayMs(
      this.calendarChannel?.expiration,
      Date.now(),
      CALENDAR_WATCH_FALLBACK_MS,
    );
    this.calendarTimer = this.api.schedule(() => void this.armCalendar(), delay);
  }
}
