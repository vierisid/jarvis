import { keys, number, record, timezone, invalid } from '../goals/validation';

export interface OutcomeWindow { start: number; end: number; timezone: string }
const DAY = 86_400_000;
export function outcomeWindow(raw: unknown): OutcomeWindow {
  const q = record(raw, 'window'); keys(q, ['start', 'end', 'timezone'], 'window');
  const start = number(q.start, 'start', 0, 4_102_444_800_000, true);
  const end = number(q.end, 'end', 0, 4_102_444_800_000, true);
  if (end <= start || end - start > 32 * DAY) invalid('window', 'must span more than zero and at most 32 days');
  return { start, end, timezone: timezone(q.timezone) };
}
/** Find calendar boundaries by local date, including 23/25-hour DST days and skipped dates. */
export function outcomeCalendar(at: number, zone: string) {
  number(at, 'at', 0, 4_102_444_800_000 - 8 * DAY, true); timezone(zone);
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateAt = (instant: number) => {
    const parts = Object.fromEntries(format.formatToParts(instant).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const today = dateAt(at), nominal = Date.parse(`${today}T00:00:00Z`);
  const dayName = (t: number) => new Date(t).toISOString().slice(0, 10);
  const boundary = (date: string) => {
    const anchor = Date.parse(`${date}T00:00:00Z`); let low = anchor - 2 * DAY, high = anchor + 2 * DAY;
    while (low < high) { const middle = Math.floor((low + high) / 2); if (dateAt(middle) < date) low = middle + 1; else high = middle; }
    return low;
  };
  const monday = nominal - ((new Date(nominal).getUTCDay() + 6) % 7) * DAY;
  const days = Array.from({ length: 7 }, (_, i) => ({ id: dayName(monday + i * DAY),
    start: boundary(dayName(monday + i * DAY)), end: boundary(dayName(monday + (i + 1) * DAY)), timezone: zone }));
  return { date: today, today: { start: boundary(today), end: boundary(dayName(nominal + DAY)), timezone: zone },
    week: { start: days[0]!.start, end: days[6]!.end, timezone: zone }, days };
}
