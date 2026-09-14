import { generateId, getDb } from '../vault/schema.ts';
import type { Suggestion, SuggestionRow } from './types.ts';

/** Return the accepting transport, or null when no transport accepted it. */
export type DeliverOpportunity = (suggestion: Suggestion) => Promise<string | null>;
const RETRY_MS = 5 * 60_000;
const LEASE_MS = 2 * 60_000;

/** Notification outbox only. Retries must never republish workflow events. */
export class OpportunityDelivery {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(private deliver: DeliverOpportunity, private now = Date.now) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.flush(); }, 30_000);
    void this.flush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.inFlight) {
      this.inFlight = this.drain().catch(err => {
        console.error('[Awareness] Opportunity delivery failed:', err instanceof Error ? err.message : err);
      }).finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const db = getDb();
      const claimed = db.transaction(() => {
        const row = db.prepare(`SELECT s.* FROM opportunity_delivery d
          JOIN opportunity_hypotheses h ON h.suggestion_id = d.opportunity_id
          JOIN awareness_suggestions s ON s.id = d.opportunity_id
          WHERE d.delivered_at IS NULL AND d.next_attempt_at <= ? AND d.lease_until <= ?
            AND s.dismissed = 0 AND s.acted_on = 0 AND h.validation IS NULL
          ORDER BY s.created_at, s.id LIMIT 1`).get(this.now(), this.now()) as SuggestionRow | null;
        if (!row) return null;
        const token = generateId();
        db.prepare(`UPDATE opportunity_delivery SET lease_token = ?, lease_until = ?
          WHERE opportunity_id = ?`).run(token, this.now() + LEASE_MS, row.id);
        return { row, token };
      }).immediate();
      if (!claimed) return;

      const { row, token } = claimed;
      let channel: string | null = null;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // Bound shutdown and keep stalled transports from holding a lease forever.
        // A crash or a late send can still duplicate delivery: the stable ID is
        // preserved, and this is transport acceptance, not a read receipt.
        channel = await Promise.race([
          this.deliver({ id: row.id, type: row.type, title: row.title, body: row.body,
            triggerCaptureId: row.trigger_capture_id ?? '', context: JSON.parse(row.context || '{}') }),
          new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 30_000); }),
        ]);
      } catch (err) {
        console.warn('[Awareness] Opportunity notification pending:', err instanceof Error ? err.message : err);
      } finally { clearTimeout(timeout); }

      db.transaction(() => {
        const deliveredAt = channel ? this.now() : null;
        const result = db.prepare(`UPDATE opportunity_delivery
          SET delivered_at = ?, channel = ?, next_attempt_at = ?, lease_token = NULL, lease_until = 0
          WHERE opportunity_id = ? AND lease_token = ?`)
          .run(deliveredAt, channel, this.now() + RETRY_MS, row.id, token);
        if (channel && result.changes) {
          db.prepare(`UPDATE awareness_suggestions SET delivered = 1, delivered_at = ?, delivery_channel = ? WHERE id = ?`)
            .run(deliveredAt, channel, row.id);
        }
      }).immediate();
    }
  }
}
