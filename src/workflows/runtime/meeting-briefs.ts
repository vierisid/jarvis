/** Fixed read-only provider surface. No browser, model, send or mutation endpoint. */
import { createHash } from 'node:crypto';
import { getCronTimezone } from '../../lib/cron-scheduler';

export const MEETING_ACCOUNTS = {
  calendarConnection: '@activepieces/piece-google-calendar',
  gmailConnection: '@activepieces/piece-gmail',
  hubspotConnection: '@activepieces/piece-hubspot',
} as const;
export interface MeetingSetup {
  calendarConnection: string; gmailConnection: string; hubspotConnection: string;
  calendarId: string; ownerEmail: string; internalDomains: string[];
  hubspotPortalId: string; recentDays: number; timezone: string;
}
export interface MeetingGuard { setup: MeetingSetup; eventId: string; start: string; fingerprint: string }
export interface MeetingBrief { eventId: string; start: string; title: string; brief: string; notificationKey: string; guard: MeetingGuard }
type RecordValue = Record<string, any>;
type RequestProvider = 'calendar' | 'gmail' | 'hubspot';
export type MeetingRequest = (provider: RequestProvider, path: string, body?: RecordValue) => Promise<RecordValue>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (v: unknown, label: string, max = 512): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\r\n\x00]/.test(v)) throw Error(`Invalid or missing ${label}`);
  return v.trim();
};
const email = (v: unknown) => {
  const s = text(v, 'email', 254).toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(s)) throw Error('Invalid email');
  return s;
};
export function meetingSetup(v: RecordValue): MeetingSetup {
  const domains = typeof v.internalDomains === 'string' ? v.internalDomains.split(',') : v.internalDomains;
  if (!Array.isArray(domains) || domains.length < 1 || domains.length > 100) throw Error('Configure internal domains explicitly');
  const internalDomains = [...new Set(domains.map(d => text(d, 'internal domain', 253).toLowerCase()))].sort();
  if (internalDomains.some(d => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(d))) throw Error('Invalid internal domain');
  const recentDays = v.recentDays ?? 30;
  if (!Number.isInteger(recentDays) || recentDays < 1 || recentDays > 365) throw Error('Recent days must be 1-365');
  // Empty means Jarvis's configured timezone (the one schedules use), else the machine's.
  const configured = typeof v.timezone === 'string' ? v.timezone.trim() : v.timezone;
  const timezone = text(configured === undefined || configured === null || configured === ''
    ? getCronTimezone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone : configured, 'timezone');
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  const hubspotPortalId = text(v.hubspotPortalId, 'HubSpot portal ID');
  if (!/^\d+$/.test(hubspotPortalId)) throw Error('HubSpot portal ID must be numeric');
  const account = (key: keyof typeof MEETING_ACCOUNTS) => {
    const id = text(v[key], key, 256);
    if (!/^[\w:-]+$/.test(id)) throw Error('Select a saved account reference, never credentials or an expression');
    return id;
  };
  return { calendarConnection: account('calendarConnection'), gmailConnection: account('gmailConnection'), hubspotConnection: account('hubspotConnection'),
    calendarId: text(v.calendarId, 'calendar ID'), ownerEmail: email(v.ownerEmail), internalDomains, hubspotPortalId, recentDays, timezone };
}
const query = (params: Record<string, string>) => new URLSearchParams(params).toString();
const calendarPath = (s: MeetingSetup) => `/calendar/v3/calendars/${encodeURIComponent(s.calendarId)}/events`;
const timestamp = (v: unknown) => {
  if (typeof v !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v) || !Number.isFinite(Date.parse(v))) throw Error('Event start must include a timezone');
  return new Date(v).toISOString();
};
function eventMeeting(event: RecordValue, setup: MeetingSetup, now: number) {
  if (event.status === 'cancelled' || event.start?.date || event.eventType && !['default', 'fromGmail'].includes(event.eventType)) return null;
  if (event.attendeesOmitted === true) throw Error('Calendar omitted attendees; cannot classify external meetings');
  const start = timestamp(event.start?.dateTime), at = Date.parse(start);
  if (at <= now || at > now + 30 * 60_000) return null;
  if (event.attendees !== undefined && !Array.isArray(event.attendees)) throw Error('Invalid attendee list');
  const attendees: RecordValue[] = event.attendees ?? [];
  if (attendees.some(a => (a.self === true || a.email?.toLowerCase() === setup.ownerEmail) && a.responseStatus === 'declined')) return null;
  const external = [...new Set(attendees.filter(a => !a.resource && !a.self && a.responseStatus !== 'declined').map(a => email(a.email))
    .filter(e => e !== setup.ownerEmail && !setup.internalDomains.includes(e.split('@')[1]!)))].sort();
  if (!external.length) return null;
  if (external.length > 50) throw Error('Meeting exceeds 50 external attendees; no partial brief produced');
  const eventId = text(event.id, 'event ID'), title = text(event.summary ?? 'Untitled meeting', 'meeting title', 2000);
  const source = new URL(text(event.htmlLink, 'calendar source'));
  if (source.protocol !== 'https:' || !['calendar.google.com', 'www.google.com'].includes(source.hostname)) throw Error('Invalid calendar source link');
  const fingerprint = hash([eventId, start, external, title, event.updated ?? null]);
  return { eventId, start, title, external, source: source.href, fingerprint };
}
export function meetingNotificationKey(guard: MeetingGuard): string {
  return 'meeting-brief:' + hash([guard.setup.calendarConnection, guard.setup.calendarId, guard.eventId, timestamp(guard.start)]);
}
export function parseMeetingGuard(raw: unknown): MeetingGuard {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid meeting guard');
  const v = raw as RecordValue;
  if (!/^[a-f0-9]{64}$/.test(v.fingerprint)) throw Error('Invalid meeting fingerprint');
  return { setup: meetingSetup(v.setup ?? {}), eventId: text(v.eventId, 'event ID'), start: timestamp(v.start), fingerprint: v.fingerprint };
}
/** Exhaust continuation tokens. Limit/cycle/malformed responses fail, never claim completeness. */
async function pages(load: (cursor?: string) => Promise<RecordValue>, field: string, hubspot = false): Promise<RecordValue[]> {
  const result: RecordValue[] = [], seen = new Set<string>(); let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const data = await load(cursor);
    const rows = data[field] ?? (hubspot ? null : []);
    if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object')) throw Error('Invalid provider result page');
    result.push(...rows);
    if (result.length > 5000) throw Error('Provider result limit exceeded; completeness unavailable');
    const next = hubspot ? data.paging?.next?.after : data.nextPageToken;
    if (next === undefined || next === null || next === '') return result;
    if (!['string', 'number'].includes(typeof next) || seen.has(String(next))) throw Error('Invalid or repeated pagination cursor');
    cursor = String(next); seen.add(cursor);
  }
  throw Error('Pagination limit exceeded; completeness unavailable');
}
const clean = (v: unknown, max = 1000) => String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/[\[\]<>]/g, '').slice(0, max);
export async function prepareMeetingBriefs(setup: MeetingSetup, request: MeetingRequest, now = Date.now()): Promise<{ complete: true; meetings: MeetingBrief[] }> {
  const events = await pages(cursor => request('calendar', calendarPath(setup) + '?' + query({
    timeMin: new Date(now).toISOString(), timeMax: new Date(now + 30 * 60_000).toISOString(), singleEvents: 'true', showDeleted: 'false',
    maxResults: '2500', orderBy: 'startTime', timeZone: setup.timezone, ...(cursor ? { pageToken: cursor } : {}),
  })), 'items');
  const meetings: MeetingBrief[] = [], seen = new Set<string>();
  for (const event of events) {
    const m = eventMeeting(event, setup, now); if (!m) continue;
    const guard: MeetingGuard = { setup, eventId: m.eventId, start: m.start, fingerprint: m.fingerprint };
    const notificationKey = meetingNotificationKey(guard); if (seen.has(notificationKey)) continue; seen.add(notificationKey);
    const lines = [`${clean(m.title)} | ${new Date(m.start).toLocaleString('en-GB', { timeZone: setup.timezone })} (${setup.timezone})`,
      `Calendar: ${m.source}`, `External attendees: ${m.external.join(', ')}`, '', 'HubSpot context:'];
    for (const address of m.external) {
      const contacts = await pages(cursor => request('hubspot', '/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: address }] }],
        properties: ['email', 'firstname', 'lastname', 'company', 'jobtitle', 'lifecyclestage', 'notes_last_contacted'], limit: 200, ...(cursor ? { after: cursor } : {}),
      }), 'results', true);
      if (!contacts.length) lines.push(`${address}: no matching contact.`);
      for (const contact of contacts) {
        if (!/^\d+$/.test(contact.id) || email(contact.properties?.email) !== address) throw Error('HubSpot returned an unrelated or malformed contact');
        lines.push(`${address}: ${clean(contact.properties.firstname)} ${clean(contact.properties.lastname)}; company: ${clean(contact.properties.company) || 'not recorded'}; role: ${clean(contact.properties.jobtitle) || 'not recorded'}; stage: ${clean(contact.properties.lifecyclestage) || 'not recorded'}; last contacted: ${clean(contact.properties.notes_last_contacted) || 'not recorded'}.`,
          `https://app.hubspot.com/contacts/${setup.hubspotPortalId}/contact/${contact.id}`);
      }
    }
    lines.push('', `Recent Gmail conversations (${setup.recentDays} days):`);
    const addresses = m.external.map(e => `from:"${e}" to:"${e}"`).join(' ');
    const after = Math.floor((now - setup.recentDays * 86400_000) / 1000), before = Math.ceil(now / 1000);
    const threads = await pages(cursor => request('gmail', '/gmail/v1/users/me/threads?' + query({
      q: `{${addresses}} after:${after} before:${before}`, maxResults: '100', includeSpamTrash: 'false', ...(cursor ? { pageToken: cursor } : {}),
    })), 'threads');
    const threadIds = [...new Set(threads.map(t => text(t.id, 'thread ID')))];
    if (!threadIds.length) lines.push('No matching recent conversations.');
    let conversationCount = 0;
    for (const id of threadIds) {
      if (!/^[a-f0-9]+$/i.test(id)) throw Error('Invalid Gmail thread ID');
      const thread = await request('gmail', `/gmail/v1/users/me/threads/${id}?format=full`);
      if (thread.id !== id || !Array.isArray(thread.messages)) throw Error('Incomplete Gmail thread');
      let count = 0;
      for (const message of thread.messages) {
        const date = Number(message.internalDate);
        if (!Number.isFinite(date)) throw Error('Missing Gmail message date');
        if (date < now - setup.recentDays * 86400_000 || date > now) continue;
        const headers = message.payload?.headers;
        if (!Array.isArray(headers)) throw Error('Missing Gmail message headers');
        const header = (name: string) => String(headers.find((h: RecordValue) => h.name?.toLowerCase() === name)?.value ?? '');
        const participants = (header('from') + ' ' + header('to') + ' ' + header('cc')).toLowerCase().match(/[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
        if (!participants.some(e => m.external.includes(e))) continue;
        count++;
        lines.push(`${new Date(date).toISOString()} | ${clean(header('subject'), 200)} | ${clean(header('from'), 254)}: ${clean(message.snippet)}`);
      }
      conversationCount += count;
      if (count) lines.push(`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(setup.ownerEmail)}#all/${id}`);
    }
    if (threadIds.length && !conversationCount) lines.push('No matching recent messages after exact participant and date filtering.');
    lines.push('Email excerpts are snippets; open the source links for full conversations.');
    const brief = lines.join('\n');
    if (brief.length > 24_000) throw Error('Brief exceeds delivery limit; narrow the recent history window');
    meetings.push({ eventId: m.eventId, start: m.start, title: m.title, brief, notificationKey, guard });
  }
  return { complete: true, meetings: meetings.sort((a, b) => a.start.localeCompare(b.start) || a.eventId.localeCompare(b.eventId)) };
}
export async function meetingStillCurrent(guard: MeetingGuard, request: MeetingRequest, now = Date.now()): Promise<boolean> {
  const event = await request('calendar', `${calendarPath(guard.setup)}/${encodeURIComponent(guard.eventId)}`);
  const current = eventMeeting(event, guard.setup, now);
  return !!current && current.eventId === guard.eventId && current.start === guard.start && current.fingerprint === guard.fingerprint;
}

/** Closed allowlist applies even to the injectable fixture transport. */
export function meetingTransport(tokens: Record<RequestProvider, string>, checkpoint: () => void, fetchImpl: typeof fetch = fetch): MeetingRequest {
  return async (provider, path, body) => {
    const allowed = provider === 'calendar' ? /^\/calendar\/v3\/calendars\/[^/?]+\/events(?:\/[^/?]+)?(?:\?|$)/.test(path) && !body
      : provider === 'gmail' ? /^\/gmail\/v1\/users\/me\/threads(?:\/[a-f0-9]+)?\?/.test(path) && !body
      : path === '/crm/v3/objects/contacts/search' && !!body;
    if (!allowed) throw Error('Meeting preparation only permits declared read endpoints');
    const host = provider === 'calendar' ? 'https://www.googleapis.com' : provider === 'gmail' ? 'https://gmail.googleapis.com' : 'https://api.hubapi.com';
    checkpoint();
    const response = await fetchImpl(host + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tokens[provider]}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (provider === 'calendar' && /\/events\/[^/?]+(?:\?|$)/.test(path) && [404,410].includes(response.status)) {
      await response.body?.cancel(); return {status:'cancelled'};
    }
    if (!response.ok) { await response.body?.cancel(); throw Error(`${provider} read failed (HTTP ${response.status}); no complete brief available`); }
    const reader = response.body?.getReader(); if (!reader) throw Error('Empty provider response');
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 2_000_000) { await reader.cancel(); throw Error('Provider response exceeds limit'); } chunks.push(r.value); }
    checkpoint();
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) throw Error('Invalid provider response');
    return data;
  };
}
