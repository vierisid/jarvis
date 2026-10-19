import { beforeEach, afterEach, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, getDb, closeDb } from '../vault/schema';
import { createEntity } from '../vault/entities';
import { createFact, getFact, findFacts, correctFact } from '../vault/facts';
import { getKnowledgeForMessage } from '../vault/retrieval';
import { MemoryForget, MEMORY_FORGET_LIMITS } from './memory-forget';
import { FactSuppressedError } from '../vault/memory-suppression';
import { MemoryStream } from './memory-stream';
import { MemoryUsageLedger, memoryFactRef } from '../vault/memory-usage';
import { ChatTurnRepository } from '../vault/chat-turns';
import { withBriefTurn } from './chat-context';
import { withWorkflowMemory, withMemoryRecall, bindMemoryRecallStream } from '../vault/memory-use-context';
import { saveUserProfile, getUserProfile, getUserProfileForPrompt } from '../vault/user-profile';
import { formatUserProfileForPrompt } from '../user/profile';
import { extractAndStore, extractGoalCompletion } from '../vault/extractor';
import { LLMManager } from '../llm/manager';

let dir: string, file: string, service: MemoryForget, flags: Record<string, string | undefined>;
beforeEach(() => {
  flags = { JARVIS_BRIEF_MEMORY_FORGET: process.env.JARVIS_BRIEF_MEMORY_FORGET, JARVIS_BRIEF_MEMORY_USAGE: process.env.JARVIS_BRIEF_MEMORY_USAGE };
  process.env.JARVIS_BRIEF_MEMORY_FORGET = '1'; delete process.env.JARVIS_BRIEF_MEMORY_USAGE;
  dir = mkdtempSync(join(tmpdir(), 'jarvis-f19-')); file = join(dir, 'vault.db'); initDatabase(file, { quiet: true });
  service = new MemoryForget(getDb());
});
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); for (const [key, value] of Object.entries(flags)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} });
function fixture(sourceRef = 'conversation:original') {
  const entity = createEntity('person', 'Ada');
  const options = { source: 'llm_extraction', sourceRef, quote: 'PRIVATE original quote', basis: 'reported' as const };
  const fact = createFact(entity.id, 'preferred_editor', 'PRIVATE Emacs', options);
  const other = createFact(entity.id, 'works_at', 'Other company', options);
  return { entity, fact, other, options };
}
function command(id: string, requestId = crypto.randomUUID()) {
  const read = service.get(id); if (read.state !== 'ready') throw Error('No live fact');
  return { requestId, expectedRevision: read.revision, confirmed: true as const };
}
const forget = (id: string) => service.forget(id, command(id));
function llm(content: string, called: () => void = () => {}) {
  const manager = new LLMManager(); manager.registerProvider({ name: 'fixture', listModels: async () => [],
    chat: async () => { called(); return { content, model: 'fixture', finish_reason: 'stop', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 } }; }, async *stream() {} });
  manager.setTierMap({ low: { provider: 'fixture' } });
  return manager;
}

