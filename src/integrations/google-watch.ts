/**
 * Google push watches (GOOGLE.md "Push bridging"). HOSTED ONLY.
 *
 * The BRAIN registers these, not the control plane, and that is the whole point:
 * registering a watch requires the user's access token, and the control plane
 * deliberately does not have one (deliver-and-forget, D22). So the instance —
 * which does — asks Google to notify the bridge, and the bridge relays the
 * doorbell back. The token never leaves the instance.
 *
 * Both watches EXPIRE and must be renewed:
 *  - Gmail's `users.watch` lasts 7 days and Google explicitly expects a daily
 *    re-arm, so a weekly timer would be racing the expiry rather than beating it.
 *  - a Calendar channel's TTL is whatever Google returns in `expiration`.
 *
 * Everything here fails SOFT. A watch that cannot be registered means push does
 * not work for this instance, which costs latency only: the observers keep
 * polling on their own timers regardless. Nothing in this file should ever be
 * able to stop an instance from observing.
 */

import { randomUUID } from 'node:crypto';

/**
 * Every call here is bounded, and the stop calls especially.
 *
 * They are awaited from ObserverService.stop(), which the settings-reload
 * coordinator awaits on its SINGLE-FLIGHT queue — so one hanging request to
 * Google would wedge not just this shutdown but every subsequent settings
 * apply. An unbounded fetch on a shutdown path is a daemon that will not
 * shut down.
 */
const REGISTER_TIMEOUT_MS = 15_000;
/** Shorter: best-effort, and nothing downstream depends on the answer. */
const STOP_TIMEOUT_MS = 5_000;

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

/** Re-arm Gmail daily — the watch lasts 7 days, but Google asks for daily. */
export const GMAIL_WATCH_RENEW_MS = 24 * 60 * 60 * 1000;
/** Fall back to this when Google returns no usable Calendar expiry. */
export const CALENDAR_WATCH_FALLBACK_MS = 24 * 60 * 60 * 1000;
/** Renew this far BEFORE the stated expiry, so a slow renewal is not a gap. */
export const RENEW_MARGIN_MS = 60 * 60 * 1000;

export interface WatchTargets {
  /** Gmail's Pub/Sub topic; absent = no Gmail push. */
  pubsubTopic?: string | undefined;
  /** The bridge's callback URL; absent = no Calendar push. */
  pushCallback?: string | undefined;
  /**
   * Self-describing token the bridge maps back to this instance
   * (`<instanceId>.<mac>`). Google echoes it in X-Goog-Channel-Token, which is
   * what lets the bridge route with no channel table of its own.
   */
  channelToken?: string | undefined;
}

/**
 * Ask Gmail to publish this account's changes to the topic. Idempotent: calling
 * it again extends the existing watch rather than creating a second one.
 */
export async function registerGmailWatch(
  accessToken: string,
  topicName: string,
): Promise<{ historyId?: string; expiration?: number } | null> {
  try {
    const resp = await fetch(`${GMAIL_BASE}/watch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      // INBOX only: the doorbell exists for incoming mail, and every label
      // change in the mailbox would otherwise ring it.
      body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      // The overwhelmingly likely cause is the topic's IAM: Gmail publishes as
      // gmail-api-push@system.gserviceaccount.com and needs Publisher on it.
      // Saying so here saves an hour of looking at the wrong thing.
      console.warn(
        `[google-watch] Gmail watch refused (${resp.status}): ${detail.slice(0, 200)} — ` +
          'check that gmail-api-push@system.gserviceaccount.com has Pub/Sub Publisher on the topic',
      );
      return null;
    }
    const body = (await resp.json()) as { historyId?: string; expiration?: string };
    return {
      historyId: body.historyId,
      expiration: body.expiration ? Number(body.expiration) : undefined,
    };
  } catch (err) {
    console.warn('[google-watch] Gmail watch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function stopGmailWatch(accessToken: string): Promise<void> {
  try {
    await fetch(`${GMAIL_BASE}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
    });
  } catch {
    // Best effort. An abandoned watch expires by itself in 7 days, and the
    // bridge drops notifications it cannot route.
  }
}

export interface CalendarChannel {
  id: string;
  resourceId: string;
  expiration?: number;
}

/**
 * Ask Calendar to POST the bridge when this calendar changes.
 *
 * Unlike Gmail this is NOT idempotent — each call creates a new channel — so the
 * caller must stop the previous one, or Google ends up fanning every change out
 * to a growing pile of channels that all resolve to the same instance.
 */
export async function registerCalendarWatch(
  accessToken: string,
  input: { calendarId?: string; callbackUrl: string; channelToken: string },
): Promise<CalendarChannel | null> {
  const calendarId = encodeURIComponent(input.calendarId ?? 'primary');
  try {
    const resp = await fetch(`${CALENDAR_BASE}/${calendarId}/events/watch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: randomUUID(),
        type: 'web_hook',
        address: input.callbackUrl,
        token: input.channelToken,
      }),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.warn(
        `[google-watch] Calendar watch refused (${resp.status}): ${detail.slice(0, 200)}`,
      );
      return null;
    }
    const body = (await resp.json()) as { id?: string; resourceId?: string; expiration?: string };
    if (!body.id || !body.resourceId) return null;
    return {
      id: body.id,
      resourceId: body.resourceId,
      expiration: body.expiration ? Number(body.expiration) : undefined,
    };
  } catch (err) {
    console.warn('[google-watch] Calendar watch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function stopCalendarWatch(
  accessToken: string,
  channel: CalendarChannel,
): Promise<void> {
  try {
    await fetch('https://www.googleapis.com/calendar/v3/channels/stop', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: channel.id, resourceId: channel.resourceId }),
      signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
    });
  } catch {
    // Best effort; the channel expires on its own.
  }
}

/** When to renew, given whatever expiry Google stated. */
export function renewDelayMs(expiration: number | undefined, now: number, fallbackMs: number): number {
  if (!expiration || !Number.isFinite(expiration)) return fallbackMs;
  const untilExpiry = expiration - now;
  // Renew a margin early so a slow renewal is not a gap in coverage; never
  // schedule zero or negative, which would spin.
  return Math.max(60_000, Math.min(fallbackMs, untilExpiry - RENEW_MARGIN_MS));
}
