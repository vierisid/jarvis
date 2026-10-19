import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, closeDb, getDb } from '../vault/schema';
import { createEntity } from '../vault/entities';
import { createFact, correctFact, deleteFact, verifyFact } from '../vault/facts';
import { MemoryStream, MEMORY_STREAM_LIMITS, memoryStreamQuery } from './memory-stream';
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
  await expect(provider.read({ limit: 1, cursor: first.nextCursor!.replace('.1.', '.0.') })).rejects.toThrow('Invalid cursor');
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
test('hard collection cap is unavailable, never a silently truncated count', async () => {
  const template = fact('tea'), entries = Object.entries(getDb().query<any, [string]>('SELECT * FROM facts WHERE id=?').get(template.id));
  const columns = entries.map(([k]) => k), stmt = getDb().prepare(`INSERT INTO facts (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  getDb().transaction(() => { for (let i = 0; i < MEMORY_STREAM_LIMITS.facts; i++) stmt.run(...entries.map(([k, v]) => k === 'id' ? `extra-${i}` : v) as SQLQueryBindings[]); })();
  expect(await provider.read()).toEqual({ state: 'unavailable', reason: 'capacity_exceeded' });
});


test('usage and provenance caps fail closed before returning misleading partial evidence', async () => {
  const a = fact('tea'); uses = Array.from({ length: MEMORY_STREAM_LIMITS.uses + 1 }, (_, i) => supplied(a.id, { useId: `use-${i}` }));
  expect(await provider.read()).toEqual({ state: 'unavailable', reason: 'capacity_exceeded' });
  uses = [];
  const stmt = getDb().prepare(`INSERT INTO fact_evidence(id,fact_id,source,basis,confidence,recorded_at,evidence_key) VALUES(?,?,'fixture','reported',1,?,?)`);
  getDb().transaction(() => { for (let i = 0; i < MEMORY_STREAM_LIMITS.evidence; i++) stmt.run(`e-${i}`, a.id, now, `key-${i}`); })();
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
