import { cronWallTimeKey, getCronTimezone, type CronOccurrence } from '../../lib/cron-scheduler';

/** Persist this at trigger admission. Workers must not derive dates from their clock. */
export function scheduleTriggerPayload(input: Record<string, unknown>, occurrence?: CronOccurrence, firedAt = Date.now()) {
  const at = occurrence?.at ?? firedAt;
  const timezone = typeof input.timezone === 'string' ? input.timezone : getCronTimezone();
  const occurrenceKey = occurrence?.key ?? cronWallTimeKey(new Date(at), timezone);
  const calendarKey = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(occurrenceKey)
    ? occurrenceKey : cronWallTimeKey(new Date(at), timezone);
  return { ...input, firedAt, scheduledFor: new Date(at).toISOString(), occurrenceKey,
    scheduledDate: calendarKey.slice(0, 10), scheduledMonth: calendarKey.slice(0, 7) };
}