test('Forget removes only the selected fact and evidence, keeps content-free history and invalidates a cursor', async () => {
  const { fact, other } = fixture(), stream = new MemoryStream(getDb());
  const first = await stream.read({ limit: 1 }); if (!('data' in first) || !first.data.nextCursor) throw Error('No cursor');
  const result = forget(fact.id);
  expect(getFact(fact.id)).toBeNull(); expect(getFact(other.id)?.object).toBe('Other company');
  expect(getDb().query('SELECT * FROM fact_evidence WHERE fact_id = ?').all(fact.id)).toEqual([]);
  expect(getKnowledgeForMessage('Ada')).not.toContain('PRIVATE Emacs');
  expect(await stream.read({ limit: 1, cursor: first.data.nextCursor })).toMatchObject({ state: 'stale', reason: 'source_changed' });
  expect(stream.detail(fact.id, true)).toMatchObject({ state: 'forgotten', data: { factId: fact.id } });
  for (const table of ['memory_forget_receipts', 'memory_forget_suppressions']) {
    const text = JSON.stringify(getDb().query(`SELECT * FROM ${table}`).all());
    for (const secret of ['PRIVATE', 'Emacs', 'original quote', 'conversation:original', 'preferred_editor']) expect(text).not.toContain(secret);
  }
  expect(result.receipt.scope.retained).toContain('original_messages_and_source_documents');
});
test('same automatic source revision stays suppressed across restart; unrelated assertions and new source survive', () => {
  const { fact, entity, options } = fixture(); const input = command(fact.id); const first = service.forget(fact.id, input);
  closeDb(); initDatabase(file, { quiet: true }); service = new MemoryForget(getDb());
  expect(service.forget(fact.id, input)).toMatchObject({ replayed: true, receipt: first.receipt });
  expect(() => createFact(entity.id, 'prefers_editor', 'private emacs', { ...options, confidence: 0.2, quote: 'changed model quote' })).toThrow(FactSuppressedError);
  expect(createFact(entity.id, 'works_at', 'Other company', options).object).toBe('Other company');
  expect(createFact(entity.id, 'preferred_editor', 'PRIVATE Emacs', { ...options, sourceRef: 'conversation:new-input' }).id).not.toBe(fact.id);
});
test('explicit later correction can create new information without erasing the old tombstone', () => {
  const { fact, entity, options } = fixture(); forget(fact.id);
  const entered = createFact(entity.id, 'preferred_editor', 'Vim', { source: 'dashboard' });
  const confirmed = correctFact(entered.id, 'PRIVATE Emacs', 'Explicit new user correction');
  expect(confirmed.verified_at).not.toBeNull(); expect(confirmed.id).not.toBe(fact.id);
  expect(service.get(fact.id).state).toBe('forgotten');
  expect(() => createFact(entity.id, 'preferred_editor', 'PRIVATE Emacs', options)).toThrow(FactSuppressedError);
});
test('correction racing a confirmation conflicts in either ordering and never forgets the replacement', () => {
  const { fact } = fixture(), input = command(fact.id);
  const replacement = correctFact(fact.id, 'Vim', 'Explicit change');
  expect(() => service.forget(fact.id, input)).toThrow('revision_conflict');
  expect(getFact(replacement.id)?.object).toBe('Vim');
  forget(replacement.id);
  try { correctFact(replacement.id, 'Nano', 'Later correction'); throw Error('accepted'); }
  catch (error) { expect(error).toMatchObject({ status: 409 }); }
});
test('idempotency is stable and a reused request cannot delete another fact', () => {
  const { fact, other } = fixture(), input = command(fact.id); const result = service.forget(fact.id, input);
  expect(service.forget(fact.id, input).receipt).toEqual(result.receipt);
  expect(service.forget(fact.id, { ...input, requestId: 'second-request' }).receipt).toEqual(result.receipt);
  expect(() => service.forget(other.id, command(other.id, input.requestId))).toThrow('request_conflict');
  expect(() => service.forget(fact.id, { ...input, requestId: 'different-request', expectedRevision: '0'.repeat(64) })).toThrow('revision_conflict');
  expect(getFact(other.id)).not.toBeNull();
});
test('a failed deletion rolls back suppression and receipt atomically', () => {
  const { fact } = fixture(); getDb().run(`CREATE TRIGGER refuse_delete BEFORE DELETE ON facts BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END`);
  expect(() => forget(fact.id)).toThrow('fixture rollback');
  expect(getFact(fact.id)).not.toBeNull();
  expect(getDb().query('SELECT COUNT(*) AS n FROM memory_forget_receipts').get()).toEqual({ n: 0 });
  expect(getDb().query('SELECT COUNT(*) AS n FROM memory_forget_suppressions').get()).toEqual({ n: 0 });
});
test('tombstone capacity refuses the mutation without silently evicting suppression', () => {
  const { fact } = fixture();
  getDb().transaction(() => { for (let n = 0; n < MEMORY_FORGET_LIMITS.receipts; n++) getDb().run('INSERT INTO memory_forget_receipts VALUES (?, ?, ?, ?, ?)', [`old-${n}`, `req-${n}`, '0'.repeat(64), n, 0]); })();
  expect(() => forget(fact.id)).toThrow('capacity_exceeded'); expect(getFact(fact.id)).not.toBeNull();
});
test('profile re-sync skips forgotten projection and withholds its original source field from model prompts', () => {
  saveUserProfile({ preferred_name: 'Ada', interests: 'PRIVATE chemistry', work_role: 'Founder' });
  const fact = findFacts({ predicate: 'interests' })[0]!; forget(fact.id);
  expect(getUserProfile()?.answers.interests).toBe('PRIVATE chemistry');
  expect(formatUserProfileForPrompt(getUserProfileForPrompt())).not.toContain('PRIVATE chemistry');
  saveUserProfile({ ...getUserProfile()!.answers, work_role: 'CEO' });
  expect(findFacts({ predicate: 'interests' })).toEqual([]); expect(findFacts({ predicate: 'work_role' })[0]?.object).toBe('CEO');
  saveUserProfile({ ...getUserProfile()!.answers, interests: 'Physics' });
  expect(findFacts({ predicate: 'interests' })[0]?.object).toBe('Physics');
  expect(formatUserProfileForPrompt(getUserProfileForPrompt())).toContain('Physics');
});
test('derived profile aliases cannot return from an unrelated profile save', () => {
  saveUserProfile({ preferred_name: 'Ada', anything_else: 'My alias is secret_handle', work_role: 'Founder' });
  const alias = findFacts({ predicate: 'alias' })[0]!; forget(alias.id);
  saveUserProfile({ ...getUserProfile()!.answers, work_role: 'CEO' });
  expect(findFacts({ predicate: 'alias' })).toEqual([]);
  expect(formatUserProfileForPrompt(getUserProfileForPrompt())).not.toContain('secret_handle');
  expect(findFacts({ predicate: 'username' })).toHaveLength(1); // Independently stored facts are not erased.
});
test('real extractor replay cannot revive forgotten facts with different confidence or quote selection', async () => {
  let response = { entities: [{ name: 'Ada', type: 'person' }], facts: [{ subject: 'Ada', predicate: 'preferred_editor', object: 'Emacs', confidence: 0.8, user_quote: 'Emacs' }], relationships: [], commitments: [] };
  await extractAndStore('Ada uses Emacs', 'Understood', llm(JSON.stringify(response)));
  const fact = findFacts({ predicate: 'preferred_editor' })[0]!; forget(fact.id);
  response.facts[0]!.confidence = 0.4; response.facts[0]!.user_quote = 'Ada uses Emacs';
  await extractAndStore('Ada uses Emacs', 'Understood', llm(JSON.stringify(response)));
  expect(findFacts({ predicate: 'preferred_editor' })).toEqual([]);
  await extractAndStore('Ada explicitly uses Emacs again', 'Understood', llm(JSON.stringify(response)));
  expect(findFacts({ predicate: 'preferred_editor' })).toHaveLength(1);
});
test('goal completion replays skip only the forgotten performance fact', () => {
  const goal = { id: 'goal', title: 'Launch', level: 'objective', score: 1, status: 'completed', estimated_hours: 2, actual_hours: 1, created_at: 100, completed_at: 200, tags: [] };
  extractGoalCompletion(goal, 'event'); const fact = findFacts({ predicate: 'goal_final_score' })[0]!; forget(fact.id);
  extractGoalCompletion(goal, 'event'); expect(findFacts({ predicate: 'goal_final_score' })).toEqual([]);
  expect(findFacts({ predicate: 'actual_hours' })).toHaveLength(1);
  extractGoalCompletion(goal, 'later-event'); expect(findFacts({ predicate: 'goal_final_score' })).toHaveLength(1);
});
test('previous usage is explicitly forgotten without deleting immutable event evidence', () => {
  const { fact } = fixture(), turns = new ChatTurnRepository(getDb()); const ref = { conversationId: turns.conversations.create().conversationId, turnId: 'turn', requestId: 'request' };
  turns.accept({ ...ref, text: 'Ada' }); turns.start(ref);
  const usage = new MemoryUsageLedger(getDb(), () => true); usage.start();
  usage.record({ purpose: 'conversation_context', turn: ref, runId: null, workflowId: null, callId: 'turn' }, [memoryFactRef(fact, 'Ada')], 'supplied');
  const events = getDb().query('SELECT * FROM memory_use_events').all(); forget(fact.id);
  expect(usage.readTarget({ conversationId: ref.conversationId })).toMatchObject({ state: 'ready', data: { uses: [{ factId: fact.id, factState: 'forgotten' }] } });
  expect(getDb().query('SELECT * FROM memory_use_events').all()).toEqual(events);
});
for (const mode of ['conversation', 'workflow']) test(`Forget fences prepared ${mode} context even with usage logging disabled`, async () => {
  const { fact } = fixture(); let calls = 0;
  const invoke = async () => { const text = getKnowledgeForMessage('Ada'); expect(text).toContain(fact.id); forget(fact.id);
    await expect(llm('answer', () => calls++).chat([{ role: 'system', content: text }])).rejects.toThrow('forgotten'); };
  if (mode === 'workflow') await withWorkflowMemory('run', 'workflow', 'step', invoke);
  else {
    const turns = new ChatTurnRepository(getDb()); const ref = { conversationId: turns.conversations.create().conversationId, turnId: 'turn', requestId: 'request' };
    turns.accept({ ...ref, text: 'Ada' }); turns.start(ref);
    await withBriefTurn({ ...ref, signal: new AbortController().signal, progress: () => {} }, invoke);
  }
  expect(calls).toBe(0); expect(getDb().query('SELECT * FROM memory_use_events').all()).toEqual([]);
});
test('disabled, foreign-vault and malformed commands never mutate facts', () => {
  const { fact } = fixture(); const input = command(fact.id);
  for (const invalid of [null, [], { ...input, confirmed: false }, { ...input, extra: true }, { ...input, expectedRevision: 'bad' }]) {
    expect(() => service.forget(fact.id, invalid as any)).toThrow('invalid_forget_command');
  }
  delete process.env.JARVIS_BRIEF_MEMORY_FORGET; expect(() => service.forget(fact.id, input)).toThrow('unavailable');
  expect(getFact(fact.id)).not.toBeNull(); process.env.JARVIS_BRIEF_MEMORY_FORGET = '1';
  closeDb(); initDatabase(':memory:', { quiet: true }); expect(service.readiness()).toBe('unavailable');
});

