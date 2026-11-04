import { comparison, decimal, formatAmount, localMidnight, retryAfterMs, searchDeals, validSearchBody, HUBSPOT_429_RETRIES, HUBSPOT_SEARCH_PATH, HUBSPOT_SORTS, SOURCE_READ_BUDGET_MS, sourceBudgetText, type Dataset, type ReportRequest } from './weekly-report';
import { QUARTERLY_ACTION, QUARTERLY_ACCOUNTS, QUARTERLY_MANAGED_REFUSAL } from '../report-accounts';
export { QUARTERLY_ACTION, QUARTERLY_ACCOUNTS, QUARTERLY_MANAGED_REFUSAL };

export const QUARTERLY_REQUIRED = ['hubspotConnection', 'hubspotPortalId', 'dealDateProperty', 'dealStageIds'] as const;
/** Quarters are calendar quarters in this zone; the schedule must fire in it too. */
export const QUARTERLY_ZONE = 'Europe/Rome';
/** The deal stage IDs quarterly setup accepts; the search body is held to the same shape. */
const STAGE_ID = /^[\w-]{1,100}$/;
type Obj = Record<string, any>;
export interface QuarterlySetup { hubspotConnection: string; hubspotPortalId: string; dealDateProperty: string; dealStageIds: string[]; timezone: 'Europe/Rome' }
const errText = (e: unknown) => String((e as Error).message).replace(/[\x00-\x1f]/g, ' ').slice(0, 250);
function parts(t: number) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: QUARTERLY_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' }).formatToParts(t).map(p => [p.type, p.value]));
}
function currency(v: unknown): string { if (typeof v !== 'string' || !/^[a-zA-Z]{3}$/.test(v)) throw Error('Missing currency'); return v.toUpperCase(); }
function add(t: Dataset['totals'], c: string, amount: bigint) { const old = t[c] ?? { count: 0, amount: '0' }; t[c] = { count: old.count + 1, amount: formatAmount(decimal(old.amount) + amount) }; }
function unavailable(d: Dataset, e: unknown) { d.coverage.status = 'Unavailable'; d.coverage.reason = errText(e); d.coverage.terminal = false; d.totals = {}; delete d.noAmount; }
export function quarterlySetup(input: Obj): QuarterlySetup {
  const text = (key: string, pattern: RegExp) => {
    const v = input[key];
    if (typeof v !== 'string' || v.length > 300 || !pattern.test(v)) throw Error('Configure ' + key);
    return v;
  };
  const stages = typeof input.dealStageIds === 'string' ? input.dealStageIds.split(',').map((s: string) => s.trim()) : input.dealStageIds;
  if (!Array.isArray(stages) || !stages.length || stages.length > 100 || stages.some(s => typeof s !== 'string' || !STAGE_ID.test(s))) throw Error('Select closed deal stage IDs');
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

/** Closed deals in the selected stages that have no value in the date property: only the count is read. */
export function missingDateSearchBody(setup: Pick<QuarterlySetup, 'dealDateProperty' | 'dealStageIds'>): Obj {
  return { filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'IN', values: setup.dealStageIds },
    { propertyName: setup.dealDateProperty, operator: 'NOT_HAS_PROPERTY' }] }], properties: ['dealstage'], sorts: HUBSPOT_SORTS, limit: 1 };
}
const keys = (o: unknown) => o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).sort().join() : '';
/** Exactly the missing-date count search, for these setup shapes. */
function validMissingDateBody(b: unknown): boolean {
  const o = b as Obj;
  if (keys(o) !== 'filterGroups,limit,properties,sorts' || !Array.isArray(o.filterGroups) || o.filterGroups.length !== 1 || keys(o.filterGroups[0]) !== 'filters') return false;
  const f = o.filterGroups[0].filters; if (!Array.isArray(f) || f.length !== 2) return false;
  const [stage, date] = f;
  if (keys(stage) !== 'operator,propertyName,values' || stage.propertyName !== 'dealstage' || stage.operator !== 'IN' || !Array.isArray(stage.values)
    || !stage.values.length || stage.values.length > 100 || !stage.values.every((v: unknown) => typeof v === 'string' && STAGE_ID.test(v))) return false;
  if (keys(date) !== 'operator,propertyName' || date.operator !== 'NOT_HAS_PROPERTY' || typeof date.propertyName !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(date.propertyName)) return false;
  return JSON.stringify(o.properties) === '["dealstage"]' && JSON.stringify(o.sorts) === JSON.stringify(HUBSPOT_SORTS) && o.limit === 1;
}
const QUARTERLY_PATHS = [/^\/account-info\/v3\/details$/, /^\/crm\/v3\/pipelines\/deals$/, /^\/crm\/v3\/properties\/deals\/[a-zA-Z][a-zA-Z0-9_]*$/];
/** HubSpot limits search to five requests per second per account; this keeps one report under it, as the weekly report does. */
export const QUARTERLY_SEARCH_INTERVAL_MS = 250;
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** Fixed HubSpot GET endpoints plus exactly the deal search the report builds: no other body, no redirects, bounded
 * responses, paced searches and short 429 retries as the weekly report's reads. Search changes nothing in HubSpot. */
