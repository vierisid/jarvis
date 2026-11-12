import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, closeDb, getDb } from '../vault/schema';
import { createEntity } from '../vault/entities';
import { createFact, correctFact, deleteFact, verifyFact } from '../vault/facts';
import { MemoryStream, MEMORY_STREAM_LIMITS, memoryStreamQuery, readableSubject } from './memory-stream';
import type { MemoryStreamQuery, MemoryStreamPage, MemoryUsageReader } from './memory-stream-contracts';
import type { BriefMemoryUse } from './contracts';

const realNow = Date.now;
let now: number, subject: string, provider: MemoryStream, uses: BriefMemoryUse[], usage: MemoryUsageReader, dir: string, file: string;
beforeEach(() => {
  now = 1791356400000; Date.now = () => now;
  dir = mkdtempSync(join(tmpdir(), 'jarvis-f17-')); file = join(dir, 'vault.db');
  initDatabase(file, { quiet: true }); subject = createEntity('person', 'Ada').id;
  uses = []; usage = { readiness: () => 'ready', readUses: () => ({ state: 'ready', uses }) };
  provider = new MemoryStream(getDb(), usage);
});
afterEach(() => { closeDb(); Date.now = realNow; rmSync(dir, { recursive: true, force: true }); });
const fact = (object: string, source = 'dashboard') => createFact(subject, 'likes', object, { source });
async function page(query: MemoryStreamQuery = {}, reader = provider): Promise<MemoryStreamPage> {
  const result = await reader.read(query); expect(['ready', 'empty']).toContain(result.state);
  return (result as { data: MemoryStreamPage }).data;
}
function supplied(id: string, extra: Partial<BriefMemoryUse> = {}): BriefMemoryUse {
  return { useId: `use-${id}`, factId: id, sourceRevision: 'source-v1', stage: 'supplied',
    turn: { conversationId: 'conversation-a', turnId: 'turn-a', requestId: 'request-a' }, runId: null, at: now, ...extra };
}

