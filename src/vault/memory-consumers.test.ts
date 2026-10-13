import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, closeDb, getDb } from './schema';
import { createEntity, updateEntity } from './entities';
import { createFact, correctFact, deleteFact, findFacts, getFact, queryFact } from './facts';
import { getKnowledgeForMessage } from './retrieval';
import { clearUserProfile, getUserProfile, getUserProfileForPrompt, saveUserProfile } from './user-profile';
import { withMemoryRecall, recordMemoryHandoff } from './memory-use-context';
import { MemoryForget } from '../brief/memory-forget';
import { MemoryStream } from '../brief/memory-stream';
import { ToolRegistry } from '../actions/tools/registry';
import { createComposerLlmClient } from '../actions/tools/composer-llm';
import { extractAndStore, extractGoalCompletion } from './extractor';
import { ChatTurnRepository } from './chat-turns';
import { withBriefTurn } from '../brief/chat-context';
import { LLMManager } from '../llm/manager';

let dir: string, file: string, flags: Array<string | undefined>;
const flagNames = ['JARVIS_BRIEF_MEMORY_USAGE', 'JARVIS_BRIEF_MEMORY_STREAM', 'JARVIS_BRIEF_MEMORY_FORGET'];
beforeEach(() => {
  flags = flagNames.map(key => process.env[key]);
  for (const key of flagNames) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'q16-consumers-')); file = join(dir, 'vault.db');
  initDatabase(file, { quiet: true });
});
afterEach(() => {
  closeDb(); rmSync(dir, { recursive: true, force: true });
  flagNames.forEach((key, i) => { if (flags[i] === undefined) delete process.env[key]; else process.env[key] = flags[i]; });
});
const handoff = (text: string) => recordMemoryHandoff([{ role: 'system', content: text }]);
function fixture() {
  const entity = createEntity('person', 'Ada Finch');
  const fact = createFact(entity.id, 'primary_email', 'old@example.test', { confirmed: true });
  return { entity, fact };
}
function forget(id: string) {
  const service = new MemoryForget(getDb(), () => true), prepared = service.get(id);
  if (prepared.state !== 'ready') throw Error('Expected live fact');
  return service.forget(id, { requestId: crypto.randomUUID(), expectedRevision: prepared.revision, confirmed: true });
}

for (const change of ['correct', 'delete', 'expire', 'rename', 'evidence', 'forget'] as const) {
  test(`prepared canonical recall refuses ${change} with usage logging off`, () => {
    const { entity, fact } = fixture();
    withMemoryRecall(() => {
      const text = getKnowledgeForMessage('Ada Finch primary email');
      expect(text).toContain(fact.id);
      if (change === 'correct') correctFact(fact.id, 'new@example.test', 'Explicit correction');
      if (change === 'delete') deleteFact(fact.id);
      if (change === 'expire') getDb().run('UPDATE facts SET valid_to = ? WHERE id = ?', [Date.now() - 1, fact.id]);
      if (change === 'rename') updateEntity(entity.id, { name: 'Different identity' });
      if (change === 'evidence') createFact(entity.id, fact.predicate, fact.object, { source: 'new_evidence', quote: 'New qualification' });
      if (change === 'forget') forget(fact.id);
      expect(() => handoff(text)).toThrow(/changed|forgotten/);
    });
    expect(getDb().query('SELECT * FROM memory_use_events').all()).toEqual([]);
    withMemoryRecall(() => handoff(getKnowledgeForMessage('Ada Finch primary email')));
  });
}

