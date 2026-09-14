import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb, getDb } from './schema';
import { createEntity, findEntities } from './entities';
import { createFact, correctFact, findFacts, getFact, verifyFact, queryFact, updateFact, deleteFact } from './facts';
import { getKnowledgeForMessage } from './retrieval';
import { createFactDecisionRoutes } from './fact-routes';
import { saveUserProfile } from './user-profile';
import { extractAndStore } from './extractor';
import type { LLMManager } from '../llm/manager';

let directory: string, path: string, subject: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-facts-')); path = join(directory, 'vault.db');
  initDatabase(path); subject = createEntity('person', 'Alex').id;
});
afterEach(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });
const inference = { source: 'llm_extraction', confidence: 0.7 };

test('confirmed correction is used on the next recall and after restart; late inference stays qualified', () => {
  const before = createFact(subject, 'preferred_editor', 'Vim', inference);
  const correction = correctFact(before.id, 'Zed', 'Confirmed the current editor');
  expect(getFact(before.id)?.status).toBe('superseded');
  expect(getFact(before.id)?.superseded_by).toBe(correction.id);
  let context = getKnowledgeForMessage('Alex editor');
  expect(context).toContain('preferred_editor: Zed');
  expect(context).not.toContain('preferred_editor: Vim');
  closeDb(); initDatabase(path);
  createFact(subject, 'prefers_editor', 'Vim', { ...inference, confidence: 1 });
  context = getKnowledgeForMessage('Alex editor');
  expect(context).toContain('"basis":"confirmed"');
  expect(context).toContain('"state":"contested"');
  expect(context).toContain('"basis":"inferred"');
  expect(context).toContain('Do not use them to bind critical action inputs');
  expect(queryFact('Alex', 'preferred_editor')?.id).toBe(correction.id);
});

test('repeated inferences preserve sources without duplication or promotion', () => {
  const one = createFact(subject, 'location_is', ' Berlin ', { ...inference, sourceRef: 'capture:a' });
  const two = createFact(subject, 'location', 'berlin', { ...inference, sourceRef: 'capture:b', confidence: 1 });
  createFact(subject, 'location', 'berlin', { ...inference, sourceRef: 'capture:b', confidence: 1 });
  expect(two.id).toBe(one.id);
  expect(findFacts({ subject_id: subject })).toHaveLength(1);
  const fact = getFact(one.id)!;
  expect(fact.evidence).toHaveLength(2); expect(fact.verified_at).toBeNull(); expect(fact.binding_eligible).toBe(false);
  const context = getKnowledgeForMessage('Alex');
  expect(context).toContain('capture:a'); expect(context).toContain('capture:b');
  expect(context).toContain('"confidence":0.7'); expect(context).toContain('"confidence":1');
  expect(context).toContain(new Date(fact.created_at).toISOString());
  expect(queryFact('Alex', 'location')).toBeNull();
});

test('known single-value contradictions are contested until explicit confirmation', () => {
  const one = createFact(subject, 'birthday', 'March 15', inference);
  const two = createFact(subject, 'birthday_is', 'March 16', inference);
  expect(findFacts({ subject_id: subject }).every(f => f.status === 'contested')).toBe(true);
  expect(queryFact('Alex', 'birthday')).toBeNull();
  verifyFact(two.id, 'Checked the birthday with Alex');
  expect(getFact(one.id)?.status).toBe('superseded'); expect(queryFact('Alex', 'birthday')?.id).toBe(two.id);
});

test('locations, aliases, jobs and unknown predicates preserve multiple valid values', () => {
  for (const predicate of ['location', 'alias', 'works_at', 'email', 'custom_preference']) {
    createFact(subject, predicate, 'One', { confirmed: true });
    createFact(subject, predicate, 'Two', { confirmed: true });
    const facts = findFacts({ subject_id: subject, predicate });
    expect(facts).toHaveLength(2); expect(facts.every(f => f.status === 'active' && !f.binding_eligible)).toBe(true);
    expect(queryFact('Alex', predicate)).toBeNull();
  }
});

test('targeted location correction replaces only that location and retry retains one record', () => {
  const home = createFact(subject, 'location', 'Berlin', { confirmed: true });
  const office = createFact(subject, 'location', 'London', { confirmed: true });
  const corrected = correctFact(home.id, 'Hamburg', 'Moved home');
  expect(correctFact(home.id, 'Hamburg', 'Moved home').id).toBe(corrected.id);
  expect(getFact(office.id)?.status).toBe('active');
  expect(findFacts({ subject_id: subject })).toHaveLength(2);
  expect(() => correctFact(home.id, 'Paris', 'Different retry')).toThrow('already superseded');
});