test('empty returns exact counts, while missing instrumentation is unknown rather than unused', async () => {
  expect(await provider.read()).toMatchObject({ state: 'empty', data: { count: { total: 0, matched: 0, returned: 0 }, usedIn: { state: 'unavailable', reason: 'no_supplied_evidence' } } });
  const f = fact('tea'), view = await page({}, new MemoryStream(getDb()));
  expect(view.items[0]!.uses).toBeNull(); expect(view.items[0]!.factId).toBe(f.id);
  expect((await page()).items[0]!.uses).toEqual([]);
  expect(await provider.read({ usedIn: 'conversation:conversation-a' })).toEqual({ state: 'unavailable', reason: 'usage_unavailable' });
});
test('tied timestamps paginate every fact once with frozen counts despite concurrent same-time/backdated inserts', async () => {
  const original = Array.from({ length: 7 }, (_, i) => fact(`tea${i}`).id).sort();
  const first = await page({ limit: 2 }); expect(first.items.map(f => f.factId)).toEqual(original.slice(0, 2));
  // Separate SQLite connection represents another writer; do not hold a transaction across requests.
  const writer = new Database(file); writer.run('PRAGMA foreign_keys=ON');
  const template = getDb().query<any, []>('SELECT * FROM facts LIMIT 1').get();
  const columns = Object.keys(template), insert = `INSERT INTO facts (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
  try { for (const [id, at] of [['000-insert', now], ['zzz-backdated', now - 1000]] as const)
    writer.run(insert, columns.map(k => k === 'id' ? id : k === 'created_at' ? at : template[k]));
  } finally { writer.close(); }
  let next = first.nextCursor; const seen = first.items.map(f => f.factId);
  while (next) { const current = await page({ limit: 2, cursor: next });
    expect(current.count).toMatchObject({ total: 7, matched: 7 }); seen.push(...current.items.map(f => f.factId)); next = current.nextCursor;
  }
  expect(seen).toEqual(original); expect(new Set(seen).size).toBe(7);
  expect((await page()).count).toMatchObject({ total: 9, matched: 9 });
  expect(await page({ limit: 2, cursor: first.nextCursor! })).toMatchObject({ items: [{ factId: original[2] }, { factId: original[3] }] });
});
test('long sentences remain intact; literal case-insensitive search does not interpret SQL wildcards', async () => {
  const text = 'a'.repeat(3980) + '%_ TeA', f = fact(text);
  const view = await page({ q: '%_ tea' }); expect(view.items[0]!.sentence).toBe(`Ada likes ${text}`);
  expect(view.items[0]!.factId).toBe(f.id); expect((await page({ q: "' OR 1=1 --" })).count.matched).toBe(0);
  expect((await page({ q: 'ADA LIKES' })).count.matched).toBe(1);
});
test('search, multi-evidence Source, actual Used in and half-open Updated range combine with exact counts', async () => {
  const a = fact('green tea', 'import'); now += 100;
  createFact(subject, 'likes', 'green tea', { source: 'meeting', sourceRef: 'note:1', basis: 'reported' });
  const b = fact('black tea', 'meeting'), c = fact('coffee', 'meeting');
  uses.push(supplied(a.id), supplied(b.id, { stage: 'selected' }), supplied(c.id, { turn: null, runId: 'run-a' }));
  const query = { q: 'tea', source: 'meeting', usedIn: 'conversation:conversation-a', updatedFrom: now, updatedBefore: now + 1 };
  const view = await page(query); expect(view.count).toEqual({ total: 3, matched: 1, returned: 1 });
  expect(view.items[0]).toMatchObject({ factId: a.id, basis: 'reported', sourceSummary: { labels: ['import', 'meeting'], evidenceCount: 2 }, updatedAt: now });
  expect((await page({ ...query, updatedBefore: now, updatedFrom: now - 1 })).count.matched).toBe(0);
  expect((await page({ usedIn: 'run:run-a' })).items.map(i => i.factId)).toEqual([c.id]);
  expect((await page({ usedIn: 'conversation:undefined' })).count.matched).toBe(0);
  expect((await page({ usedIn: 'conversation:other' })).count.matched).toBe(0);
});
test('selected is not supplied; outcomes preserve explicit evidence stage without claiming model reliance', async () => {
  const a = fact('tea'); uses.push(supplied(a.id, { stage: 'selected' }));
  expect(await provider.read({ usedIn: 'conversation:conversation-a' })).toMatchObject({ state: 'unavailable', reason: 'usage_unavailable' });
  uses.push(supplied(a.id, { useId: 'outcome', stage: 'outcome_verified' }));
  const view = await page({ usedIn: 'conversation:conversation-a' }); expect(view.count.matched).toBe(1);
  expect(view.items[0]!.uses!.map(u => u.stage).sort()).toEqual(['outcome_verified', 'selected']);
});
for (const change of ['delete', 'correct', 'verify', 'rename', 'evidence', 'usage'] as const) {
  test(`${change} invalidates an existing snapshot without returning cached content`, async () => {
    const a = fact('tea'); fact('coffee'); const first = await page({ limit: 1 });
    if (change === 'delete') deleteFact(a.id);
    if (change === 'correct') correctFact(a.id, 'water', 'Owner correction');
    if (change === 'verify') verifyFact(a.id);
    if (change === 'rename') getDb().run('UPDATE entities SET name=? WHERE id=?', ['Grace', subject]);
    if (change === 'evidence') createFact(subject, 'likes', 'tea', { source: 'meeting' });
    if (change === 'usage') uses.push(supplied(a.id));
    const stale = await provider.read({ limit: 1, cursor: first.nextCursor! });
    expect(stale).toEqual({ state: 'stale', reason: 'source_changed' }); expect('data' in stale).toBe(false);
  });
}
test('canonical correction history has safe internal links, excludes superseded facts from stream and never links raw sources', async () => {
  const a = fact('tea', 'javascript:alert(1)');
  now += 10; const b = correctFact(a.id, 'water', 'new preference');
  const current = await page(); expect(current.count.total).toBe(1); expect(current.items[0]!.factId).toBe(b.id);
  expect(current.items[0]!.detailHref).toBe(`/api/brief/memory/${encodeURIComponent(b.id)}`);
  const history = provider.detail(a.id, true); expect(history.state).toBe('ready');
  expect((history as any).data.map((f: any) => f.factId)).toEqual([b.id, a.id]);
  expect((provider.detail(a.id) as any).data.status).toBe('superseded');
  deleteFact(a.id); expect(provider.detail(a.id)).toEqual({ state: 'not_found' });
  expect((provider.detail(b.id, true) as any).data.map((f: any) => f.factId)).toEqual([b.id]);
});
test('unconfirmed source/evidence labels cannot claim confirmed status; quotes and extra usage payload never leak', async () => {
  const f = fact('tea', 'user_confirmation');
  getDb().run('UPDATE fact_evidence SET basis=?,quote=?,source_ref=? WHERE fact_id=?', ['confirmed', 'secret quote', 'https://secret.example/token', f.id]);
  uses.push({ ...supplied(f.id), prompt: 'raw prompt', token: 'secret-token' } as BriefMemoryUse);
  const data = await page(); expect(data.items[0]!.basis).toBe('unspecified');
  expect(JSON.stringify(data)).not.toContain('secret'); expect(JSON.stringify(data)).not.toContain('raw prompt');
});
test('expired, evicted and restarted cursors report stale and refresh works', async () => {
  fact('tea'); fact('coffee'); const first = await page({ limit: 1 });
  now += MEMORY_STREAM_LIMITS.ttlMs; expect(await provider.read({ limit: 1, cursor: first.nextCursor! })).toEqual({ state: 'stale', reason: 'cursor_expired' });
  const second = await page({ limit: 1 });
  for (let i = 0; i < MEMORY_STREAM_LIMITS.snapshots; i++) await page({ limit: 1 });
  expect((await provider.read({ limit: 1, cursor: second.nextCursor! })).state).toBe('stale');
  const third = await page({ limit: 1 }); closeDb(); initDatabase(file, { quiet: true }); provider = new MemoryStream(getDb(), usage);
  expect(await provider.read({ limit: 1, cursor: third.nextCursor! })).toEqual({ state: 'stale', reason: 'cursor_expired' });
  expect((await page()).count.matched).toBe(2);
});
test('cursors are bound to query and page size and signed against offset tampering', async () => {
  fact('tea'); fact('coffee'); const first = await page({ limit: 1 });
  for (const query of [{ limit: 2 }, { limit: 1, q: 'tea' }, { limit: 1, source: 'meeting' }])
    await expect(provider.read({ ...query, cursor: first.nextCursor! })).rejects.toThrow('different query');
  const [snapshot, position, signature] = first.nextCursor!.split('.');
  await expect(provider.read({ limit: 1, cursor: [snapshot, Buffer.from(JSON.stringify(null)).toString('base64url'), signature].join('.') })).rejects.toThrow('Invalid cursor');
  expect(position!.length).toBeGreaterThan(0);
});
test('strict bounds reject unsupported fields and malformed query inputs', async () => {
  for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { q: '' }, { q: 'a'.repeat(257) }, { q: 'x\u0000' },
    { source: 'a'.repeat(4001) }, { usedIn: 'similar:tea' }, { usedIn: 'conversation:..' }, { cursor: 'a'.repeat(257) },
    { updatedFrom: NaN }, { updatedBefore: Infinity }, { updatedFrom: 2, updatedBefore: 1 }, { updatedFrom: '1' }, { sort: 'anything' }]) {
    expect(() => memoryStreamQuery(query as MemoryStreamQuery)).toThrow();
  }
  await expect(provider.read({ cursor: 'not-a-cursor' })).rejects.toThrow();
});
test('closed or replaced database and failing usage provider return unavailable, not zero matches', async () => {
  fact('tea'); usage.readUses = () => { throw Error('sensitive failure'); };
  expect(await provider.read()).toEqual({ state: 'unavailable', reason: 'provider_unavailable' });
  closeDb(); initDatabase(':memory:', { quiet: true });
  expect(provider.readiness()).toBe('unavailable'); expect((await provider.read()).state).toBe('unavailable');
});
test('malformed and duplicate usage records fail closed', async () => {
  const a = fact('tea');
  for (const invalid of [{ ...supplied(a.id), factId: 'other' }, { ...supplied(a.id), at: NaN }, { ...supplied(a.id), turn: null }, { ...supplied(a.id), stage: 'guessed' }]) {
    uses = [invalid as BriefMemoryUse]; expect((await provider.read()).state).toBe('unavailable');
  }
  uses = [supplied(a.id), supplied(a.id)]; expect((await provider.read()).state).toBe('unavailable');
});
test('a store over the old 10,000 fact cap still pages, searches and counts from the database', async () => {
  const template = fact('tea'), entries = Object.entries(getDb().query<any, [string]>('SELECT * FROM facts WHERE id=?').get(template.id));
  const columns = entries.map(([k]) => k), stmt = getDb().prepare(`INSERT INTO facts (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  const total = 20_000;
  getDb().transaction(() => { for (let i = 0; i < total; i++) stmt.run(...entries.map(([k, v]) => k === 'id' ? `extra-${String(i).padStart(5, '0')}` : k === 'object' ? (i === 12_345 ? 'needle' : `item ${i}`) : v) as SQLQueryBindings[]); })();
  const first = await page({ limit: 100 });
  expect(first.count).toEqual({ total: total + 1, matched: total + 1, returned: 100 }); expect(first.nextCursor).not.toBeNull();
  const found = await page({ q: 'NEEDLE' }); expect(found.items.map(i => i.sentence)).toEqual(['Ada likes needle']);
  const seen = new Set(first.items.map(i => i.factId)); let next = first.nextCursor;
  for (let n = 0; n < 20 && next; n++) { const current = await page({ limit: 100, cursor: next }); for (const i of current.items) seen.add(i.factId); next = current.nextCursor; }
  expect(seen.size).toBe(2100); expect(next).not.toBeNull();
  expect((provider.detail('extra-12345') as any).state).toBe('ready');
});

test('a usage ledger over its cap fails closed before returning misleading partial evidence', async () => {
  const a = fact('tea'); uses = Array.from({ length: MEMORY_STREAM_LIMITS.uses + 1 }, (_, i) => supplied(a.id, { useId: `use-${i}` }));
  expect(await provider.read()).toEqual({ state: 'unavailable', reason: 'capacity_exceeded' });
});
test('history cycles terminate and oversized lineage is unavailable without truncation', async () => {
  const a = fact('tea'), b = fact('coffee');
  getDb().run("UPDATE facts SET superseded_by=? WHERE id=?", [b.id, a.id]);
  getDb().run("UPDATE facts SET superseded_by=? WHERE id=?", [a.id, b.id]);
  expect((provider.detail(a.id, true) as any).data).toHaveLength(2);
  const entries = Object.entries(getDb().query<any, [string]>('SELECT * FROM facts WHERE id=?').get(a.id));
  const columns = entries.map(([k]) => k), stmt = getDb().prepare(`INSERT INTO facts (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  getDb().transaction(() => { for (let i = 0; i < 99; i++) stmt.run(...entries.map(([k, v]) => k === 'id' ? `history-${i}` : v) as SQLQueryBindings[]); })();
  expect(provider.detail(a.id, true)).toEqual({ state: 'unavailable' });
});
test('workflow bookkeeping entities are left out of the stream and counts, and id-only subjects read as a type and source', async () => {
  const flow = createEntity('project', 'lbk0h4QNrT2dLz9oEdSQQ', { entity_kind: 'workflow' });
  const draft = createEntity('concept', 'zkRaquk048rgAX6HlPz84', { entity_kind: 'draft_version' });
  createFact(flow.id, 'reported_schedule', 'daily', { source: 'llm_extraction' });
  createFact(draft.id, 'requested_state', 'disabled draft', { source: 'llm_extraction' });
  const bare = createEntity('project', 'qwErTy0123456789AbCdEf');
  const kept = createFact(bare.id, 'launch_plan', 'weekly', { source: 'llm_extraction' });
  fact('tea');
  const view = await page();
  expect(view.count.total).toBe(2);
  expect(view.items.map(i => i.sentence).join('\n')).not.toContain('lbk0h4QNrT2dLz9oEdSQQ');
  const row = view.items.find(i => i.factId === kept.id)!;
  expect(row.sentence).toBe('A project noted from a chat launch plan weekly');
  expect(row.sentence).not.toContain('qwErTy0123456789AbCdEf');
  expect(view.items.some(i => i.sentence === 'Ada likes tea')).toBe(true);
  expect(getDb().query('SELECT COUNT(*) c FROM facts').get()).toEqual({ c: 3 + 1 });
});
test('operational facts stored earlier are hidden at read time and counted consistently; data is kept', async () => {
  getDb().run("CREATE TABLE IF NOT EXISTS flow_version (id TEXT PRIMARY KEY, flow_id TEXT, display_name TEXT)");
  getDb().run("INSERT INTO flow_version (id, flow_id, display_name) VALUES ('v1', 'f1', 'Weekly Reminder')");
  const wf = createEntity('project', 'Weekly Reminder', undefined, 'llm_extraction');
  const biz = createEntity('project', 'Morloven', undefined, 'llm_extraction');
  const llm = { source: 'llm_extraction' };
  createFact(wf.id, 'requested_schedule', 'Every weekday at 09:00', { ...llm, basis: 'reported', quote: 'q' });
  createFact(biz.id, 'reported_workflow_id', 'lbk0h4QNrT2dLz9oEdSQQ', { ...llm, basis: 'reported', quote: 'q' });
  createFact(biz.id, 'reported_saved_cron', '0 9 * * 1-5', { ...llm, basis: 'reported', quote: 'q' });
  createFact(biz.id, 'assistant_reported_status', 'Saved as disabled draft', { ...llm, basis: 'inferred' });
  const real = createFact(biz.id, 'sells', 'surf apparel', { ...llm, basis: 'reported', quote: 'q' });
  const view = await page();
  expect(view.items.map(i => i.factId)).toEqual([real.id]);
  expect(view.count).toEqual({ total: 1, matched: 1, returned: 1 });
  expect(await page({ q: 'cron' })).toMatchObject({ count: { total: 1, matched: 0 } });
  expect(getDb().query('SELECT COUNT(*) c FROM facts').get()).toEqual({ c: 5 });
});
test('extracted repeats that differ only in case or spacing collapse to the latest; different values and user-entered facts do not', async () => {
  const biz = createEntity('project', 'Morloven', undefined, 'llm_extraction');
  const llm = { source: 'llm_extraction' };
  createFact(biz.id, 'requires', 'One row per order.', llm); now += 1000;
  const latest = createFact(biz.id, 'requires', 'one row  per order', llm);
  const apparel = createFact(biz.id, 'sells', 'surf apparel', llm); now += 1000;
  const wetsuits = createFact(biz.id, 'sells', 'wetsuits', llm);
  const a = fact('tea'), b = fact('coffee');
  const view = await page();
  expect(view.items.map(i => i.factId).sort()).toEqual([latest.id, apparel.id, wetsuits.id, a.id, b.id].sort());
  expect(view.count.total).toBe(5);
});
test('a contested extracted pair stays visible to be settled', async () => {
  const llm = { source: 'llm_extraction' };
  const one = createFact(subject, 'birthday', 'May 1', llm); now += 1000;
  const two = createFact(subject, 'birthday', 'June 2', llm);
  const view = await page();
  expect(view.items.map(i => i.factId).sort()).toEqual([one.id, two.id].sort());
  expect(view.items.every(i => i.status === 'contested')).toBe(true);
});
test('facts a person entered or confirmed always show, even when they look like bookkeeping', async () => {
  const wf = createEntity('project', 'Hiring workflow', { entity_kind: 'workflow' });
  getDb().run("CREATE TABLE IF NOT EXISTS flow_version (id TEXT PRIMARY KEY, flow_id TEXT, display_name TEXT)");
  getDb().run("INSERT INTO flow_version (id, flow_id, display_name) VALUES ('v1', 'f1', 'Ada')");
  const typed = createFact(subject, 'stripe_account', 'acct_1NqXyZ2eZvKYlo2C', { source: 'dashboard' });
  const onFlow = createFact(wf.id, 'needs', 'two interviews', { source: 'dashboard' });
  const confirmed = createFact(subject, 'reported_schedule_id', 'Q7hYt3kLmN0pQrStUv', { source: 'llm_extraction' });
  verifyFact(confirmed.id, 'yes, that is mine');
  const quoted = createFact(createEntity('project', 'Morloven').id, 'account_id', 'acct_1NqXyZ2eZvKYlo2C',
    { source: 'llm_extraction', quote: 'our account is acct_1NqXyZ2eZvKYlo2C' });
  const reportsTo = createFact(createEntity('person', 'Bea').id, 'reported_to', 'Ada', { source: 'llm_extraction' });
  const ids = (await page()).items.map(i => i.factId);
  for (const f of [typed, onFlow, quoted, reportsTo]) expect(ids).toContain(f.id);
  expect(ids.length).toBe(5);
});
test('hidden bookkeeping still resolves by id for detail and history', async () => {
  const flow = createEntity('project', 'lbk0h4QNrT2dLz9oEdSQQ', { entity_kind: 'workflow' });
  const f = createFact(flow.id, 'reported_schedule', 'daily', { source: 'llm_extraction' });
  expect((await page()).count.total).toBe(0);
  expect(provider.detail(f.id)).toMatchObject({ state: 'ready', data: { factId: f.id } });
  expect(provider.detail(f.id, true)).toMatchObject({ state: 'ready' });
  expect(readableSubject('qwErTy0123456789AbCdEf', 'event', 'llm_extraction')).toBe('An event noted from a chat');
});
test('facts about a workflow itself are hidden, not facts about the business', async () => {
  const wf = createEntity('project', 'Order ingestion workflow', undefined, 'llm_extraction');
  createFact(wf.id, 'required_output', 'One row per order', { source: 'llm_extraction', basis: 'reported', quote: 'q' });
  const view = await page();
  expect(view.count.total).toBe(0);
});
test('hidden bookkeeping stays out of every page of a paged read, and counts match what pages return', async () => {
  const flow = createEntity('project', 'lbk0h4QNrT2dLz9oEdSQQ', { entity_kind: 'workflow' }), llm = { source: 'llm_extraction' };
  const shown: string[] = [];
  for (let i = 0; i < 6; i++) {
    createFact(flow.id, 'reported_schedule', `daily ${i}`, llm);
    shown.push(fact(`tea${i}`).id); now += 1000;
  }
  let view = await page({ limit: 2 }); const seen = view.items.map(i => i.factId);
  expect(view.count).toEqual({ total: 6, matched: 6, returned: 2 });
  while (view.nextCursor) { view = await page({ limit: 2, cursor: view.nextCursor }); seen.push(...view.items.map(i => i.factId)); }
  expect(seen.sort()).toEqual(shown.sort());
  expect((await page({ q: 'daily' })).count).toEqual({ total: 6, matched: 0, returned: 0 });
});
test('a fact that becomes hidden while a cursor is open ends that cursor as stale', async () => {
  for (let i = 0; i < 3; i++) fact(`tea${i}`);
  createFact(createEntity('project', 'Weekly Reminder').id, 'needs', 'a sheet', { source: 'llm_extraction' });
  const first = await page({ limit: 2 }); expect(first.count.total).toBe(4);
  getDb().run("CREATE TABLE IF NOT EXISTS flow_version (id TEXT PRIMARY KEY, flow_id TEXT, display_name TEXT)");
  getDb().run("INSERT INTO flow_version (id, flow_id, display_name) VALUES ('v1', 'f1', 'Weekly Reminder')");
  expect(await provider.read({ limit: 2, cursor: first.nextCursor! })).toEqual({ state: 'stale', reason: 'source_changed' });
  expect((await page()).count.total).toBe(3);
});
test('search matches the words a sentence shows: spaced predicates and non-ASCII text typed as stored', async () => {
  const f = createFact(createEntity('person', 'Émile').id, 'launch_plan', 'Città di Roma', { source: 'dashboard' });
  for (const q of ['launch plan', 'Émile', 'Émile LAUNCH plan', 'città di roma', 'CITTà'])
    expect((await page({ q })).items.map(i => i.factId)).toEqual([f.id]);
});
