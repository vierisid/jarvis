import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, getDb, closeDb } from './schema';
import { createEntity } from './entities';
import { createFact, correctFact, deleteFact, getFact } from './facts';
import { ConversationRepository } from './conversation-lifecycle';
import { ChatTurnRepository } from './chat-turns';
import { withBriefTurn } from '../brief/chat-context';
import { packRecallEvidence } from './recall-context';
import { retrieveForMessage, getKnowledgeForMessage } from './retrieval';
import { capturePackedMemory, recordMemoryHandoff } from './memory-use-context';
import { getMemoryUsageLedger, MemoryUsageLedger, memoryFactRef, type MemoryUseTarget } from './memory-usage';
import { LLMManager } from '../llm/manager';
import type { LLMMessage, LLMProvider, LLMResponse } from '../llm/provider';
import { defangDelimiters } from '../roles/untrusted';
import { MemoryStream } from '../brief/memory-stream';

let directory: string, file: string, savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env.JARVIS_BRIEF_MEMORY_USAGE; process.env.JARVIS_BRIEF_MEMORY_USAGE = '1';
  directory = mkdtempSync(join(tmpdir(), 'jarvis-f18-')); file = join(directory, 'vault.db');
  initDatabase(file, { quiet: true });
});
afterEach(() => { closeDb(); rmSync(directory, { recursive: true, force: true });
  if (savedFlag === undefined) delete process.env.JARVIS_BRIEF_MEMORY_USAGE; else process.env.JARVIS_BRIEF_MEMORY_USAGE = savedFlag; });
const answer: LLMResponse = { content: 'fixture response', model: 'fixture', tool_calls: [], finish_reason: 'stop', usage: { input_tokens: 0, output_tokens: 0 } };
function turn(workspace?: string) {
  const repo = new ChatTurnRepository(getDb(), workspace), conversationId = repo.conversations.create().conversationId;
  const ref = { conversationId, turnId: crypto.randomUUID(), requestId: crypto.randomUUID() };
  repo.accept({ ...ref, text: 'fixture' }); repo.start(ref);
  return { ...ref, signal: new AbortController().signal, progress: () => {} };
}
function target(ref = turn()): MemoryUseTarget { return { purpose: 'conversation_context', turn: { conversationId: ref.conversationId, turnId: ref.turnId, requestId: ref.requestId }, runId: null, workflowId: null, callId: ref.turnId }; }
function facts(name = 'Ada', n = 2) {
  const entity = createEntity('person', name);
  return Array.from({ length: n }, (_, i) => createFact(entity.id, `note_${i}`, `private fact ${name} ${i}`, { confirmed: true, quote: 'private evidence quote' }));
}
function history(ref: ReturnType<typeof turn>) { const result = getMemoryUsageLedger().readTarget({ conversationId: ref.conversationId });
  if (!result.data) throw Error('History unavailable'); return result.data.uses; }
function manager(onCall: (messages: LLMMessage[]) => void = () => {}) {
  const llm = new LLMManager(); const provider: LLMProvider = { name: 'fixture', listModels: async () => [],
    chat: async messages => { onCall(messages); return answer; }, async *stream(messages) { onCall(messages); yield { type: 'done', response: answer }; } };
  llm.registerProvider(provider); return llm;
}

