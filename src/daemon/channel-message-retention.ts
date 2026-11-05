/**
 * Retention for channel conversation messages (#1167): per-sender Telegram and
 * Discord threads and Pebble's voice exchanges. OFF unless
 * `conversations.channel_message_retention_days` is set in config.yaml, so an
 * existing install keeps everything until its owner chooses otherwise.
 */
import type { JarvisConfig } from '../config/types.ts';
import { pruneChannelConversationMessages } from '../vault/conversations.ts';
import { PEBBLE_CHANNEL } from './pebble-dialogue.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 60_000;

type Timers = {
  setInterval: typeof setInterval; clearInterval: typeof clearInterval;
  setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout;
};

/** The longest retention accepted: ten years. Anything longer is "forever" by another name. */
export const MAX_CHANNEL_MESSAGE_RETENTION_DAYS = 3650;

/**
 * The configured retention in whole days, or null when it is off: absent, 0,
 * or a value that is not a positive whole number of days up to the maximum
 * (said once, so a typo does not silently delete or silently keep).
 */
export function channelMessageRetentionDays(config: Pick<JarvisConfig, 'conversations'>): number | null {
  const days = config.conversations?.channel_message_retention_days;
  if (days === undefined || days === 0) return null;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_CHANNEL_MESSAGE_RETENTION_DAYS) {
    console.warn(`[Retention] conversations.channel_message_retention_days must be a whole number of days from 1 to ${MAX_CHANNEL_MESSAGE_RETENTION_DAYS}, `
      + 'or 0 to keep messages forever; keeping them.');
    return null;
  }
  return days;
}

/** Delete what is older than the retention, now. Returns how many messages went. */
export function sweepChannelMessages(days: number, now = Date.now()): number {
  return pruneChannelConversationMessages(now - days * DAY_MS, [PEBBLE_CHANNEL]);
}

/**
 * Start the daily sweep when retention is set; do nothing when it is not.
 * Runs a minute after start, then every 24 hours. Returns a stop function, or null
 * when nothing was started.
 */
export function startChannelMessageRetention(
  config: Pick<JarvisConfig, 'conversations'>,
  timers: Timers = { setInterval, clearInterval, setTimeout, clearTimeout },
): (() => void) | null {
  const days = channelMessageRetentionDays(config);
  if (days === null) return null;
  const sweep = () => {
    try {
      const deleted = sweepChannelMessages(days);
      if (deleted > 0) console.log(`[Retention] Deleted ${deleted} channel message(s) older than ${days} days`);
    } catch (err) {
      console.error('[Retention] Channel message sweep failed:', err);
    }
  };
  // The first sweep waits a minute rather than running inside daemon start:
  // the first one after enabling may have years of history to delete.
  const first = timers.setTimeout(sweep, FIRST_SWEEP_DELAY_MS);
  const timer = timers.setInterval(sweep, DAY_MS);
  (first as { unref?: () => void }).unref?.();
  (timer as { unref?: () => void }).unref?.();
  return () => { timers.clearTimeout(first); timers.clearInterval(timer); };
}
