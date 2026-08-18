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
  /**
   * Bumped by every stop(). An arm carries the generation it began in and does
   * nothing once that generation is over.
   *
   * The awaits in an arm are long (a token fetch that may go to the control
   * plane, then a registration bounded at 15s) and the daemon's own google
   * applier does `stopService('observers')` then `startService('observers')`
   * without awaiting the manager — so an arm from before the stop can resolve
   * after a new one has already begun. Two things went wrong then: a Calendar
   * channel got REGISTERED after the user disconnected (and no later stop could
   * ever cancel it, because the tokens file was already gone, so Google kept
   * pushing that user's calendar for the channel's whole TTL), and two arms
   * writing one timer field left the displaced one live but unreachable, each
   * re-arming forever. The shared single-flight refresh made this likelier, not
   * less: both arms now await the SAME promise and resume together.
   */
  private generation = 0;
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
    const gen = this.generation;
    await Promise.all([this.armGmail(gen), this.armCalendar(gen)]);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
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

  /**
   * Has this arm been overtaken? Either the manager stopped, or a later start()
   * began a new generation.
   *
   * A stale arm returns WITHOUT touching the timer fields: whoever made it stale
   * already cancelled what was there (stop()) or will cancel-then-replace it (the
   * new generation's own arm), so reaching in here could only kill a live timer
   * that belongs to somebody else.
   */
  private stale(gen: number): boolean {
    return !this.running || gen !== this.generation;
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

  /** Cancel this generation's renewal and schedule the next one. */
  private rearmGmail(gen: number, delay: number): void {
    if (this.stale(gen)) return;
    this.gmailTimer?.cancel();
    this.gmailTimer = this.api.schedule(() => void this.armGmail(gen), delay);
  }

  private rearmCalendar(gen: number, delay: number): void {
    if (this.stale(gen)) return;
    this.calendarTimer?.cancel();
    this.calendarTimer = this.api.schedule(() => void this.armCalendar(gen), delay);
  }

  private async armGmail(gen: number): Promise<void> {
    if (this.stale(gen) || !this.targets.pubsubTopic) return;
    // Armed BEFORE anything that can fail. "Re-arm even when this attempt
    // failed" only ever covered a failed registration: a token that could not
    // be fetched returned early and scheduled nothing, so push stayed off until
    // the next daemon restart. Under managed refresh that is no longer a rare
    // path — "the control plane was briefly unreachable" is an ordinary
    // transient, and it is likeliest at boot, which is exactly when this runs.
    this.rearmGmail(gen, GMAIL_WATCH_RENEW_MS);
    const token = await this.accessToken();
    if (this.stale(gen) || !token) return;
    const result = await this.api.registerGmail(token, this.targets.pubsubTopic);
    if (this.stale(gen)) {
      // Stopped while this registration was in flight. We still hold a token —
      // which stop() itself may not have had, since a disconnect deletes the
      // tokens file first — so UNDO the watch we just created instead of leaving
      // Google publishing at a bridge that will drop everything.
      if (result) await this.api.stopGmail(token).catch(() => {});
      return;
    }
    // Replace the provisional timer with one derived from the real expiry.
    this.rearmGmail(gen, renewDelayMs(result?.expiration, Date.now(), GMAIL_WATCH_RENEW_MS));
  }

  private async armCalendar(gen: number): Promise<void> {
    if (this.stale(gen) || !this.targets.pushCallback || !this.targets.channelToken) return;
    // Provisional re-arm before the fallible work — see armGmail.
    this.rearmCalendar(gen, CALENDAR_WATCH_FALLBACK_MS);
    const token = await this.accessToken();
    if (this.stale(gen) || !token) return;
    // Each registration creates a NEW channel, so the old one has to go or Google
    // fans every change out to a growing pile of channels for one instance.
    if (this.calendarChannel) {
      await this.api.stopCalendar(token, this.calendarChannel);
      this.calendarChannel = null;
    }
    const channel = await this.api.registerCalendar(token, {
      callbackUrl: this.targets.pushCallback,
      channelToken: this.targets.channelToken,
    });
    if (this.stale(gen)) {
      // See armGmail. Assigning `channel` here would also ORPHAN whatever the new
      // generation had already registered, leaving a channel nothing holds a
      // reference to and no stop() can ever cancel.
      if (channel) await this.api.stopCalendar(token, channel).catch(() => {});
      return;
    }
    this.calendarChannel = channel;
    this.rearmCalendar(
      gen,
      renewDelayMs(channel?.expiration, Date.now(), CALENDAR_WATCH_FALLBACK_MS),
    );
  }
}
