import { comparison, decimal, formatAmount, localMidnight, retryAfterMs, HUBSPOT_429_RETRIES, type Coverage, type Dataset, type ReportRequest } from './weekly-report';
import { QUARTERLY_ACTION, QUARTERLY_ACCOUNTS, QUARTERLY_MANAGED_REFUSAL } from '../report-accounts';
export { QUARTERLY_ACTION, QUARTERLY_ACCOUNTS, QUARTERLY_MANAGED_REFUSAL };

export const QUARTERLY_REQUIRED = ['hubspotConnection', 'hubspotPortalId', 'dealDateProperty', 'dealStageIds'] as const;
/** Quarters are calendar quarters in this zone; the schedule must fire in it too. */
export const QUARTERLY_ZONE = 'Europe/Rome';
/** Bounds on the one complete deal enumeration; reaching either is Unavailable, never partial totals. */
export const QUARTERLY_PAGE_LIMIT = 200, QUARTERLY_ROW_LIMIT = 20000;
type Obj = Record<string, any>;
export interface QuarterlySetup { hubspotConnection: string; hubspotPortalId: string; dealDateProperty: string; dealStageIds: string[]; timezone: 'Europe/Rome' }
const errText = (e: unknown) => String((e as Error).message).replace(/[\x00-\x1f]/g, ' ').slice(0, 250);
function parts(t: number) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: QUARTERLY_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' }).formatToParts(t).map(p => [p.type, p.value]));
}
function currency(v: unknown): string { if (typeof v !== 'string' || !/^[a-zA-Z]{3}$/.test(v)) throw Error('Missing currency'); return v.toUpperCase(); }
function add(t: Dataset['totals'], c: string, amount: bigint) { const old = t[c] ?? { count: 0, amount: '0' }; t[c] = { count: old.count + 1, amount: formatAmount(decimal(old.amount) + amount) }; }
function unavailable(d: Dataset, e: unknown) { d.coverage.status = 'Unavailable'; d.coverage.reason = errText(e); d.coverage.terminal = false; d.totals = {}; delete d.noAmount; }
/** Every page of a HubSpot list endpoint by its opaque paging.next.after cursor, bounded; any doubt about completeness throws. */
async function pages(request: ReportRequest, path: string, coverage: Coverage): Promise<Obj[]> {
  const rows = new Map<string, Obj>(), cursors = new Set<string>(); let cursor: string | undefined;
  for (let page = 0; page < QUARTERLY_PAGE_LIMIT; page++) {
    const data = await request('hubspot', path + (cursor ? '&' + new URLSearchParams({ after: cursor }) : '')); coverage.pages++;
    const batch = data.results; if (!Array.isArray(batch)) throw Error('Malformed result page');
    for (const r of batch) {
      if (!r || typeof r.id !== 'string' || !r.id) throw Error('Missing stable record ID');
      const old = rows.get(r.id); if (old && JSON.stringify(old) !== JSON.stringify(r)) throw Error('Record changed during pagination');
      rows.set(r.id, r);
    }
    coverage.unique = rows.size; if (rows.size > QUARTERLY_ROW_LIMIT) throw Error('Row limit reached; partial totals discarded');
    const next = data.paging?.next?.after;
    if (data.paging?.next != null && next == null) throw Error('HubSpot continuation cursor missing');
    if (next == null) { coverage.terminal = true; return [...rows.values()]; }
    if (!['string', 'number'].includes(typeof next) || !String(next) || cursors.has(String(next))) throw Error('Repeated or invalid cursor');
    cursor = String(next); cursors.add(cursor);
  }
  throw Error('Page limit reached; partial totals discarded');
}
export function quarterlySetup(input: Obj): QuarterlySetup {
  const text = (key: string, pattern: RegExp) => {
    const v = input[key];
    if (typeof v !== 'string' || v.length > 300 || !pattern.test(v)) throw Error('Configure ' + key);
    return v;
  };
  const stages = typeof input.dealStageIds === 'string' ? input.dealStageIds.split(',').map((s: string) => s.trim()) : input.dealStageIds;
  if (!Array.isArray(stages) || !stages.length || stages.length > 100 || stages.some(s => typeof s !== 'string' || !/^[\w-]{1,100}$/.test(s))) throw Error('Select closed deal stage IDs');
  if (input.timezone !== 'Europe/Rome') throw Error('Quarterly reporting uses Europe/Rome');
  return { hubspotConnection: text('hubspotConnection', /^[\w:-]+$/), hubspotPortalId: text('hubspotPortalId', /^\d+$/),
    dealDateProperty: text('dealDateProperty', /^[a-zA-Z][a-zA-Z0-9_]*$/), dealStageIds: [...new Set(stages)], timezone: 'Europe/Rome' };
}
export function reportQuarters(scheduledFor: string) {
  if (typeof scheduledFor !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(scheduledFor) || !Number.isFinite(Date.parse(scheduledFor))) throw Error('A persisted scheduledFor timestamp with timezone is required');
  const p = parts(Date.parse(scheduledFor)), year = Number(p.year), month = Math.floor((Number(p.month) - 1) / 3) * 3;
  return [1, 2].map(n => {
    const start = Date.UTC(year, month - n * 3, 1), end = Date.UTC(year, month - (n - 1) * 3, 1), date = new Date(start);
    return { name: n === 1 ? 'current' : 'prior', label: `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`,
      start: localMidnight(start, QUARTERLY_ZONE), end: localMidnight(end, QUARTERLY_ZONE), localStart: date.toISOString().slice(0, 10), localEnd: new Date(end).toISOString().slice(0, 10) };
  });
}

