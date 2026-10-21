import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initDatabase, closeDb, getDb } from './schema';
import { appendUserProfileFact, getUserProfile, getUserProfileForPrompt, saveUserProfile, syncInterviewProfileKnowledge } from './user-profile';
import { correctFact, findFacts } from './facts';
import { MemoryStream } from '../brief/memory-stream';
import { MemoryForget } from '../brief/memory-forget';
import { recordMemoryHandoff, withMemoryRecall } from './memory-use-context';
import { formatUserProfileForPrompt } from '../user/profile';
import { setSetting } from './settings';

beforeEach(() => { initDatabase(':memory:', { quiet: true }); });
afterEach(() => { closeDb(); });
const fact = { theme: 'rhythm', summary: 'Prefers morning work', raw_quote: 'I work best in the morning' };

test('interview writes appear in Memory, survive profile edits, and reconcile without duplicate evidence', async () => {
  appendUserProfileFact(fact, { deferCompletion: true });
  expect(getUserProfile()?.completed_at).toBeNull();
  const stream = new MemoryStream(getDb());
  const page = await stream.read();
  expect(page.state).toBe('ready');
  if (page.state !== 'ready') throw Error('missing interview memory');
  expect(page.data.items).toHaveLength(1);
  expect(page.data.items[0]?.sentence).toContain(fact.summary);
  expect(page.data.items[0]?.basis).toBe('reported');
  const revision = page.data.items[0]?.revision;
  syncInterviewProfileKnowledge();
  appendUserProfileFact({ ...fact, summary: fact.summary.toUpperCase() });
  const repeated = await stream.read();
  if (repeated.state !== 'ready') throw Error('lost interview memory');
  expect(repeated.data.items[0]?.revision).toBe(revision);
  saveUserProfile({ company: 'Example' });
  expect(findFacts({ predicate: 'shared about rhythm' })).toHaveLength(1);
});

test('legacy interview profiles reconcile and Forget blocks reload, unchanged saves, and prepared model context', () => {
  // This is the state written by the previously disconnected interview writer.
  setSetting('user.profile.v1', JSON.stringify({ version: 1, answers: {},
    interview_facts: [{ ...fact, recorded_at: 1 }], created_at: 1, updated_at: 1, completed_at: 1 }));
  syncInterviewProfileKnowledge();
  const row = findFacts({ predicate: 'shared about rhythm' })[0]!;
  const forget = new MemoryForget(getDb(), () => true);
  withMemoryRecall(() => {
    const prepared = formatUserProfileForPrompt(getUserProfileForPrompt())!;
    expect(prepared).toContain(fact.summary);
    const read = forget.get(row.id);
    if (read.state !== 'ready') throw Error('missing fact');
    forget.forget(row.id, { requestId: 'forget-interview', expectedRevision: read.revision, confirmed: true });
    expect(() => recordMemoryHandoff([{ role: 'system', content: prepared }])).toThrow('forgotten');
  });
  syncInterviewProfileKnowledge();
  appendUserProfileFact(fact);
  expect(findFacts({ predicate: 'shared about rhythm' })).toHaveLength(0);
  expect(getUserProfile()?.interview_facts).toHaveLength(1);
  expect(formatUserProfileForPrompt(getUserProfileForPrompt())).toBeUndefined();
});

test('correction remains authoritative after startup reconciliation and withholds the original prompt summary', () => {
  appendUserProfileFact(fact);
  const old = findFacts({ predicate: 'shared about rhythm' })[0]!;
  correctFact(old.id, 'Prefers afternoon work', 'Updated preference');
  syncInterviewProfileKnowledge();
  expect(findFacts({ predicate: 'shared about rhythm' }).map(f => f.object)).toEqual(['Prefers afternoon work']);
  expect(formatUserProfileForPrompt(getUserProfileForPrompt())).toBeUndefined();
});

test('profile acknowledgement and memory projection roll back together on a writer failure', () => {
  getDb().exec("CREATE TRIGGER fail_interview BEFORE INSERT ON fact_evidence BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  expect(() => appendUserProfileFact(fact)).toThrow('test failure');
  expect(getUserProfile()).toBeNull();
  expect(findFacts({})).toHaveLength(0);
});
