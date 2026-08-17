/**
 * CalendarSync — Google Calendar Observer
 *
 * Polls Calendar API every 2 minutes with a 30-minute look-ahead.
 * Tracks announced event IDs to avoid duplicate alerts.
 * Graceful: if no Google tokens, logs warning and stays no-op.
 */

import type { Observer, ObserverEventHandler } from './index';
import type { GoogleAuth } from '../integrations/google-auth.ts';
import { listUpcomingEvents } from '../integrations/google-api.ts';

const POLL_INTERVAL_MS = 2 * 60_000;  // 2 minutes
const LOOK_AHEAD_MS = 30 * 60_000;    // 30 minutes

export class CalendarSync implements Observer {
  name = 'calendar';
  private running = false;
  private handler: ObserverEventHandler | null = null;
  private pollTimer: Timer | null = null;
  private googleAuth: GoogleAuth | null;
  private announcedEventIds: Set<string> = new Set();
  private calendarId: string;

  constructor(googleAuth?: GoogleAuth, calendarId?: string) {
    this.googleAuth = googleAuth ?? null;
    this.calendarId = calendarId ?? 'primary';
  }

  async start(): Promise<void> {
    this.running = true;

    if (!this.googleAuth || !this.googleAuth.isAuthenticated()) {
      console.log('[calendar] No Google auth configured — calendar monitoring disabled');
      console.log('[calendar] Run: bun run src/scripts/google-setup.ts to set up Calendar');
      return;
    }

    console.log('[calendar] Observer started — polling Calendar every 2min (30min look-ahead)');

    // Initial poll
    this.poll();

    // Set up recurring poll
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    console.log('[calendar] Observer stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  onEvent(handler: ObserverEventHandler): void {
    this.handler = handler;
  }

  /**
   * Poll immediately (the push bridge's doorbell). No-op while stopped, so a
   * notification that races a disconnect cannot resurrect a dead observer.
   */
  async syncNow(): Promise<void> {
    if (!this.running) return;
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (!this.googleAuth || !this.handler) return;

    try {
      const accessToken = await this.googleAuth.getAccessToken();
      const now = new Date();
      const later = new Date(now.getTime() + LOOK_AHEAD_MS);

      const events = await listUpcomingEvents(
        accessToken,
        this.calendarId,
        now.toISOString(),
        later.toISOString(),
        10
      );

      for (const event of events) {
        // Skip already-announced events
        if (this.announcedEventIds.has(event.id)) continue;
        this.announcedEventIds.add(event.id);

        this.handler({
          type: 'calendar',
          data: {
            id: event.id,
            summary: event.summary,
            description: event.description,
            start: event.start,
            end: event.end,
            location: event.location,
            attendees: event.attendees,
            htmlLink: event.htmlLink,
          },
          timestamp: Date.now(),
        });
      }

      // Cap announcedEventIds to prevent unbounded growth
      if (this.announcedEventIds.size > 500) {
        const arr = Array.from(this.announcedEventIds);
        this.announcedEventIds = new Set(arr.slice(arr.length - 250));
      }
    } catch (err) {
      console.error('[calendar] Poll error:', err);
    }
  }
}
