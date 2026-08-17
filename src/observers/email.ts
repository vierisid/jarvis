/**
 * EmailSync — Gmail Observer
 *
 * Polls Gmail API every 60s for unread messages.
 * Tracks seen message IDs to avoid re-emitting.
 * Fetches detail (subject, from, snippet) for new messages.
 * Graceful: if no Google tokens, logs warning and stays no-op.
 */

import type { Observer, ObserverEventHandler } from './index';
import type { GoogleAuth } from '../integrations/google-auth.ts';
import { listUnreadEmails, getEmailDetail } from '../integrations/google-api.ts';

const POLL_INTERVAL_MS = 60_000; // 60 seconds

export class EmailSync implements Observer {
  name = 'email';
  private running = false;
  private handler: ObserverEventHandler | null = null;
  private pollTimer: Timer | null = null;
  private googleAuth: GoogleAuth | null;
  private seenMessageIds: Set<string> = new Set();

  constructor(googleAuth?: GoogleAuth) {
    this.googleAuth = googleAuth ?? null;
  }

  async start(): Promise<void> {
    this.running = true;

    if (!this.googleAuth || !this.googleAuth.isAuthenticated()) {
      console.log('[email] No Google auth configured — email monitoring disabled');
      console.log('[email] Run: bun run src/scripts/google-setup.ts to set up Gmail');
      return;
    }

    console.log('[email] Observer started — polling Gmail every 60s');

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

    console.log('[email] Observer stopped');
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
      const messages = await listUnreadEmails(accessToken, 10);

      for (const msg of messages) {
        // Skip already-seen messages
        if (this.seenMessageIds.has(msg.id)) continue;
        this.seenMessageIds.add(msg.id);

        // Fetch detail
        try {
          const detail = await getEmailDetail(accessToken, msg.id);

          this.handler({
            type: 'email',
            data: {
              id: detail.id,
              threadId: detail.threadId,
              subject: detail.subject,
              from: detail.from,
              to: detail.to,
              date: detail.date,
              snippet: detail.snippet,
              labels: detail.labels,
            },
            timestamp: Date.now(),
          });
        } catch (err) {
          console.error(`[email] Failed to get detail for ${msg.id}:`, err);
        }
      }

      // Cap seenMessageIds to prevent unbounded growth
      if (this.seenMessageIds.size > 1000) {
        const arr = Array.from(this.seenMessageIds);
        this.seenMessageIds = new Set(arr.slice(arr.length - 500));
      }
    } catch (err) {
      console.error('[email] Poll error:', err);
    }
  }
}