test('migrated unknown provenance stays suppressed, including profile prompts, after restart', () => {
  saveUserProfile({ preferred_name: 'Ada', interests: 'Legacy secret', work_role: 'Founder' });
  const fact = findFacts({ predicate: 'interests' })[0]!;
  getDb().run("UPDATE fact_evidence SET source_ref = ?, quote = NULL WHERE fact_id = ?", [`legacy:${fact.id}`, fact.id]);
  forget(fact.id); closeDb(); initDatabase(file, { quiet: true });
  saveUserProfile({ ...getUserProfile()!.answers, work_role: 'CEO' });
  expect(findFacts({ predicate: 'interests' })).toEqual([]);
  expect(formatUserProfileForPrompt(getUserProfileForPrompt())).not.toContain('Legacy secret');
  expect(() => createFact(fact.subject_id, fact.predicate, fact.object, { source: 'user_profile', sourceRef: 'unknown-revision' })).toThrow(FactSuppressedError);
  expect(createFact(fact.subject_id, fact.predicate, fact.object, { source: 'dashboard', confirmed: true }).verified_at).not.toBeNull();
});
test('disabling new Forget actions cannot turn off existing suppression', () => {
  const { fact, entity, options } = fixture(); forget(fact.id);
  delete process.env.JARVIS_BRIEF_MEMORY_FORGET;
  expect(() => createFact(entity.id, fact.predicate, fact.object, options)).toThrow(FactSuppressedError);
});
test('profile context prepared before Forget cannot escape through a later handoff', async () => {
  saveUserProfile({ preferred_name: 'Ada', interests: 'PRIVATE chemistry' });
  let calls = 0;
  await withMemoryRecall(async () => {
    const text = formatUserProfileForPrompt(getUserProfileForPrompt())!;
    forget(findFacts({ predicate: 'interests' })[0]!.id);
    await expect(llm('answer', () => calls++).chat([{ role: 'system', content: text }])).rejects.toThrow('forgotten');
  });
  expect(calls).toBe(0);
});
test('legacy async stream retains its recall scope after preparation returns', async () => {
  const { fact } = fixture(); let calls = 0;
  const stream = withMemoryRecall(() => {
    const text = getKnowledgeForMessage('Ada');
    return bindMemoryRecallStream((async function* () { yield await llm('answer', () => calls++).chat([{ role: 'system', content: text }]); })());
  });
  forget(fact.id);
  await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('forgotten'); expect(calls).toBe(0);
});
test('canonical later input can repeat identical words while old input replay remains forgotten', async () => {
  const content = JSON.stringify({ entities: [{ name: 'Ada', type: 'person' }], facts: [{ subject: 'Ada', predicate: 'preferred_editor', object: 'Emacs' }] });
  const repo = new ChatTurnRepository(getDb());
  const accept = (turnId: string) => {
    const ref = { conversationId: repo.conversations.create().conversationId, turnId, requestId: turnId };
    repo.accept({ ...ref, text: 'Ada uses Emacs' }); repo.start(ref);
    return { ...ref, signal: new AbortController().signal, progress: () => {} };
  };
  const old = accept('old');
  // Fact learned by a pre-F19 extractor used only the text digest.
  await extractAndStore('Ada uses Emacs', 'Understood', llm(content));
  forget(findFacts({ predicate: 'preferred_editor' })[0]!.id);
  await withBriefTurn(old, () => extractAndStore('Ada uses Emacs', 'Understood', llm(content)));
  expect(findFacts({ predicate: 'preferred_editor' })).toEqual([]);
  await Bun.sleep(3); const fresh = accept('fresh');
  await withBriefTurn(fresh, () => extractAndStore('Ada uses Emacs', 'Understood', llm(content)));
  const replacement = findFacts({ predicate: 'preferred_editor' })[0]!; expect(replacement).toBeDefined();
  forget(replacement.id);
  await withBriefTurn(fresh, () => extractAndStore('Ada uses Emacs', 'Understood', llm(content)));
  expect(findFacts({ predicate: 'preferred_editor' })).toEqual([]);
});

