import type { BriefPage } from '../../../../src/brief/contracts';
import type { QueuedDecision } from '../../../../src/brief/decision-contracts';
import type { MemoryStreamPage, MemoryStreamQuery } from '../../../../src/brief/memory-stream-contracts';
import type { InspectionSelection } from '../../../../src/brief/workflow-context-contracts';
import type { WorkflowRemoval } from '../../../../src/brief/workflow-removal';
import type { OutcomeSummary } from '../../../../src/brief/outcomes';
import type { PreparedOpportunityView } from '../../../../src/awareness/prepared-contracts';
import type { Goal } from '../../../../src/goals/types';
import type { WorkItem } from '../../../../src/goals/work-items';
import { ReadFailure, type Read, type Source } from './resource';

type ObjectValue = Record<string, any>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const invalid = () => new ReadFailure('invalid_snapshot');
export type GetJson = (url: string, signal: AbortSignal) => Promise<unknown>;
export const getJson: GetJson = async (url, signal) => {
  const response = await fetch(url, { signal, cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new ReadFailure(`http_${response.status}`, [401, 403, 404, 410].includes(response.status), response.status === 501, response.status);
  try { return await response.json(); } catch { throw invalid(); }
};
function envelope<T>(value: unknown, valid: (data: unknown) => boolean): Read<T> {
  if (!object(value)) throw invalid();
  if (value.state === 'unsupported') throw new ReadFailure('unsupported', true, true);
  if (value.state === 'unavailable') throw new ReadFailure('source_unavailable');
  if (value.state === 'stale') throw new ReadFailure('source_changed', false, false, 409);
  if (!['ready', 'empty'].includes(value.state) || !time(value.asOf)) throw invalid();
  if (value.state === 'empty' && value.data === undefined) return { data: null, empty: true, asOf: value.asOf };
  if (!valid(value.data)) throw invalid();
  return { data: value.data as T, empty: value.state === 'empty', asOf: value.asOf };
}
const page = (value: unknown, id: string, revision = true): value is BriefPage<any> & Record<string, unknown> => object(value)
  && Array.isArray(value.items) && (value.nextCursor === null || text(value.nextCursor))
  && value.items.every((item: unknown) => object(item) && text(item[id]) && (!revision || text(item.revision)));
const queryUrl = (path: string, query: object) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return `${path}?${params}`;
};
export interface Window<T, P = BriefPage<T>> {
  items: T[]; pages: P[]; nextCursor: string | null; complete: boolean;
  /** Only a server-provided total. A loaded window's length is not a badge count. */
  total: number | null;
}
interface PageOptions { pages?: number; limit?: number }

/** Rebuild the loaded window from its first page; never append an event or reuse an expired cursor. */
async function windowRead<T, P extends BriefPage<T>>(read: (cursor?: string) => Promise<Read<P>>, id: string, count: number,
  total: (page: P) => number | null = () => null): Promise<Read<Window<T, P>>> {
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new ReadFailure('invalid_page_bound');
  for (let attempt = 0; ; attempt++) {
    try {
      const pages: P[] = [], items = new Map<string, T>(), cursors = new Set<string>();
      let cursor: string | undefined, asOf = 0, reportedTotal: number | null = null;
      for (let index = 0; index < count; index++) {
        const result = await read(cursor); asOf = index ? Math.min(asOf, result.asOf) : result.asOf;
        if (!result.data) { if (index) throw invalid(); break; }
        const p = result.data;
        if (index && total(p) !== reportedTotal) throw new ReadFailure('source_changed', false, false, 409);
        reportedTotal = total(p); pages.push(p);
        for (const item of p.items) {
          const key = (item as ObjectValue)[id] as string, previous = items.get(key);
          if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new ReadFailure('source_changed', false, false, 409);
          items.set(key, item);
        }
        if (p.nextCursor === null) { cursor = undefined; break; }
        if (cursors.has(p.nextCursor)) throw invalid();
        cursors.add(p.nextCursor); cursor = p.nextCursor;
      }
      const data = { items: [...items.values()], pages, nextCursor: cursor ?? null, complete: !cursor, total: reportedTotal };
      return { data, empty: !data.items.length && data.complete, asOf };
    } catch (error) {
      // A changing source is unavailable/stale after one bounded restart, never a partial success.
      if (attempt || !(error instanceof ReadFailure) || error.status !== 409) throw error;
    }
  }
}

export function decisionsSource(options: PageOptions & { runId?: string } = {}, get: GetJson = getJson): Source<Window<QueuedDecision>> {
  const { pages = 1, limit = 30, runId } = options;
  return { domains: ['decisions'], capability: 'decisions', read: signal => windowRead(cursor => get(queryUrl('/api/brief/decisions', { limit, runId, cursor }), signal)
    .then(value => envelope<BriefPage<QueuedDecision>>(value, data => page(data, 'decisionId'))), 'decisionId', pages) };
}
export function opportunitiesSource(options: PageOptions = {}, get: GetJson = getJson): Source<Window<PreparedOpportunityView>> {
  const { pages = 1, limit = 20 } = options;
  return { domains: ['opportunities'], capability: 'preparedOpportunities', read: signal => windowRead(cursor => get(queryUrl('/api/brief/prepared-opportunities', { limit, cursor }), signal)
    .then(value => envelope<BriefPage<PreparedOpportunityView>>(value, data => page(data, 'proposalId'))), 'proposalId', pages) };
}
export function memorySource(options: Omit<MemoryStreamQuery, 'cursor'> & { pages?: number } = {}, get: GetJson = getJson): Source<Window<MemoryStreamPage['items'][number], MemoryStreamPage>> {
  const { pages = 1, ...query } = options;
  return { domains: ['memory'], capability: 'memoryStream', retainStale: false,
    read: signal => windowRead(cursor => get(queryUrl('/api/brief/memory', { ...query, cursor }), signal).then(value => {
      const result = envelope<MemoryStreamPage>(value, data => page(data, 'factId') && object(data.count)
        && time(data.count.total) && time(data.count.matched) && data.count.total >= data.count.matched
        && data.count.returned === data.items.length && data.items.length <= data.count.matched);
      // F-17 always supplies counts, including valid empty results.
      if (!result.data || result.empty !== (result.data.count.matched === 0)) throw invalid();
      return result;
    }), 'factId', pages, p => p.count.matched) };
}
type WorkflowList = ReturnType<WorkflowRemoval['read']>['data'];
export function workflowsSource(get: GetJson = getJson): Source<WorkflowList> {
  return { domains: ['workflows'], capability: 'workflowRemoval', read: async signal => {
    const result = envelope<WorkflowList>(await get('/api/brief/workflows', signal), data => object(data) && text(data.scopeId)
      && Array.isArray(data.items) && data.items.every((item: unknown) => object(item) && text(item.flowId) && text(item.revision))
      && Array.isArray(data.removals) && Array.isArray(data.slots));
    if (!result.data) throw invalid();
    return result;
  } };
}
export function inspectionSource(selection: { flowId: string; versionId: string; runId: string | null }, get: GetJson = getJson): Source<InspectionSelection> {
  const { flowId, versionId, runId } = selection;
  return { domains: ['runs', 'memory', 'goals'], capability: 'workflowContext', retainStale: false, read: async signal => {
    const value = await get(queryUrl(`/api/brief/workflows/${encodeURIComponent(flowId)}/inspection`, { versionId, runId: runId ?? undefined }), signal);
    if (!object(value) || value.status !== 'ready' || !object(value.data)) throw invalid();
    const data = value.data;
    if (data.flowId !== flowId || data.versionId !== versionId || data.runId !== runId || !text(data.scopeId)
      || !object(data.context) || !object(data.canvas) || (runId !== null && (!object(data.run)
        || data.run.runId !== runId || data.run.flowId !== flowId || data.run.versionId !== versionId || !text(data.run.label)))) throw invalid();
    return { data: data as InspectionSelection, empty: false, asOf: Date.now() };
  } };
}
export function outcomesSource(timezone: string, get: GetJson = getJson): Source<OutcomeSummary> {
  return { domains: ['today', 'goals'], capability: 'outcomes', read: async signal => envelope<OutcomeSummary>(
    await get(queryUrl('/api/brief/outcomes/summary', { timezone }), signal), data => object(data) && object(data.window)
      && Array.isArray(data.outcomes) && Array.isArray(data.days) && object(data.coverage)) };
}
function listSource<T>(url: string, domains: Source<T[]>['domains'], get: GetJson): Source<T[]> {
  return { domains, read: async signal => {
    const value = await get(url, signal);
    if (!Array.isArray(value) || !value.every(item => object(item) && text(item.id)) || new Set(value.map(item => item.id)).size !== value.length) throw invalid();
    return { data: value as T[], empty: value.length === 0, asOf: Date.now() };
  } };
}
/** Legacy reads have no server total or revision; preserve their IDs/timestamps without inventing either. */
export const goalsSource = (get: GetJson = getJson) => listSource<Goal>('/api/goals?limit=100', ['goals'], get);
export const todaySource = (get: GetJson = getJson) => listSource<WorkItem>('/api/work-items?today=true', ['today'], get);
