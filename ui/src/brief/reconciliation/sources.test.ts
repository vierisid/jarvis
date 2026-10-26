import { expect, test } from 'bun:test';
import { decisionsSource, memorySource, inspectionSource, outcomesSource, goalsSource, getJson } from './sources';
import { ReadFailure } from './resource';
const signal = () => new AbortController().signal;
const decision = (decisionId: string, revision = '1') => ({ decisionId, revision });
const ready = (items: unknown[], nextCursor: string | null = null) => ({ state: 'ready', asOf: 123, data: { items, nextCursor } });

test('reconciliation follows opaque cursors, preserves revisions and removes exact duplicates', async () => {
  const urls: string[] = [];
  const source = decisionsSource({ pages: 3, limit: 2, runId: 'run / 1' }, async url => {
    urls.push(url); return urls.length === 1 ? ready([decision('a')], 'opaque / cursor') : ready([decision('a'), decision('b', '2')]);
  });
  const result = await source.read(signal());
  expect(result.data).toMatchObject({ items: [decision('a'), decision('b', '2')], nextCursor: null, total: null, complete: true });
  expect(new URL(urls[1]!, 'http://fixture').searchParams.get('cursor')).toBe('opaque / cursor');
  expect(new URL(urls[1]!, 'http://fixture').searchParams.get('runId')).toBe('run / 1');
});
test('cursor invalidation restarts the entire window once without retaining obsolete items', async () => {
  let calls = 0;
  const source = decisionsSource({ pages: 2 }, async () => {
    calls++; if (calls === 1) return ready([decision('old')], 'cursor');
    if (calls === 2) throw new ReadFailure('queue_changed', false, false, 409);
    return ready([decision('new', '3')]);
  });
  expect((await source.read(signal())).data?.items.map(({ decisionId, revision }) => ({ decisionId, revision }))).toEqual([decision('new', '3')]); expect(calls).toBe(3);
});
test('continually changing cursors fail after a bounded restart instead of displaying a partial queue', async () => {
  let calls = 0;
  const source = decisionsSource({ pages: 2 }, async () => {
    if (++calls % 2) return ready([decision('a')], 'cursor'); throw new ReadFailure('queue_changed', false, false, 409);
  });
  await expect(source.read(signal())).rejects.toThrow('queue_changed'); expect(calls).toBe(4);
});
test('a bounded page window exposes incomplete coverage and unknown total', async () => {
  const value = await decisionsSource({}, async () => ready([decision('a')], 'more')).read(signal());
  expect(value.data).toMatchObject({ complete: false, total: null, nextCursor: 'more' });
});
test('conflicting revisions, looping cursors and malformed arrays cannot become ready snapshots', async () => {
  await expect(decisionsSource({}, async () => ready([decision('a'), decision('a', '2')])).read(signal())).rejects.toThrow('source_changed');
  await expect(decisionsSource({ pages: 3 }, async () => ready([decision('a')], 'same')).read(signal())).rejects.toThrow('invalid_snapshot');
  await expect(decisionsSource({}, async () => ready([{}])).read(signal())).rejects.toThrow('invalid_snapshot');
  await expect(goalsSource(async () => ({ items: [] })).read(signal())).rejects.toThrow('invalid_snapshot');
});
test('empty memory requires exact server counts; unavailable or absent data does not mean zero', async () => {
  const value = { state: 'empty', asOf: 1, data: { items: [], nextCursor: null, count: { total: 5, matched: 0, returned: 0 } } };
  expect(await memorySource({ q: 'no-match' }, async () => value).read(signal())).toMatchObject({ empty: true, data: { total: 0, pages: [value.data] } });
  await expect(memorySource({}, async () => ({ state: 'empty', asOf: 1 })).read(signal())).rejects.toThrow('invalid_snapshot');
  await expect(memorySource({}, async () => ({ state: 'unavailable' })).read(signal())).rejects.toThrow('source_unavailable');
});
test('inspection is pinned to the selected flow/version/run even when a newer run exists', async () => {
  const selected = { flowId: 'flow/a', versionId: 'old/version', runId: 'old/run' };
  let url = '';
  const data = { ...selected, scopeId: 'scope', canvas: {}, context: {}, run: { ...selected, label: 'Paused' } };
  const source = inspectionSource(selected, async path => { url = path; return { status: 'ready', data }; });
  expect((await source.read(signal())).data).toMatchObject(data); expect(url).toContain('/flow%2Fa/inspection');
  expect(new URL(url, 'http://fixture').searchParams.get('runId')).toBe('old/run');
  data.run.runId = 'new/run'; await expect(source.read(signal())).rejects.toThrow('invalid_snapshot');
});
test('an empty outcome summary preserves unknown measurements instead of manufacturing zeros', async () => {
  expect(await outcomesSource('Europe/Rome', async () => ({ state: 'empty', asOf: 10 })).read(signal()))
    .toEqual({ data: null, empty: true, asOf: 10 });
});
test('HTTP reads bypass cache, stay same-origin and preserve access/error status without server internals', async () => {
  const original = globalThis.fetch; let options: RequestInit | undefined;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => { options = init; return new Response('private', { status: 403 }); }) as typeof fetch;
  try {
    await expect(getJson('/api/brief/memory', signal())).rejects.toMatchObject({ status: 403, clear: true, message: 'http_403' });
    expect(options).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
  } finally { globalThis.fetch = original; }
});