for (const change of ['correct', 'edit', 'changed_back', 'clear', 'reset'] as const) {
  test(`prepared profile context refuses ${change} independent of fact recall`, () => {
    saveUserProfile({ preferred_name: 'Ada Finch', interests: 'Chemistry' });
    withMemoryRecall(() => {
      const profile = getUserProfileForPrompt()!;
      if (change === 'correct') correctFact(findFacts({ predicate: 'interests' })[0]!.id, 'Physics', 'Correction');
      else if (change === 'reset') clearUserProfile();
      else {
        saveUserProfile({ preferred_name: 'Ada Finch', interests: change === 'clear' ? '' : 'Physics' });
        if (change === 'changed_back') saveUserProfile({ preferred_name: 'Ada Finch', interests: 'Chemistry' });
      }
      expect(() => handoff(JSON.stringify(profile.answers))).toThrow(/changed|forgotten/);
    });
    withMemoryRecall(() => handoff(JSON.stringify(getUserProfileForPrompt()?.answers ?? {})));
  });
}

test('saving unchanged profile answers does not invalidate captured profile fields', () => {
  const profile = saveUserProfile({ preferred_name: 'Ada Finch', interests: 'Chemistry' });
  withMemoryRecall(() => {
    getUserProfileForPrompt(); saveUserProfile(profile.answers);
    expect(() => handoff('Profile fields')).not.toThrow();
  });
});

for (const predicate of ['primary_email', 'location']) test(`replayed corrected ${predicate} retains its historical ID without a new active contradiction`, () => {
  const entity = createEntity('person', 'Ada Finch');
  const options = { source: 'llm_extraction', sourceRef: 'conversation:original', quote: 'Original source', confidence: .6 };
  const old = createFact(entity.id, predicate, 'Old value', options);
  const corrected = correctFact(old.id, 'Current value', 'Explicit correction');
  closeDb(); initDatabase(file, { quiet: true });
  const replay = createFact(entity.id, predicate, 'Old value', { ...options, confidence: .9 });
  expect(replay.id).toBe(old.id);
  expect(replay.status).toBe('superseded');
  expect(findFacts({ subject_id: entity.id }).map(f => f.id)).toEqual([corrected.id]);
  expect(queryFact('Ada Finch', predicate)?.id).toBe(corrected.id);
  expect(getKnowledgeForMessage(`Ada Finch ${predicate}`)).not.toContain('Old value');
  // New evidence is still allowed; an explicit new assertion is not a replay.
  expect(createFact(entity.id, predicate, 'Old value', { ...options, sourceRef: 'conversation:new' }).id).not.toBe(old.id);
});

test('explicit correction of a derived profile alias survives unrelated profile saves and restart', () => {
  saveUserProfile({ preferred_name: 'Ada Finch', work_role: 'My alias is oldhandle' });
  const old = findFacts({ predicate: 'alias' })[0]!;
  let corrected!: ReturnType<typeof correctFact>;
  withMemoryRecall(() => {
    getUserProfileForPrompt();
    corrected = correctFact(old.id, 'newhandle', 'Correct extracted alias');
    expect(() => handoff('Profile paragraph')).toThrow('changed');
  });
  closeDb(); initDatabase(file, { quiet: true });
  saveUserProfile({ ...getUserProfile()!.answers, interests: 'Physics' });
  expect(findFacts({ predicate: 'alias' }).map(f => f.id)).toEqual([corrected.id]);
  expect(getFact(old.id)?.status).toBe('superseded');
  expect(getUserProfile()?.answers.work_role).toContain('oldhandle');
  expect(getUserProfileForPrompt()?.answers.work_role).toBeUndefined();
  expect(getKnowledgeForMessage('Ada Finch alias')).toContain('newhandle');
});

test('a stale correction conflicts while the accepted profile correction survives synchronization', () => {
  saveUserProfile({ preferred_name: 'Ada Finch', interests: 'Chemistry' });
  const old = findFacts({ predicate: 'interests' })[0]!;
  const corrected = correctFact(old.id, 'Physics', 'Explicit edit');
  expect(() => correctFact(old.id, 'Geology', 'Stale editor')).toThrow('superseded');
  saveUserProfile({ ...getUserProfile()!.answers, work_role: 'Founder' });
  closeDb(); initDatabase(file, { quiet: true });
  expect(getUserProfileForPrompt()?.answers.interests).toBe('Physics');
  expect(findFacts({ predicate: 'interests' }).map(f => f.id)).toEqual([corrected.id]);
});