test('scope and disjoint validity periods remain separate; expired values cannot bind', () => {
  const now = Date.now();
  createFact(subject, 'preferred_editor', 'Old', { confirmed: true, validFrom: 0, validTo: now - 100 });
  const current = createFact(subject, 'preferred_editor', 'Current', { confirmed: true, validFrom: now - 100 });
  createFact(subject, 'preferred_editor', 'Personal', { confirmed: true, scope: 'personal' });
  const expired = createFact(subject, 'primary_email', 'old@example.com', { confirmed: true, validTo: now - 100 });
  expect(getFact(expired.id)?.binding_eligible).toBe(false);
  expect(findFacts({ subject_id: subject, predicate: 'preferred_editor' })).toHaveLength(3);
  expect(queryFact('Alex', 'preferred_editor')?.id).toBe(current.id);
  expect(queryFact('Alex', 'preferred_editor', 'personal')?.object).toBe('Personal');
  expect(queryFact('Alex', 'primary_email')).toBeNull();
  expect(getKnowledgeForMessage('Alex')).toContain('"valid_to":');
  expect(getKnowledgeForMessage('Alex')).toContain('"validity":"outside recorded validity"');
  expect(getKnowledgeForMessage('Alex')).toContain('"binding_eligible":false');
});

test('overlapping but different confirmed periods are contested, not silently superseded', () => {
  createFact(subject, 'preferred_editor', 'One', { confirmed: true, validFrom: 0 });
  createFact(subject, 'preferred_editor', 'Two', { confirmed: true, validFrom: 1 });
  expect(findFacts({ subject_id: subject }).every(f => f.status === 'contested')).toBe(true);
  expect(queryFact('Alex', 'preferred_editor')).toBeNull();
});

test('paths, URLs and email local parts retain case during deduplication', () => {
  for (const predicate of ['file_path', 'url', 'primary_email']) {
    createFact(subject, predicate, '/Project/A', inference);
    createFact(subject, predicate, '/project/a', inference);
    expect(findFacts({ subject_id: subject, predicate })).toHaveLength(2);
  }
});

test('confirmation cannot be inferred from a source label or confidence', () => {
  const fact = createFact(subject, 'name', 'Alexander', { confidence: 1, source: 'user_confirmation' });
  expect(fact.basis).not.toBe('confirmed'); expect(queryFact('Alex', 'name')).toBeNull();
  verifyFact(fact.id); expect(() => updateFact(fact.id, { object: 'Bob' })).toThrow('explicit correction');
  createEntity('person', 'Alex'); expect(queryFact('Alex', 'name')).toBeNull();
});

