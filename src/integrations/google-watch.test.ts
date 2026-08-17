import { describe, expect, test } from 'bun:test';
import {
  CALENDAR_WATCH_FALLBACK_MS,
  GMAIL_WATCH_RENEW_MS,
  RENEW_MARGIN_MS,
  renewDelayMs,
} from './google-watch.ts';

/**
 * Renewal arithmetic for the Google push watches (GOOGLE.md "Push bridging").
 *
 * Worth its own tests because every mistake here is invisible: a delay that is
 * too long leaves a gap where Google has stopped pushing and nobody notices
 * (polling still works, so nothing looks broken), and a delay of zero or less
 * turns the renewal into a spin against Google's API.
 */
describe('renewDelayMs', () => {
  const now = 1_760_000_000_000;

  test('no stated expiry falls back to the caller default', () => {
    expect(renewDelayMs(undefined, now, GMAIL_WATCH_RENEW_MS)).toBe(GMAIL_WATCH_RENEW_MS);
    // Google returns expiration as a string; a non-numeric one must not become
    // NaN and schedule a timer that never fires.
    expect(renewDelayMs(Number.NaN, now, CALENDAR_WATCH_FALLBACK_MS)).toBe(
      CALENDAR_WATCH_FALLBACK_MS,
    );
  });

  test('renews a margin BEFORE the stated expiry', () => {
    // Expires in 6 hours -> renew in 5, so a slow renewal is not a gap in
    // coverage.
    const sixHours = 6 * 60 * 60 * 1000;
    expect(renewDelayMs(now + sixHours, now, CALENDAR_WATCH_FALLBACK_MS)).toBe(
      sixHours - RENEW_MARGIN_MS,
    );
  });

  test('an expiry already past, or inside the margin, still waits a full minute', () => {
    // A zero or negative delay would spin: setTimeout fires immediately, the
    // renewal fails or returns the same expiry, and it fires again.
    expect(renewDelayMs(now - 1000, now, CALENDAR_WATCH_FALLBACK_MS)).toBe(60_000);
    expect(renewDelayMs(now + 1000, now, CALENDAR_WATCH_FALLBACK_MS)).toBe(60_000);
    expect(renewDelayMs(now + RENEW_MARGIN_MS, now, CALENDAR_WATCH_FALLBACK_MS)).toBe(60_000);
  });

  test('a far-future expiry is capped at the fallback interval', () => {
    // Gmail's watch lasts 7 days but Google asks for a DAILY re-arm; honouring
    // the stated expiry literally would re-arm weekly and race it.
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(renewDelayMs(now + sevenDays, now, GMAIL_WATCH_RENEW_MS)).toBe(GMAIL_WATCH_RENEW_MS);
  });
});
