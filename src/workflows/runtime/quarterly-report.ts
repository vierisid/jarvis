import { comparison, decimal, parts, midnight, pages, currency, add, unavailable, reportTransport, type Dataset, type ReportRequest } from './weekly-report';

export const QUARTERLY_ACTION = 'quarterly_hubspot_report';
export const QUARTERLY_ACCOUNTS = { hubspotConnection: '@activepieces/piece-hubspot' } as const;
export const QUARTERLY_REQUIRED = ['hubspotConnection', 'hubspotPortalId', 'dealDateProperty', 'dealStageIds'] as const;
type Obj = Record<string, any>;
export interface QuarterlySetup { hubspotConnection: string; hubspotPortalId: string; dealDateProperty: string; dealStageIds: string[]; timezone: 'Europe/Rome' }
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
      start: midnight(start), end: midnight(end), localStart: date.toISOString().slice(0, 10), localEnd: new Date(end).toISOString().slice(0, 10) };
  });
}

/** Fixed HubSpot GET endpoints only, with existing bounded response/redirect checks. */
export function quarterlyTransport(token: string, checkpoint: () => void, fetchImpl: typeof fetch = fetch): ReportRequest {
  const request = reportTransport({ hubspot: token, stripe: '', google: '' }, checkpoint, fetchImpl);
  return (provider, path, body) => {
    if (provider !== 'hubspot' || body !== undefined) throw Error('Quarterly reports allow HubSpot reads only');
    return request(provider, path);
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
    const property = await read('hubspot', `/crm/v3/properties/deals/${setup.dealDateProperty}`);
    if (property.name !== setup.dealDateProperty || property.type !== 'datetime') throw Error('Select a HubSpot datetime date property');
    const pipelines = await read('hubspot', '/crm/v3/pipelines/deals');
    const stages = pipelines.results?.flatMap((p: Obj) => p.archived ? [] : p.stages ?? []);
    if (!Array.isArray(stages) || setup.dealStageIds.some(id => !stages.some((s: Obj) => s.id === id && !s.archived && [true, 'true'].includes(s.metadata?.isClosed)))) throw Error('Selected stages must be available closed stages');
    // HubSpot BasicApi.getPage documents paging.next.after, not a fixed page count.
    // https://github.hubspot.com/hubspot-api-nodejs/classes/crm_deals.BasicApi.html
    const query = new URLSearchParams({ limit: '100', archived: 'false', properties: ['dealstage', 'amount', 'deal_currency_code', setup.dealDateProperty].join(',') });
    const rows = await pages(read, 'hubspot', '/crm/v3/objects/deals?' + query, datasets[0]!.coverage);
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
      try { add(dataset.totals, currency(p.deal_currency_code), decimal(p.amount)); }
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