test('atomic correction rolls back replacement, supersession and evidence on failure', () => {
  const old = createFact(subject, 'preferred_editor', 'Vim', inference);
  getDb().run("CREATE TRIGGER fail_correction BEFORE UPDATE OF status ON facts BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
  expect(() => correctFact(old.id, 'Zed', 'Explicit correction')).toThrow('simulated failure');
  expect(findFacts({ subject_id: subject, includeSuperseded: true })).toHaveLength(1);
  expect(getFact(old.id)?.status).toBe('active');
  expect(getDb().query('SELECT * FROM fact_evidence').all()).toHaveLength(1);
});

test('upgrade preserves legacy IDs/sources, consolidates duplicates and qualifies old contradictions', () => {
  closeDb(); const legacyPath = join(directory, 'legacy.db'); const db = new Database(legacyPath);
  db.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT, name TEXT, properties TEXT, created_at INTEGER, updated_at INTEGER, source TEXT);
    CREATE TABLE facts (id TEXT PRIMARY KEY, subject_id TEXT, predicate TEXT, object TEXT, confidence REAL, source TEXT, created_at INTEGER, verified_at INTEGER);
    INSERT INTO entities VALUES ('alex','person','Alex',NULL,1,1,NULL);
    INSERT INTO facts VALUES ('a','alex','birthday','March 15',0.6,'llm_extraction',1,NULL);
    INSERT INTO facts VALUES ('b','alex','birthday_is','march 15',0.8,'llm_extraction',2,NULL);
    INSERT INTO facts VALUES ('c','alex','birthday','March 16',1,'llm_extraction',3,NULL);`);
  db.close(); initDatabase(legacyPath);
  expect(findFacts({ subject_id: 'alex' })).toHaveLength(2);
  expect(getFact('b')?.superseded_by).toBe('a'); expect(getFact('a')?.evidence).toHaveLength(2);
  expect(findFacts({ subject_id: 'alex' }).every(f => f.status === 'contested')).toBe(true);
  closeDb(); initDatabase(legacyPath); expect(getFact('a')?.evidence).toHaveLength(2);
  expect(queryFact('Alex', 'birthday')).toBeNull();
});

test('profile changes retain superseded history and confirmed current answers', () => {
  saveUserProfile({ preferred_name: 'Jamie', interests: 'Chemistry' });
  const entity = findEntities({ name: 'Jamie' })[0]!;
  saveUserProfile({ preferred_name: 'Jamie', interests: 'Engineering' });
  const all = findFacts({ subject_id: entity.id, includeSuperseded: true });
  expect(all.find(f => f.object === 'Chemistry')?.status).toBe('superseded');
  expect(findFacts({ subject_id: entity.id }).find(f => f.predicate === 'interests')?.object).toBe('Engineering');
  expect(findFacts({ subject_id: entity.id }).every(f => f.basis === 'confirmed')).toBe(true);
});

test('deleting a conflicting inference clears contested state without confirming anything', () => {
  const a = createFact(subject, 'preferred_editor', 'A', inference);
  const b = createFact(subject, 'preferred_editor', 'B', inference);
  deleteFact(b.id); expect(getFact(a.id)?.status).toBe('active'); expect(queryFact('Alex', 'preferred_editor')).toBeNull();
});

test('decision routes require explicit confirmation, validate input and expose history', async () => {
  const fact = createFact(subject, 'location', 'Berlin', inference); const routes = createFactDecisionRoutes();
  const req = (body: unknown, id = fact.id) => Object.assign(new Request('http://local', { method: 'POST', body: JSON.stringify(body) }), { params: { id } });
  const confirm = routes['/api/vault/facts/:id/confirm'].POST, correct = routes['/api/vault/facts/:id/correct'].POST;
  expect((await confirm(req({ reason: 'Yes' }))).status).toBe(400);
  expect((await correct(req({ confirmed: true, reason: 'Yes', object: '', source: 'spoof' }))).status).toBe(400);
  expect((await confirm(req({ confirmed: true, reason: 'Yes' }, 'missing'))).status).toBe(404);
  expect((await correct(req({ confirmed: true, reason: 'Moved', object: 'Hamburg' }))).status).toBe(200);
  expect((await confirm(req({ confirmed: true, reason: 'Yes' }))).status).toBe(409);
  const history = await routes['/api/vault/facts/:id'].GET(req({})).json();
  expect(history.status).toBe('superseded'); expect(history.superseded_by).toBeString();
});

test('extraction cannot forge confirmation, assistant quotes or overwrite a confirmed correction', async () => {
  const original = createFact(subject, 'preferred_editor', 'Vim', inference);
  correctFact(original.id, 'Zed', 'Current editor confirmed');
  const llm = { chatTier: async () => ({ content: JSON.stringify({ entities: [{ name: 'Alex', type: 'person' }], facts: [
    { subject: 'Alex', predicate: 'preferred_editor', object: 'Vim', confidence: 1, confirmed: true, user_quote: 'Vim is confirmed' },
    { subject: 'Alex', predicate: 'location', object: 'Berlin', user_quote: 'Alex lives in Berlin', confidence: 0.8 },
    { subject: 'Alex', predicate: 'tool', object: 'Example', confidence: 'invalid' },
  ] }) }) } as unknown as LLMManager;
  await extractAndStore('Alex lives in Berlin', 'Vim is confirmed', llm);
  await extractAndStore('Alex lives in Berlin', 'Vim is confirmed', llm);
  expect(queryFact('Alex', 'preferred_editor')?.object).toBe('Zed');
  const facts = findFacts({ subject_id: subject });
  const late = facts.find(f => f.object === 'Vim')!;
  expect(late.status).toBe('contested'); expect(late.basis).toBe('inferred'); expect(late.evidence).toHaveLength(1);
  const berlin = facts.find(f => f.object === 'Berlin')!;
  expect(berlin.basis).toBe('reported'); expect(berlin.binding_eligible).toBe(false);
  expect(berlin.evidence[0]?.quote).toBe('Alex lives in Berlin');
  expect(facts.find(f => f.object === 'Example')?.confidence).toBe(0.5);
});