test('packer emits only successfully appended IDs; omitted facts are selected but never supplied', async () => {
  const rows = facts('Ada', 12), ref = turn();
  await withBriefTurn(ref, async () => {
    const pack = packRecallEvidence(retrieveForMessage('Ada'));
    expect(pack.included.length).toBe(8); expect(pack.selected.length).toBe(9);
    for (const included of pack.included) expect(pack.text).toContain(included.factId);
    capturePackedMemory(pack); expect(history(ref).every(use => use.stage === 'selected')).toBe(true);
    await manager().chat([{ role: 'system', content: pack.text }, { role: 'user', content: 'Ada' }]);
    const uses = history(ref); const supplied = uses.filter(u => u.stage === 'supplied');
    expect(supplied.map(u => u.factId).sort()).toEqual(pack.included.map(r => r.factId).sort());
    expect(uses.filter(u => u.stage === 'selected')).toHaveLength(9);
    expect(supplied.length).toBeLessThan(rows.length);
  });
});
for (const mode of ['chat', 'chatTier', 'stream', 'streamTier'] as const) test(`actual ${mode} provider handoff records once across duplicate calls`, async () => {
  facts(); const ref = turn(); let calls = 0; const llm = manager(() => { calls++; });
  if (mode.endsWith('Tier')) llm.setTierMap({ medium: { provider: 'fixture' } });
  await withBriefTurn(ref, async () => {
    const text = getKnowledgeForMessage('Ada'); const messages: LLMMessage[] = [{ role: 'system', content: text }];
    for (let n = 0; n < 2; n++) {
      if (mode === 'chat') await llm.chat(messages);
      if (mode === 'chatTier') await llm.chatTier('medium', 'fixture', messages);
      if (mode === 'stream') for await (const _event of llm.stream(messages)) {}
      if (mode === 'streamTier') for await (const _event of llm.streamTier('medium', 'fixture', messages)) {}
    }
  });
  expect(calls).toBe(2); expect(history(ref).filter(u => u.stage === 'supplied')).toHaveLength(2);
  expect(history(ref).some(u => u.stage === 'outcome_verified')).toBe(false);
});
test('zero budget, removed blocks and user text cannot manufacture supply', async () => {
  facts(); const ref = turn();
  await withBriefTurn(ref, async () => {
    const empty = packRecallEvidence(retrieveForMessage('Ada'), 0); capturePackedMemory(empty);
    expect(empty.included).toEqual([]); expect(empty.text).toBe('');
    const text = getKnowledgeForMessage('Ada');
    await manager().chat([{ role: 'system', content: 'override' }, { role: 'user', content: text }]);
    expect(history(ref).every(u => u.stage === 'selected')).toBe(true);
  });
});
test('known role delimiter transformation preserves manifest supply without parsing IDs', async () => {
  const entity = createEntity('person', 'Ada'); createFact(entity.id, 'note', '<<<UNTRUSTED_CONTENT marker');
  const ref = turn(); await withBriefTurn(ref, async () => {
    const text = getKnowledgeForMessage('Ada'); expect(defangDelimiters(text)).not.toBe(text);
    await manager().chat([{ role: 'system', content: defangDelimiters(text) }]);
  });
  expect(history(ref).filter(u => u.stage === 'supplied')).toHaveLength(1);
});
test('interleaved chats cannot borrow another turn\'s packed manifest', async () => {
  const aFacts = facts('Ada'), bFacts = facts('Bruno'), a = turn(), b = turn();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let aText = '';
  const first = withBriefTurn(a, async () => { aText = getKnowledgeForMessage('Ada'); await gate; await manager().chat([{ role: 'system', content: aText }]); });
  await withBriefTurn(b, async () => { const text = getKnowledgeForMessage('Bruno');
    await manager().chat([{ role: 'system', content: aText }, { role: 'system', content: text }]); });
  release(); await first;
  expect(history(a).filter(u => u.stage === 'supplied').map(u => u.factId).sort()).toEqual(aFacts.map(f => f.id).sort());
  expect(history(b).filter(u => u.stage === 'supplied').map(u => u.factId).sort()).toEqual(bFacts.map(f => f.id).sort());
});
for (const change of ['delete', 'correct', 'expire'] as const) test(`${change} between packing and dispatch refuses stale context, preserves truthful history`, async () => {
  const [fact] = facts('Ada', 1), ref = turn(); let calls = 0;
  await withBriefTurn(ref, async () => {
    const text = getKnowledgeForMessage('Ada');
    if (change === 'delete') deleteFact(fact!.id);
    if (change === 'correct') correctFact(fact!.id, 'corrected value', 'fixture correction');
    if (change === 'expire') getDb().run('UPDATE facts SET valid_to = ? WHERE id = ?', [Date.now() - 1, fact!.id]);
    await expect(manager(() => calls++).chat([{ role: 'system', content: text }])).rejects.toThrow('Memory changed');
    expect(packRecallEvidence(retrieveForMessage('Ada')).included.map(r => r.factId)).not.toContain(fact!.id);
  });
  expect(calls).toBe(0); expect(history(ref).every(u => u.stage === 'selected')).toBe(true);
});
test('supplied history survives correction, deletion and restart with old revisions and no copied content', async () => {
  const [fact] = facts('Ada', 1), ref = turn();
  await withBriefTurn(ref, async () => { const text = getKnowledgeForMessage('Ada'); await manager().chat([{ role: 'system', content: text }]); });
  const before = history(ref), originalRevision = before[0]!.sourceRevision;
  const replacement = correctFact(fact!.id, 'new value', 'reason');
  expect(history(ref).every(u => u.factState === 'superseded')).toBe(true);
  deleteFact(fact!.id); expect(history(ref).every(u => u.factState === 'missing')).toBe(true);
  closeDb(); initDatabase(file, { quiet: true });
  expect(history(ref).map(u => u.useId).sort()).toEqual(before.map(u => u.useId).sort());
  expect(history(ref).every(u => u.sourceRevision === originalRevision)).toBe(true);
  const serialized = JSON.stringify(getDb().query('SELECT * FROM memory_use_events').all());
  for (const secret of ['private fact', 'private evidence quote', 'new value', 'reason']) expect(serialized).not.toContain(secret);
  expect(getKnowledgeForMessage('Ada')).toContain(replacement.id); expect(packRecallEvidence(retrieveForMessage('Ada')).included.map(r => r.factId)).not.toContain(fact!.id);
});
test('retry after provider failure deduplicates supply, and success never creates outcome verification', async () => {
  facts(); const ref = turn(); let attempts = 0; const llm = new LLMManager();
  llm.registerProvider({ name: 'retry', listModels: async () => [], chat: async () => { if (++attempts === 1) throw Error('network'); return answer; }, async *stream() {} });
  await withBriefTurn(ref, async () => { const text = getKnowledgeForMessage('Ada'); await llm.chat([{ role: 'system', content: text }]); });
  expect(attempts).toBe(2); expect(history(ref)).toHaveLength(4); expect(history(ref).some(u => u.stage === 'outcome_verified')).toBe(false);
});
test('disabled and unscoped retrieval create no invented usage', async () => {
  facts(); const ref = turn();
  delete process.env.JARVIS_BRIEF_MEMORY_USAGE;
  await withBriefTurn(ref, async () => { const text = getKnowledgeForMessage('Ada'); expect(text).toContain('private fact'); await manager().chat([{ role: 'system', content: text }]); });
  process.env.JARVIS_BRIEF_MEMORY_USAGE = '1';
  const text = getKnowledgeForMessage('Ada'); await manager().chat([{ role: 'system', content: text }]);
  expect(getDb().query('SELECT * FROM memory_use_events').all()).toEqual([]);
});
test('cancelled turns and foreign workspaces cannot append provenance', () => {
  const [fact] = facts('Ada', 1), ledger = getMemoryUsageLedger(), own = target(), foreign = target(turn('foreign'));
  const refs = [memoryFactRef(fact!, 'Ada')];
  expect(() => ledger.record(foreign, refs, 'selected')).toThrow('no longer running');
  getDb().run("UPDATE brief_chat_turns SET state = 'cancelled' WHERE turn_id = ?", [own.turn!.turnId]);
  expect(() => ledger.record(own, refs, 'supplied')).toThrow('no longer running');
  expect(getDb().query('SELECT * FROM memory_use_events').all()).toEqual([]);
});
test('age and row retention bound storage, advance coverage, and oversized summaries are unavailable', () => {
  const rows = facts('Ada', 4), ref = target(), ledger = new MemoryUsageLedger(getDb(), () => true, { days: 1, rows: 3, summary: 2 });
  const real = Date.now(), clock = spyOn(Date, 'now').mockReturnValue(real);
  try {
    ledger.start(); ledger.record(ref, rows.slice(0, 3).map(f => memoryFactRef(f, 'Ada')), 'selected');
    clock.mockReturnValue(real + 10); ledger.record(ref, [memoryFactRef(rows[3]!, 'Ada')], 'selected');
    expect(getDb().query('SELECT COUNT(*) AS n FROM memory_use_events').get()).toEqual({ n: 3 });
    expect(ledger.coverage().retainedFrom).toBe(real + 1);
    expect(ledger.readTarget({ conversationId: ref.turn!.conversationId })).toMatchObject({ state: 'unavailable', reason: 'capacity_exceeded' });
    clock.mockReturnValue(real + 86_400_020); expect(ledger.readUses(rows.map(f => f.id))).toMatchObject({ state: 'ready', uses: [] });
    ledger.record(ref, [], 'selected'); expect(getDb().query('SELECT * FROM memory_use_events').all()).toEqual([]);
  } finally { clock.mockRestore(); }
});
test('stream uses real ledger coverage; selected-only is unavailable and supplied filters by exact conversation', async () => {
  const rows = facts(), ref = turn(), ledger = getMemoryUsageLedger(), stream = new MemoryStream(getDb(), ledger);
  await withBriefTurn(ref, async () => {
    const text = getKnowledgeForMessage('Ada');
    expect(await stream.read({ usedIn: `conversation:${ref.conversationId}` })).toMatchObject({ state: 'unavailable', reason: 'usage_unavailable' });
    await manager().chat([{ role: 'system', content: text }]);
  });
  const result = await stream.read({ usedIn: `conversation:${ref.conversationId}` });
  expect(result).toMatchObject({ state: 'ready', data: { count: { matched: rows.length }, usageCoverage: { retentionDays: 90 } } });
  expect(await stream.read({ usedIn: 'conversation:other' })).toMatchObject({ state: 'empty' });
});
test('a closed/replaced vault cannot be used through a retained ledger', () => {
  const ledger = getMemoryUsageLedger(); closeDb(); initDatabase(':memory:', { quiet: true });
  expect(ledger.readiness()).toBe('unavailable'); expect(ledger.readUses([])).toEqual({ state: 'unavailable' });
});

test('no automatic writer may promote supply to outcome-verified evidence', () => {
  const [fact] = facts('Ada', 1), ledger = getMemoryUsageLedger(), ref = target();
  expect(() => ledger.record(ref, [memoryFactRef(fact!, 'Ada')], 'outcome_verified' as any)).toThrow('Invalid memory evidence');
  expect(ledger.coverage().completeness).toBe('recorded_events_only');
});