for (const mutation of ['correct', 'forget'] as const) test(`a ${mutation} capture cannot supply derived composer requests or dispatch a tool`, async () => {
  const { fact } = fixture(); let providerCalls = 0, toolCalls = 0;
  const manager = new LLMManager();
  manager.registerProvider({ name: 'fixture', listModels: async () => [], chat: async () => {
    providerCalls++; return { content: '{}', model: 'fixture', finish_reason: 'stop', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 } };
  }, async *stream() {} });
  manager.setTierMap({ high: { provider: 'fixture' } });
  const registry = new ToolRegistry();
  registry.register({ name: 'fixture_action', description: 'Count local dispatch only', category: 'fixture', parameters: {}, execute: async () => { toolCalls++; } });
  await withMemoryRecall(async () => {
    getKnowledgeForMessage('Ada Finch primary email');
    if (mutation === 'correct') correctFact(fact.id, 'new@example.test', 'Edit after planning');
    else forget(fact.id);
    // The downstream request carries a derived value, not the original memory block.
    await expect(createComposerLlmClient(manager).chat({ prompt: 'Prepare an email to old@example.test' })).rejects.toThrow(/changed|forgotten/);
    await expect(createComposerLlmClient(manager).chatTools!([{ role: 'user', content: 'Prepare an email to old@example.test' }], [])).rejects.toThrow(/changed|forgotten/);
    await expect(registry.execute('fixture_action', {})).rejects.toThrow(/changed|forgotten/);
  });
  expect(providerCalls).toBe(0); expect(toolCalls).toBe(0);
});

test('interleaved consumers invalidate only the execution holding the changed fact', async () => {
  const { fact } = fixture();
  createFact(createEntity('person', 'Bruno Vale').id, 'primary_email', 'bruno@example.test', { confirmed: true });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = withMemoryRecall(async () => {
    const text = getKnowledgeForMessage('Ada Finch primary email'); await gate;
    expect(() => handoff(text)).toThrow('changed');
  });
  await withMemoryRecall(async () => {
    const text = getKnowledgeForMessage('Bruno Vale primary email');
    correctFact(fact.id, 'new@example.test', 'Concurrent edit');
    expect(() => handoff(text)).not.toThrow();
  });
  release(); await waiting;
});

test('stream cache invalidates on correction, Forget and restart instead of serving stale pages', async () => {
  process.env.JARVIS_BRIEF_MEMORY_STREAM = '1';
  const { entity, fact } = fixture(); createFact(entity.id, 'note', 'Second fact');
  const stream = new MemoryStream(getDb());
  const first = await stream.read({ limit: 1 });
  if (first.state !== 'ready' || !first.data.nextCursor) throw Error('Expected pagination');
  correctFact(fact.id, 'new@example.test', 'Correction');
  expect((await stream.read({ limit: 1, cursor: first.data.nextCursor })).state).toBe('stale');
  const second = await stream.read({ limit: 1 });
  if (second.state !== 'ready' || !second.data.nextCursor) throw Error('Expected pagination');
  forget(findFacts({ predicate: 'primary_email' })[0]!.id);
  expect((await stream.read({ limit: 1, cursor: second.data.nextCursor })).state).toBe('stale');
  closeDb(); initDatabase(file, { quiet: true });
  expect((await new MemoryStream(getDb()).read({ limit: 1, cursor: first.data.nextCursor })).state).toBe('stale');
  expect(queryFact('Ada Finch', 'primary_email')).toBeNull();
});