const QUARTERLY_PATHS = [/^\/account-info\/v3\/details$/, /^\/crm\/v3\/pipelines\/deals$/, /^\/crm\/v3\/properties\/deals\/[a-zA-Z][a-zA-Z0-9_]*$/, /^\/crm\/v3\/objects\/deals$/];
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** Fixed HubSpot GET endpoints only: no body, no redirects, bounded responses, short 429 retries as the weekly report's reads. */
export function quarterlyTransport(token: string, checkpoint: () => void, fetchImpl: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = delay): ReportRequest {
  return async (provider, path, body) => {
    if (provider !== 'hubspot' || body !== undefined) throw Error('Quarterly reports allow HubSpot reads only');
    const u = new URL('https://placeholder.invalid' + path);
    if (!path.startsWith('/') || path.startsWith('//') || u.hash || !QUARTERLY_PATHS.some(p => p.test(u.pathname))) throw Error('Quarterly report endpoint is outside the HubSpot read scope');
    checkpoint();
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await fetchImpl('https://api.hubapi.com' + path, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20000) });
      // A read changes nothing, so a rate-limited one is safe to repeat after a short wait.
      const wait = response.status === 429 && attempt < HUBSPOT_429_RETRIES ? retryAfterMs(response.headers.get('retry-after')) : null;
      if (wait === null) break;
      await response.body?.cancel(); await sleep(wait); checkpoint();
    }
    if (!response.ok) { await response.body?.cancel(); throw Error(`hubspot request failed (HTTP ${response.status})`); }
    const reader = response.body?.getReader(); if (!reader) throw Error('Empty source response');
    let size = 0; const chunks: Uint8Array[] = [];
    for (;;) { const n = await reader.read(); if (n.done) break; size += n.value.length; if (size > 4_000_000) { await reader.cancel(); throw Error('Source response exceeds completeness limit'); } chunks.push(n.value); }
    checkpoint(); const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) throw Error('Malformed provider response');
    return data;
  };
}