export function quarterlyTransport(token: string, checkpoint: () => void, fetchImpl: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = delay,
  searchIntervalMs = QUARTERLY_SEARCH_INTERVAL_MS): ReportRequest {
  let lastSearch = 0;
  return async (provider, path, body) => {
    if (provider !== 'hubspot') throw Error('Quarterly reports allow HubSpot reads only');
    const u = new URL('https://placeholder.invalid' + path);
    if (!path.startsWith('/') || path.startsWith('//') || u.hash) throw Error('Quarterly report endpoint is outside the HubSpot read scope');
    const search = u.pathname === HUBSPOT_SEARCH_PATH && !u.search && body !== undefined && (validSearchBody(body, STAGE_ID) || validMissingDateBody(body));
    const read = body === undefined && QUARTERLY_PATHS.some(p => p.test(u.pathname));
    if (!search && !read) throw Error(body === undefined ? 'Quarterly report endpoint is outside the HubSpot read scope' : 'Quarterly reports allow HubSpot reads only');
    checkpoint();
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      if (search) { const wait = lastSearch + searchIntervalMs - Date.now(); if (wait > 0) { await sleep(wait); checkpoint(); } lastSearch = Date.now(); }
      response = await fetchImpl('https://api.hubapi.com' + path, { method: search ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(search ? { 'Content-Type': 'application/json' } : {}) },
        ...(search ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(20000) });
      // A read or search changes nothing, so a rate-limited one is safe to repeat after a short wait.
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

/** Each quarter is searched for its own closed deals (#1244), so the portal's total deal count does not matter.
 * A window HubSpot search cannot list completely is split; a quarter that still cannot be read completely, within
 * the request, deal and time budgets, is Unavailable, never partial. */
export async function collectQuarterlyReport(setup: QuarterlySetup, source: ReportRequest, scheduledFor: string, checkpoint: () => void = () => {}, clock: () => number = Date.now) {
  const quarters = reportQuarters(scheduledFor), sourceUrl = `https://app.hubspot.com/contacts/${setup.hubspotPortalId}/objects/0-3/views/all/list`;
  const datasets: Dataset[] = quarters.map(q => ({ coverage: { source: 'hubspot-deals', period: q.name, status: 'Complete', pages: 0, unique: 0, terminal: false, url: sourceUrl }, totals: {} }));
  const deadline = clock() + SOURCE_READ_BUDGET_MS;
  // No source request starts after the budget; a quarter still being read is Unavailable, never partial.
  const read: ReportRequest = async (provider, path, body) => {
    checkpoint();
    if (clock() >= deadline) throw Error(`The ${sourceBudgetText} ran out before this quarter was complete; partial totals discarded`);
    const result = await source(provider, path, body); checkpoint(); return result;
  };
  let companyCurrency: string | undefined;
  try {
    const account = await read('hubspot', '/account-info/v3/details');
    if (String(account.portalId) !== setup.hubspotPortalId) throw Error('HubSpot portal mismatch');
    // A single-currency portal often leaves deal_currency_code empty: its deals are in the company currency.
    companyCurrency = typeof account.companyCurrency === 'string' && /^[a-zA-Z]{3}$/.test(account.companyCurrency) ? account.companyCurrency.toUpperCase() : undefined;
    const property = await read('hubspot', `/crm/v3/properties/deals/${setup.dealDateProperty}`);
    if (property.name !== setup.dealDateProperty || property.type !== 'datetime') throw Error('Select a HubSpot datetime date property');
    const pipelines = await read('hubspot', '/crm/v3/pipelines/deals');
    const stages = pipelines.results?.flatMap((p: Obj) => p.archived ? [] : p.stages ?? []);
    if (!Array.isArray(stages) || setup.dealStageIds.some(id => !stages.some((s: Obj) => s.id === id && !s.archived && [true, 'true'].includes(s.metadata?.isClosed)))) throw Error('Selected stages must be available closed stages');
    // A date-filtered search cannot return a selected deal with no date, so its quarter is unknown: ask for those directly.
    const undated = await read('hubspot', HUBSPOT_SEARCH_PATH, missingDateSearchBody(setup));
    if (!Number.isSafeInteger(undated.total) || undated.total < 0) throw Error('HubSpot search total missing');
    if (undated.total > 0) throw Error(`Selected date missing on ${undated.total} closed deal${undated.total === 1 ? '' : 's'}; quarter membership unknown`);
  } catch (e) {
    checkpoint(); // Governance and cancellation must not become ordinary unavailable data.
    for (const dataset of datasets) unavailable(dataset, e);
  }
  for (const [index, quarter] of quarters.entries()) {
    const dataset = datasets[index]!;
    if (dataset.coverage.status === 'Unavailable') continue;
    try {
      // Search is filtered to the quarter's dates and the selected stages; it never returns archived deals. A second
      // complete read must return the same deals, unchanged, as the weekly report requires.
      const rows = await searchDeals(read, setup, quarter.start, quarter.end, dataset.coverage, 'quarter');
      const confirm = await searchDeals(read, setup, quarter.start, quarter.end, dataset.coverage, 'quarter');
      if (confirm.size !== rows.size || [...rows].some(([id, r]) => JSON.stringify(confirm.get(id)) !== JSON.stringify(r))) throw Error('Deals changed between the two complete reads; partial totals discarded');
      dataset.coverage.unique = rows.size; dataset.coverage.terminal = true;
      for (const row of rows.values()) {
        const p = row.properties;
        const code = p.deal_currency_code;
        // Never assumed: with neither a deal currency nor a known portal company currency the quarter is Unavailable.
        const c = code == null || code === '' ? companyCurrency ?? (() => { throw Error('Deal currency missing and the HubSpot company currency is unknown'); })() : currency(code);
        // A deal with no amount is not zero: it is kept out of totals and disclosed by count, as the weekly report does.
        if (p.amount == null || p.amount === '') { dataset.noAmount = (dataset.noAmount ?? 0) + 1; continue; }
        add(dataset.totals, c, decimal(p.amount));
      }
    } catch (e) { checkpoint(); unavailable(dataset, e); }
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
    ...datasets.flatMap(d => d.coverage.status !== 'Unavailable' && d.noAmount ? [`${d.coverage.period}: excluded from totals: ${d.noAmount} deal${d.noAmount === 1 ? '' : 's'} with no amount not included`] : []),
    ...comparisons.map(c => c.reason ?? c.note ?? `${c.currency}: amount delta ${c.amountChange.delta}, ${c.amountChange.percentage === null ? c.amountChange.label : c.amountChange.percentage + '%'}; count delta ${c.countChange.delta}, ${c.countChange.percentage === null ? c.countChange.label : c.countChange.percentage + '%'}`),
    ...datasets.map(d => `${d.coverage.period} coverage: ${d.coverage.status}, ${d.coverage.pages} pages, ${d.coverage.unique} unique records, terminal page ${d.coverage.terminal}`), `Source: ${sourceUrl}`].join('\n');
  if (summary.length > 100000) throw Error('Quarterly summary exceeds output limit');
  return { complete: !partial, partial, status: partial ? 'Unavailable' : 'Complete', title, summary, quarters, datasets, comparisons, sourceUrl,
    notificationKey: `quarterly-hubspot:${setup.hubspotPortalId}:${quarters[0]!.label}` };
}