// Review regressions: explicit source revisions must survive round trips and replay contexts.
test('a changed-back profile answer is new input, while later unrelated saves stay suppressed', () => {
  saveUserProfile({ preferred_name: 'Ada', interests: 'Chemistry', work_role: 'Founder' });
  const original = findFacts({ predicate: 'interests' })[0]!; forget(original.id);
  closeDb(); initDatabase(file, { quiet: true }); service = new MemoryForget(getDb());
  saveUserProfile({ ...getUserProfile()!.answers, work_role: 'CEO' });
  expect(findFacts({ predicate: 'interests' })).toEqual([]);
  saveUserProfile({ ...getUserProfile()!.answers, interests: 'Physics' });
  saveUserProfile({ ...getUserProfile()!.answers, interests: 'Chemistry' });
  const restored = findFacts({ predicate: 'interests' })[0]!;
  expect(restored?.object).toBe('Chemistry'); expect(restored.id).not.toBe(original.id);
  expect(getUserProfileForPrompt()?.answers.interests).toBe('Chemistry');
  forget(restored.id);
  saveUserProfile({ ...getUserProfile()!.answers, work_role: 'Engineer' });
  expect(findFacts({ predicate: 'interests' })).toEqual([]);
  expect(getUserProfileForPrompt()?.answers.interests).toBeUndefined();
  expect(service.get(original.id).state).toBe('forgotten');
});
test('removing and re-entering a profile field restores its derived alias as a fresh revision', () => {
  saveUserProfile({ preferred_name: 'Ada', anything_else: 'My alias is secret_handle' });
  const original = findFacts({ predicate: 'alias' })[0]!; forget(original.id);
  saveUserProfile({ ...getUserProfile()!.answers, anything_else: '' });
  saveUserProfile({ ...getUserProfile()!.answers, anything_else: 'My alias is secret_handle' });
  expect(findFacts({ predicate: 'alias' })[0]?.object).toBe('secret_handle');
  expect(getUserProfileForPrompt()?.answers.anything_else).toBe('My alias is secret_handle');
});
test('canonical profile correction back to a forgotten answer restores the prompt too', () => {
  saveUserProfile({ preferred_name: 'Ada', interests: 'Chemistry' });
  forget(findFacts({ predicate: 'interests' })[0]!.id);
  saveUserProfile({ ...getUserProfile()!.answers, interests: 'Physics' });
  correctFact(findFacts({ predicate: 'interests' })[0]!.id, 'Chemistry', 'Explicitly changed my answer back');
  expect(findFacts({ predicate: 'interests' })[0]?.object).toBe('Chemistry');
  expect(getUserProfileForPrompt()?.answers.interests).toBe('Chemistry');
});
for (const legacy of [false, true]) test(`old profile provenance (unknown=${legacy}) stays suppressed until its field is explicitly edited`, () => {
  saveUserProfile({ preferred_name: 'Ada', interests: 'Chemistry', work_role: 'Founder' });
  // Emulate a profile saved before per-field revision identities existed.
  if (getDb().query("SELECT 1 FROM sqlite_master WHERE name = 'memory_profile_revisions'").get()) getDb().run('DELETE FROM memory_profile_revisions');
  const fact = findFacts({ predicate: 'interests' })[0]!;
  getDb().run('UPDATE fact_evidence SET source_ref = ?, quote = ? WHERE fact_id = ?',
    [legacy ? `legacy:${fact.id}` : 'profile:answer:interests', legacy ? null : 'Chemistry', fact.id]);
  forget(fact.id); closeDb(); initDatabase(file, { quiet: true }); service = new MemoryForget(getDb());
  saveUserProfile({ ...getUserProfile()!.answers, work_role: 'CEO' });
  expect(findFacts({ predicate: 'interests' })).toEqual([]);
  expect(getUserProfileForPrompt()?.answers.interests).toBeUndefined();
  saveUserProfile({ ...getUserProfile()!.answers, interests: 'Physics' });
  saveUserProfile({ ...getUserProfile()!.answers, interests: 'Chemistry' });
  expect(findFacts({ predicate: 'interests' })[0]?.object).toBe('Chemistry');
  expect(getUserProfileForPrompt()?.answers.interests).toBe('Chemistry');
});
test('restored profile input cannot authorize a context prepared before the original Forget', async () => {
  saveUserProfile({ preferred_name: 'Ada', interests: 'Chemistry' });
  await withMemoryRecall(async () => {
    const oldText = formatUserProfileForPrompt(getUserProfileForPrompt())!;
    forget(findFacts({ predicate: 'interests' })[0]!.id);
    saveUserProfile({ ...getUserProfile()!.answers, interests: 'Physics' });
    saveUserProfile({ ...getUserProfile()!.answers, interests: 'Chemistry' });
    expect(findFacts({ predicate: 'interests' })[0]?.object).toBe('Chemistry');
    await expect(llm('answer').chat([{ role: 'system', content: oldText }])).rejects.toThrow('forgotten');
  });
  await withMemoryRecall(async () => {
    const freshText = formatUserProfileForPrompt(getUserProfileForPrompt())!;
    expect(freshText).toContain('Chemistry');
    await expect(llm('answer').chat([{ role: 'system', content: freshText }])).resolves.toMatchObject({ content: 'answer' });
    forget(findFacts({ predicate: 'interests' })[0]!.id);
    await expect(llm('answer').chat([{ role: 'system', content: freshText }])).rejects.toThrow('forgotten');
  });
});
test('scoped extraction remains forgotten on unscoped replay after restart and repeated Forget', async () => {
  const content = JSON.stringify({ entities: [{ name: 'Ada', type: 'person' }], facts: [{ subject: 'Ada', predicate: 'preferred_editor', object: 'Emacs' }] });
  const accept = (turnId: string) => {
    const repo = new ChatTurnRepository(getDb());
    const ref = { conversationId: repo.conversations.create().conversationId, turnId, requestId: turnId };
    repo.accept({ ...ref, text: 'Ada uses Emacs' }); repo.start(ref);
    return { ...ref, signal: new AbortController().signal, progress: () => {} };
  };
  const extract = () => extractAndStore('Ada uses Emacs', 'Understood', llm(content));
  const original = accept('original'); await withBriefTurn(original, extract);
  forget(findFacts({ predicate: 'preferred_editor' })[0]!.id);
  closeDb(); initDatabase(file, { quiet: true }); service = new MemoryForget(getDb());
  await extract(); expect(findFacts({ predicate: 'preferred_editor' })).toEqual([]);
  expect(new ChatTurnRepository(getDb()).get(original)?.text).toBe('Ada uses Emacs');
  await Bun.sleep(3); const fresh = accept('fresh'); await withBriefTurn(fresh, extract);
  const restored = findFacts({ predicate: 'preferred_editor' })[0]!; expect(restored).toBeDefined();
  const pending = accept('pending-before-second-forget'); await Bun.sleep(3); forget(restored.id);
  for (const ref of [original, fresh, pending]) {
    await withBriefTurn({ ...ref }, extract); expect(findFacts({ predicate: 'preferred_editor' })).toEqual([]);
  }
  await extract(); expect(findFacts({ predicate: 'preferred_editor' })).toEqual([]);
  await Bun.sleep(3); await withBriefTurn(accept('after-second-forget'), extract);
  expect(findFacts({ predicate: 'preferred_editor' })).toHaveLength(1);
});
test('re-ingestion enriches existing scoped evidence with its durable replay alias without duplicating it', async () => {
  const content = JSON.stringify({ entities: [{ name: 'Ada', type: 'person' }], facts: [{ subject: 'Ada', predicate: 'preferred_editor', object: 'Emacs' }] });
  const repo = new ChatTurnRepository(getDb());
  const ref = { conversationId: repo.conversations.create().conversationId, turnId: 'old-evidence', requestId: 'old-evidence' };
  repo.accept({ ...ref, text: 'Ada uses Emacs' }); repo.start(ref);
  const context = { ...ref, signal: new AbortController().signal, progress: () => {} };
  const extract = () => extractAndStore('Ada uses Emacs', 'Understood', llm(content));
  await withBriefTurn({ ...context }, extract);
  const fact = findFacts({ predicate: 'preferred_editor' })[0]!;
  // Reopen the pre-fix evidence schema, which did not store the replay alias.
  if (getDb().query<{ name: string }, []>('PRAGMA table_info(fact_evidence)').all().some(c => c.name === 'replay_source_ref')) {
    getDb().run('ALTER TABLE fact_evidence DROP COLUMN replay_source_ref');
  }
  closeDb(); initDatabase(file, { quiet: true }); service = new MemoryForget(getDb());
  await withBriefTurn({ ...context }, extract);
  expect(getFact(fact.id)?.evidence).toHaveLength(1);
  forget(fact.id); await extract();
  expect(findFacts({ predicate: 'preferred_editor' })).toEqual([]);
});
