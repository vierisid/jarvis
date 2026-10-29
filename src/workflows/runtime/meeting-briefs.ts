/** Fixed read-only provider surface. No browser, model, send or mutation endpoint. */
import { createHash } from 'node:crypto';
import { getCronTimezone } from '../../lib/cron-scheduler';

import { MEETING_ACCOUNTS } from '../meeting-accounts';
export { MEETING_ACCOUNTS };
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
const email = (v: unknown, allowBraces = false) => {
  const s = text(v, 'email', 254).toLowerCase();
  // Braces are valid in a local part but would break the Gmail {..} OR group, so only
  // attendee addresses may carry them, and those are kept out of the Gmail query.
  if (!(allowBraces ? /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@/ : /^[a-z0-9.!#$%&'*+\/=?^_`|~-]+@/).test(s)
    || !/@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(s) || s.split('@').length !== 2) throw Error('Invalid email');
  return s;
};
const unsearchable = (address: string) => /[{}]/.test(address);
/** Delivery limit for one brief. Longer briefs are shortened, never dropped. */
export const MEETING_BRIEF_LIMIT = 24_000;
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
const unsetTimezone = (v: RecordValue) => v.timezone === undefined || v.timezone === null || (typeof v.timezone === 'string' && !v.timezone.trim());
/**
 * Whether `setup` (as a run resolved it) is what the saved step configures. A
 * saved step that leaves the timezone empty follows Jarvis's timezone, which
 * is read when the run prepares; a change to it later (during an approval
 * wait) is not a different configuration, so only a timezone the step names
 * itself is compared.
 */
export function meetingSetupMatches(saved: RecordValue, setup: MeetingSetup): boolean {
  let expected: MeetingSetup;
  try { expected = meetingSetup(saved); } catch { return false; }
  const comparable = (s: MeetingSetup) => JSON.stringify(unsetTimezone(saved) ? { ...s, timezone: null } : s);
  return comparable(expected) === comparable(setup);
}
const GMAIL_THREAD_HEADERS = ['From', 'To', 'Cc', 'Subject'];
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
  const external = [...new Set(attendees.filter(a => !a.resource && !a.self && a.responseStatus !== 'declined').map(a => email(a.email, true))
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
  // timeMax is exclusive on start time; +1 ms keeps a start at exactly now+30min in (now, now+30min].
  const events = await pages(cursor => request('calendar', calendarPath(setup) + '?' + query({
    timeMin: new Date(now).toISOString(), timeMax: new Date(now + 30 * 60_000 + 1).toISOString(), singleEvents: 'true', showDeleted: 'false',
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
        if (!/^\d+$/.test(contact.id) || email(contact.properties?.email, true) !== address) throw Error('HubSpot returned an unrelated or malformed contact');
        lines.push(`${address}: ${clean(contact.properties.firstname)} ${clean(contact.properties.lastname)}; company: ${clean(contact.properties.company) || 'not recorded'}; role: ${clean(contact.properties.jobtitle) || 'not recorded'}; stage: ${clean(contact.properties.lifecyclestage) || 'not recorded'}; last contacted: ${clean(contact.properties.notes_last_contacted) || 'not recorded'}.`,
          `https://app.hubspot.com/contacts/${setup.hubspotPortalId}/contact/${contact.id}`);
      }
    }
    lines.push('', `Recent Gmail conversations (${setup.recentDays} days):`);
    const searchable = m.external.filter(e => !unsearchable(e));
    for (const e of m.external.filter(unsearchable)) lines.push(`${clean(e, 254)}: Gmail not searched; the address contains { or }, which a Gmail search cannot express.`);
    const conversations: Conversation[] = [];
    let threadIds: string[] = [], unread = 0;
    if (searchable.length) {
      const addresses = searchable.map(e => `from:"${e}" to:"${e}"`).join(' ');
      const after = Math.floor((now - setup.recentDays * 86400_000) / 1000), before = Math.ceil(now / 1000);
      const threads = await pages(cursor => request('gmail', '/gmail/v1/users/me/threads?' + query({
        q: `{${addresses}} after:${after} before:${before}`, maxResults: '100', includeSpamTrash: 'false', ...(cursor ? { pageToken: cursor } : {}),
      })), 'threads');
      threadIds = [...new Set(threads.map(t => text(t.id, 'thread ID')))];
      if (threadIds.some(id => !/^[a-f0-9]+$/i.test(id))) throw Error('Invalid Gmail thread ID');
      if (!threadIds.length) lines.push('No matching recent conversations.');
    }
    // Gmail lists threads by their newest message, newest first, but a long
    // thread's older messages can be older than a later thread's. So reading
    // stops only once the brief is full and the thread just read is entirely
    // older than the oldest excerpt that would be kept: every later thread is
    // then older still, and is counted as omitted instead of read.
    const headSize = lines.reduce((n, l) => n + l.length + 1, 0);
    const read: { date: number; size: number; t: number; i: number }[] = [];
    let size = headSize;
    for (const [index, id] of threadIds.entries()) {
      // Headers and snippet are all a brief uses: metadata keeps message bodies out
      // of the daemon and long quoted threads under the response size limit.
      const thread = await request('gmail', `/gmail/v1/users/me/threads/${id}?format=metadata&` + GMAIL_THREAD_HEADERS.map(h => `metadataHeaders=${h}`).join('&'));
      if (thread.id !== id || !Array.isArray(thread.messages)) throw Error('Incomplete Gmail thread');
      const excerpts: Excerpt[] = [];
      let newest = -Infinity;
      for (const message of thread.messages) {
        const date = Number(message.internalDate);
        if (!Number.isFinite(date)) throw Error('Missing Gmail message date');
        newest = Math.max(newest, date);
        if (date < now - setup.recentDays * 86400_000 || date > now) continue;
        const headers = message.payload?.headers;
        if (!Array.isArray(headers)) throw Error('Missing Gmail message headers');
        const header = (name: string) => String(headers.find((h: RecordValue) => h.name?.toLowerCase() === name)?.value ?? '');
        const participants = (header('from') + ' ' + header('to') + ' ' + header('cc')).toLowerCase().match(/[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
        if (!participants.some(e => m.external.includes(e))) continue;
        const prefix = `${new Date(date).toISOString()} | ${clean(header('subject'), 200)} | ${clean(header('from'), 254)}: `, snippet = message.snippet;
        excerpts.push({ date, line: max => prefix + clean(snippet, max) });
        const lineSize = prefix.length + clean(snippet).length + 1;
        read.push({ date, size: lineSize, t: conversations.length, i: excerpts.length - 1 }); size += lineSize;
      }
      if (excerpts.length) { conversations.push({ id, excerpts }); size += threadLink(setup.ownerEmail, id).length + 1; }
      if (size > MEETING_BRIEF_LIMIT && index < threadIds.length - 1 && newest < oldestKept(read, conversations, headSize, setup.ownerEmail)) {
        unread = threadIds.length - index - 1; break;
      }
    }
    if (threadIds.length && !conversations.length && !unread) lines.push('No matching recent messages after exact participant and date filtering.');
    const brief = fitBrief(lines, conversations, unread, setup.ownerEmail);
    meetings.push({ eventId: m.eventId, start: m.start, title: m.title, brief, notificationKey, guard });
  }
  const order = (a: { start: string; eventId: string }, b: { start: string; eventId: string }) => a.start.localeCompare(b.start) || a.eventId.localeCompare(b.eventId);
  return { complete: true, meetings: meetings.sort(order) };
}
/**
 * The date of the oldest excerpt fitBrief would keep, dropping oldest first
 * (ties: earlier thread, then earlier message, go first). Ignores the footer
 * lines, so it errs towards keeping more, which only means reading on.
 * +Infinity when not even the newest fits.
 */
function oldestKept(read: { date: number; size: number; t: number; i: number }[], conversations: Conversation[], headSize: number, ownerEmail: string): number {
  const newestFirst = [...read].sort((a, b) => b.date - a.date || b.t - a.t || b.i - a.i);
  const linked = new Set<number>(); let total = headSize, oldest = Infinity;
  for (const e of newestFirst) {
    total += e.size + (linked.has(e.t) ? 0 : threadLink(ownerEmail, conversations[e.t]!.id).length + 1);
    if (total > MEETING_BRIEF_LIMIT) break;
    linked.add(e.t); oldest = e.date;
  }
  return oldest;
}
export type Excerpt = { date: number; line: (max: number) => string };
export type Conversation = { id: string; excerpts: Excerpt[] };
const threadLink = (ownerEmail: string, id: string) => `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(ownerEmail)}#all/${id}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** What was left out, or null when nothing was. */
function omittedLine(dropped: number, droppedThreads: number, unread: number): string | null {
  const parts = [...(dropped ? [`${plural(dropped, 'older message excerpt')} from ${plural(droppedThreads, 'conversation')}`] : []),
    ...(unread ? [`${plural(unread, 'older conversation')} not read`] : [])];
  return parts.length ? `${parts.join(' and ')} omitted to fit the ${MEETING_BRIEF_LIMIT.toLocaleString('en-US')} character brief limit; open the meeting or Gmail for the full history.` : null;
}
const SHORTENED = 'Remaining snippet shortened to fit the brief limit.';
const SNIPPETS = 'Email excerpts are snippets; open the source links for full conversations.';
/**
 * Render a brief within MEETING_BRIEF_LIMIT, deterministically. Drops the oldest
 * excerpts first (keeping the newest), then shortens the newest snippet, then drops
 * it, and only as a last resort cuts the fixed context. Always says what was left out
 * (`unread` counts listed conversations that were never read because the brief was full).
 * Linear in the number of excerpts: sizes are kept as running totals and the brief is
 * rendered once.
 */
export function fitBrief(head: string[], conversations: Conversation[], unread: number, ownerEmail: string, limit = MEETING_BRIEF_LIMIT): string {
  const all = conversations.flatMap((c, t) => c.excerpts.map((e, i) => ({ date: e.date, line: e.line, text: e.line(1000), t, i })));
  // Oldest first; ties broken by thread then message order so the result never depends on timing.
  const byAge = [...all].sort((a, b) => a.date - b.date || a.t - b.t || a.i - b.i);
  const links = conversations.map(c => threadLink(ownerEmail, c.id));
  const kept = conversations.map(c => c.excerpts.length);
  const dropped = new Set<typeof all[number]>();
  let droppedThreads = 0, max = 1000;
  // Joined length of the variable part: every kept excerpt and each link with a kept excerpt, one newline each.
  let body = all.reduce((n, e) => n + e.text.length + 1, 0) + links.reduce((n, l, t) => n + (kept[t] ? l.length + 1 : 0), 0);
  const headSize = head.reduce((n, l) => n + l.length + 1, 0);
  const length = () => {
    const omitted = omittedLine(dropped.size, droppedThreads, unread);
    return headSize + body + (omitted ? omitted.length + 1 : 0) + (max < 1000 ? SHORTENED.length + 1 : 0) + SNIPPETS.length;
  };
  const drop = (e: typeof all[number]) => {
    dropped.add(e); body -= (max < 1000 && e === byAge.at(-1) ? e.line(max) : e.text).length + 1;
    // The omitted line counts every conversation that lost an excerpt; a link goes with its last one.
    if (kept[e.t] === conversations[e.t]!.excerpts.length) droppedThreads++;
    if (--kept[e.t]! === 0) body -= links[e.t]!.length + 1;
  };
  const render = () => {
    // `all` is in thread order, so each thread's kept excerpts are followed by its link in one pass.
    const lines = [...head]; let thread = -1;
    for (const e of all) {
      if (dropped.has(e)) continue;
      if (e.t !== thread) { if (thread >= 0) lines.push(links[thread]!); thread = e.t; }
      lines.push(max < 1000 ? e.line(max) : e.text);
    }
    if (thread >= 0) lines.push(links[thread]!);
    const omitted = omittedLine(dropped.size, droppedThreads, unread);
    if (omitted) lines.push(omitted);
    if (max < 1000) lines.push(SHORTENED);
    lines.push(SNIPPETS);
    return lines.join('\n');
  };
  for (const e of byAge.slice(0, -1)) { if (length() <= limit) break; drop(e); }
  if (length() > limit && byAge.length) {
    const newest = byAge.at(-1)!;
    body += newest.line(100).length - newest.text.length; max = 100;
    if (length() > limit) { drop(newest); max = 1000; }
  }
  const brief = render();
  if (brief.length <= limit) return brief;
  const notice = `\nBrief cut at the ${MEETING_BRIEF_LIMIT.toLocaleString('en-US')} character limit; open the meeting, HubSpot or Gmail for the full context.`;
  return brief.slice(0, limit - notice.length) + notice;
}
export async function meetingStillCurrent(guard: MeetingGuard, request: MeetingRequest, now = Date.now()): Promise<boolean> {
  const event = await request('calendar', `${calendarPath(guard.setup)}/${encodeURIComponent(guard.eventId)}`);
  const current = eventMeeting(event, guard.setup, now);
  return !!current && current.eventId === guard.eventId && current.start === guard.start && current.fingerprint === guard.fingerprint;
}

/** Thread list, or a single thread read as metadata with only the brief's headers (never full bodies). */
function gmailReadAllowed(path: string): boolean {
  const match = /^\/gmail\/v1\/users\/me\/threads(\/[a-f0-9]+)?\?([^#]*)$/.exec(path);
  if (!match) return false;
  const params = [...new URLSearchParams(match[2])];
  if (!match[1]) return params.every(([k]) => ['q', 'maxResults', 'includeSpamTrash', 'pageToken'].includes(k));
  const headers = params.filter(([k]) => k === 'metadataHeaders').map(([, v]) => v);
  return params.filter(([k]) => k === 'format').length === 1 && params.some(([k, v]) => k === 'format' && v === 'metadata')
    && params.every(([k]) => k === 'format' || k === 'metadataHeaders')
    && headers.length > 0 && headers.every(h => GMAIL_THREAD_HEADERS.includes(h));
}
/** Closed allowlist applies even to the injectable fixture transport. */
export function meetingTransport(tokens: Partial<Record<RequestProvider, string>>, checkpoint: () => void, fetchImpl: typeof fetch = fetch): MeetingRequest {
  return async (provider, path, body) => {
    const allowed = provider === 'calendar' ? /^\/calendar\/v3\/calendars\/[^/?]+\/events(?:\/[^/?]+)?(?:\?|$)/.test(path) && !body
      : provider === 'gmail' ? gmailReadAllowed(path) && !body
      : path === '/crm/v3/objects/contacts/search' && !!body;
    if (!allowed) throw Error('Meeting preparation only permits declared read endpoints');
    if (typeof tokens[provider] !== 'string') throw Error(`No ${provider} account was resolved for this read`);
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
