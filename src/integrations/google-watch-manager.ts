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
export class GoogleWatchManager {
  private auth: GoogleAuth | null = null;
  private targets: WatchTargets = {};
  private gmailTimer: ReturnType<typeof setTimeout> | null = null;
  private calendarTimer: ReturnType<typeof setTimeout> | null = null;
  private calendarChannel: CalendarChannel | null = null;
  private running = false;

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
    if (this.gmailTimer) clearTimeout(this.gmailTimer);
    if (this.calendarTimer) clearTimeout(this.calendarTimer);
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
    if (this.targets.pubsubTopic) await stopGmailWatch(token);
    if (this.calendarChannel) {
      await stopCalendarWatch(token, this.calendarChannel);
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
    const token = await this.accessToken();
    if (!token) return;
    const result = await registerGmailWatch(token, this.targets.pubsubTopic);
    // Re-arm even when this attempt failed: the timer is the retry, and a
    // transient refusal must not disable push until the next daemon restart.
    const delay = renewDelayMs(result?.expiration, Date.now(), GMAIL_WATCH_RENEW_MS);
    this.gmailTimer = setTimeout(() => void this.armGmail(), delay);
    // Node/Bun keep the process alive for pending timers; a renewal must never
    // be the reason a daemon will not exit.
    this.gmailTimer.unref?.();
  }

  private async armCalendar(): Promise<void> {
    if (!this.running || !this.targets.pushCallback || !this.targets.channelToken) return;
    const token = await this.accessToken();
    if (!token) return;
    // Each registration creates a NEW channel, so the old one has to go or Google
    // fans every change out to a growing pile of channels for one instance.
    if (this.calendarChannel) {
      await stopCalendarWatch(token, this.calendarChannel);
      this.calendarChannel = null;
    }
    this.calendarChannel = await registerCalendarWatch(token, {
      callbackUrl: this.targets.pushCallback,
      channelToken: this.targets.channelToken,
    });
    const delay = renewDelayMs(
      this.calendarChannel?.expiration,
      Date.now(),
      CALENDAR_WATCH_FALLBACK_MS,
    );
    this.calendarTimer = setTimeout(() => void this.armCalendar(), delay);
    this.calendarTimer.unref?.();
  }
}
