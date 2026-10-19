import { generateId, getDb } from '../vault/schema.ts';
import { DeliveryUnconfirmedError } from '../comms/delivery.ts';
import type { Suggestion, SuggestionRow } from './types.ts';

/**
 * Return the accepting transport, or null when no transport accepted it.
 * Throw `DeliveryUnconfirmedError` when one may have taken it unconfirmed.
 */
export type DeliverOpportunity = (suggestion: Suggestion) => Promise<string | null>;
const RETRY_MS = 5 * 60_000;
const LEASE_MS = 2 * 60_000;
const SEND_WAIT_MS = 30_000;
/** An unconfirmed row is never due, so no worker (an older one included, after a rollback) claims it. */
const NEVER = Number.MAX_SAFE_INTEGER;

/** How one attempt ended: accepted, maybe taken without confirmation, or nothing sent. */
type Attempt = { delivered: string } | { unconfirmed: string | null } | { pending: true };

function attempt(sending: Promise<string | null>): Promise<Attempt> {
  return sending.then<Attempt, Attempt>(channel => channel ? { delivered: channel } : { pending: true }, err => {
    if (err instanceof DeliveryUnconfirmedError) return { unconfirmed: err.channels.join(',') };
    console.warn('[Awareness] Opportunity notification pending:', err instanceof Error ? err.message : err);
    return { pending: true };
  });
}

/**
 * Notification outbox only. Retries must never republish workflow events, and
 * (Q-19) never resend a notification a transport may already have taken: an
 * unconfirmed send is recorded as such and left for the person, never retried.
 */
export class OpportunityDelivery {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(private deliver: DeliverOpportunity, private now = Date.now, private sendWaitMs = SEND_WAIT_MS) {}

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
          WHERE d.delivered_at IS NULL AND d.unconfirmed_at IS NULL AND d.next_attempt_at <= ? AND d.lease_until <= ?
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
      const sending = attempt(Promise.resolve().then(() => this.deliver({ id: row.id, type: row.type, title: row.title,
        body: row.body, triggerCaptureId: row.trigger_capture_id ?? '', context: JSON.parse(row.context || '{}') })));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      // Bound shutdown and keep stalled transports from holding a lease forever.
      // A transport still sending when the wait ends may yet deliver it, so the
      // proposal is recorded unconfirmed and never sent again on its own; its
      // late answer still settles it. A crash can still duplicate delivery: the
      // stable ID is preserved, and this is transport acceptance, not a read receipt.
      const result = await Promise.race([sending,
        new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), this.sendWaitMs); })]);
      clearTimeout(timeout);
      if (result) { this.settle(row.id, result, { token }); continue; }
      const unconfirmedAt = this.settle(row.id, { unconfirmed: null }, { token });
      void sending.then(late => { this.settle(row.id, late, { unconfirmedAt }); })
        .catch(err => console.warn('[Awareness] Late opportunity receipt not recorded:', err instanceof Error ? err.message : err));
    }
  }

  /**
   * Record how an attempt ended, only while this worker still owns the row:
   * its lease, or the unconfirmed mark it left when the wait ran out. Nothing
   * sent: retried after a cooldown. Unconfirmed: never retried.
   */
  private settle(id: string, result: Attempt, owner: { token: string } | { unconfirmedAt: number }): number {
    const db = getDb();
    const now = this.now();
    const delivered = 'delivered' in result ? result.delivered : null;
    const unconfirmed = 'unconfirmed' in result;
    db.transaction(() => {
      const changes = db.prepare(`UPDATE opportunity_delivery
        SET delivered_at = ?, channel = ?, unconfirmed_at = ?, next_attempt_at = ?, lease_token = NULL, lease_until = 0
        WHERE opportunity_id = ? AND ${'token' in owner ? 'lease_token = ?' : 'unconfirmed_at = ? AND delivered_at IS NULL'}`)
        .run(delivered ? now : null, delivered ?? (unconfirmed ? (result as { unconfirmed: string | null }).unconfirmed : null),
          unconfirmed ? now : null, unconfirmed ? NEVER : now + RETRY_MS, id, 'token' in owner ? owner.token : owner.unconfirmedAt).changes;
      if (delivered && changes) {
        db.prepare(`UPDATE awareness_suggestions SET delivered = 1, delivered_at = ?, delivery_channel = ? WHERE id = ?`)
          .run(now, delivered, id);
      }
    }).immediate();
    return now;
  }
}