for (const scoped of [false, true]) test(`real extractor correction survives ${scoped ? 'canonical-turn' : 'legacy'} source replay and restart`, async () => {
  const llm = new LLMManager();
  let confidence = .6, quote = 'Emacs';
  llm.registerProvider({ name: 'fixture', listModels: async () => [], async *stream() {}, chat: async () => ({
    content: JSON.stringify({ entities: [{ name: 'Ada Finch', type: 'person' }], facts: [{ subject: 'Ada Finch', predicate: 'location', object: 'Emacs', confidence, user_quote: quote }] }),
    tool_calls: [], model: 'fixture', finish_reason: 'stop', usage: { input_tokens: 0, output_tokens: 0 },
  }) });
  llm.setTierMap({ low: { provider: 'fixture' } });
  const accept = () => {
    const repo = new ChatTurnRepository(getDb());
    const ref = { conversationId: repo.conversations.create().conversationId, turnId: crypto.randomUUID(), requestId: crypto.randomUUID() };
    repo.accept({ ...ref, text: 'Ada Finch lives in Emacs' }); repo.start(ref);
    return { ...ref, signal: new AbortController().signal, progress: () => {} };
  };
  const context = accept();
  const extract = () => extractAndStore('Ada Finch lives in Emacs', 'Understood', llm);
  if (scoped) await withBriefTurn(context, extract); else await extract();
  const old = findFacts({ predicate: 'location' })[0]!;
  const replacement = correctFact(old.id, 'Vim', 'Owner correction');
  closeDb(); initDatabase(file, { quiet: true }); confidence = .9; quote = 'Ada Finch lives in Emacs';
  if (scoped) await withBriefTurn(context, extract); else await extract();
  await extract(); // A scoped source can also be retried by a legacy caller.
  expect(findFacts({ predicate: 'location' }).map(f => f.id)).toEqual([replacement.id]);
  expect(getFact(old.id)?.status).toBe('superseded');
  await withBriefTurn(accept(), extract); // A genuinely new canonical turn is new evidence.
  expect(findFacts({ predicate: 'location' })).toHaveLength(2);
});

test('correction replay suppression respects assertion scope and validity, and allows explicit restoration', () => {
  const entity = createEntity('person', 'Ada Finch');
  const source = { source: 'llm_extraction', sourceRef: 'conversation:one' };
  const old = createFact(entity.id, 'location', 'Paris', { ...source, scope: 'work', validFrom: 1, validTo: 10 });
  correctFact(old.id, 'Rome', 'Correction');
  expect(createFact(entity.id, 'location', 'Paris', { ...source, scope: 'work', validFrom: 1, validTo: 10 }).id).toBe(old.id);
  expect(createFact(entity.id, 'location', 'Paris', { ...source, scope: 'home', validFrom: 1, validTo: 10 }).status).toBe('active');
  expect(createFact(entity.id, 'location', 'Paris', { ...source, scope: 'work', validFrom: 11, validTo: 20 }).status).toBe('active');
  expect(createFact(entity.id, 'location', 'Paris', { confirmed: true, source: 'user_confirmation', scope: 'work', validFrom: 1, validTo: 10 }).status).toBe('active');
});

test('corrected goal completion facts stay retired on replay of the same episode', () => {
  const goal = { id: 'goal', title: 'Launch', level: 'objective', score: .8, status: 'completed', estimated_hours: 2, actual_hours: 1, created_at: 100, completed_at: 200, tags: [] };
  extractGoalCompletion(goal, 'episode');
  const old = findFacts({ predicate: 'goal_final_score' })[0]!;
  const corrected = correctFact(old.id, '0.90', 'Correct episode measurement');
  closeDb(); initDatabase(file, { quiet: true });
  extractGoalCompletion(goal, 'episode');
  expect(findFacts({ predicate: 'goal_final_score' }).map(f => f.id)).toEqual([corrected.id]);
  extractGoalCompletion(goal, 'later-episode');
  expect(findFacts({ predicate: 'goal_final_score' })).toHaveLength(2);
});