/** One complete enumeration feeds both quarters; never aggregates a first-page substitute. */
export async function collectQuarterlyReport(setup: QuarterlySetup, request: ReportRequest, scheduledFor: string, checkpoint: () => void = () => {}) {
  const quarters = reportQuarters(scheduledFor), sourceUrl = `https://app.hubspot.com/contacts/${setup.hubspotPortalId}/objects/0-3/views/all/list`;
  const datasets: Dataset[] = quarters.map(q => ({ coverage: { source: 'hubspot-deals', period: q.name, status: 'Complete', pages: 0, unique: 0, terminal: false, url: sourceUrl }, totals: {} }));
  const read: ReportRequest = async (provider, path, body) => { checkpoint(); const result = await request(provider, path, body); checkpoint(); return result; };
  try {
    const account = await read('hubspot', '/account-info/v3/details');
    if (String(account.portalId) !== setup.hubspotPortalId) throw Error('HubSpot portal mismatch');
    // A single-currency portal often leaves deal_currency_code empty: its deals are in the company currency.
    const companyCurrency = typeof account.companyCurrency === 'string' && /^[a-zA-Z]{3}$/.test(account.companyCurrency) ? account.companyCurrency.toUpperCase() : undefined;
    const property = await read('hubspot', `/crm/v3/properties/deals/${setup.dealDateProperty}`);
    if (property.name !== setup.dealDateProperty || property.type !== 'datetime') throw Error('Select a HubSpot datetime date property');
    const pipelines = await read('hubspot', '/crm/v3/pipelines/deals');
    const stages = pipelines.results?.flatMap((p: Obj) => p.archived ? [] : p.stages ?? []);
    if (!Array.isArray(stages) || setup.dealStageIds.some(id => !stages.some((s: Obj) => s.id === id && !s.archived && [true, 'true'].includes(s.metadata?.isClosed)))) throw Error('Selected stages must be available closed stages');
    // HubSpot BasicApi.getPage documents paging.next.after, not a fixed page count.
    // https://github.hubspot.com/hubspot-api-nodejs/classes/crm_deals.BasicApi.html
    const query = new URLSearchParams({ limit: '100', archived: 'false', properties: ['dealstage', 'amount', 'deal_currency_code', setup.dealDateProperty].join(',') });
    const rows = await pages(read, '/crm/v3/objects/deals?' + query, datasets[0]!.coverage);
    Object.assign(datasets[1]!.coverage, { pages: datasets[0]!.coverage.pages, unique: datasets[0]!.coverage.unique, terminal: true });
    for (const row of rows) {
      if (row.archived === true) continue;
      const p = row.properties;
      if (!p || typeof p.dealstage !== 'string') throw Error('Deal stage missing; coverage cannot be established');
      if (!setup.dealStageIds.includes(p.dealstage)) continue;
      const raw = p[setup.dealDateProperty];
      const date = typeof raw === 'string' && /^\d{13}$/.test(raw) ? Number(raw) : typeof raw === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? Date.parse(raw) : NaN;
      if (!Number.isFinite(date)) throw Error('Selected date missing or ambiguous; quarter membership unknown');
      const index = quarters.findIndex(q => date >= q.start && date < q.end);
      if (index < 0) continue;
      const dataset = datasets[index]!;
      if (dataset.coverage.status === 'Unavailable') continue;
      try {
        const code = p.deal_currency_code;
        // Never assumed: with neither a deal currency nor a known portal company currency the quarter is Unavailable.
        const c = code == null || code === '' ? companyCurrency ?? (() => { throw Error('Deal currency missing and the HubSpot company currency is unknown'); })() : currency(code);
        add(dataset.totals, c, decimal(p.amount));
      }
      catch (e) { unavailable(dataset, e); }
    }
  } catch (e) {
    checkpoint(); // Governance and cancellation must not become ordinary unavailable data.
    for (const dataset of datasets) unavailable(dataset, e);
  }
  const current = datasets[0]!, prior = datasets[1]!, comparisons: Obj[] = [];
  if (datasets.some(d => d.coverage.status === 'Unavailable')) comparisons.push({ status: 'Unavailable', reason: 'At least one quarter is unavailable; comparison N/A' });
  else {
    const currencies = [...new Set([...Object.keys(current.totals), ...Object.keys(prior.totals)])].sort();
    for (const c of currencies) {
      const a = current.totals[c] ?? { count: 0, amount: '0' }, b = prior.totals[c] ?? { count: 0, amount: '0' };
      comparisons.push({ currency: c, current: a, prior: b, amountChange: comparison(decimal(a.amount), decimal(b.amount)),
        countChange: comparison(BigInt(a.count) * 1000000n, BigInt(b.count) * 1000000n) });
    }
    if (!currencies.length) comparisons.push({ status: 'Complete', countCurrent: 0, countPrior: 0, note: 'No activity in either complete quarter; no currency inferred' });
  }
  const partial = datasets.some(d => d.coverage.status === 'Unavailable');
  const title = `HubSpot closed deals: ${quarters[0]!.label} versus ${quarters[1]!.label}`;
  const summary = [title, `Scheduled occurrence: ${scheduledFor}. Calendar quarters in Europe/Rome; end boundaries are exclusive.`,
    ...quarters.map(q => `${q.name}: ${q.label}, ${q.localStart} to ${q.localEnd}`),
    `Selected closed stages: ${setup.dealStageIds.join(', ')}; date property: ${setup.dealDateProperty}. Current nonarchived records, not historical stage snapshots.`,
    'Amounts in original deal currencies; no FX or combined-currency total. Counts and amounts compared separately.',
    ...datasets.flatMap(d => d.coverage.status === 'Unavailable' ? [`${d.coverage.period}: Unavailable: ${d.coverage.reason}`] : Object.keys(d.totals).length ? Object.entries(d.totals).map(([c,t]) => `${d.coverage.period} ${c}: ${t.count} deals, ${t.amount}`) : [`${d.coverage.period}: 0 deals; no currency inferred`]),
    ...comparisons.map(c => c.reason ?? c.note ?? `${c.currency}: amount delta ${c.amountChange.delta}, ${c.amountChange.percentage === null ? c.amountChange.label : c.amountChange.percentage + '%'}; count delta ${c.countChange.delta}, ${c.countChange.percentage === null ? c.countChange.label : c.countChange.percentage + '%'}`),
    ...datasets.map(d => `${d.coverage.period} coverage: ${d.coverage.status}, ${d.coverage.pages} pages, ${d.coverage.unique} unique records, terminal page ${d.coverage.terminal}`), `Source: ${sourceUrl}`].join('\n');
  if (summary.length > 100000) throw Error('Quarterly summary exceeds output limit');
  return { complete: !partial, partial, status: partial ? 'Unavailable' : 'Complete', title, summary, quarters, datasets, comparisons, sourceUrl,
    notificationKey: `quarterly-hubspot:${setup.hubspotPortalId}:${quarters[0]!.label}` };
}
