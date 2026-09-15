import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb, getDb } from './schema.ts';
import { createEntity } from './entities.ts';
import * as repository from './facts.ts';
import { saveUserProfile } from './user-profile.ts';
import { createRelationship } from './relationships.ts';
import { getKnowledgeForMessage, retrieveForMessage, formatKnowledgeContext } from './retrieval.ts';
import { rankRecall, recallTerms, type RecallFact } from './recall-ranking.ts';
import { packRecallContext, RECALL_LIMITS } from './recall-context.ts';
import { runRecallBenchmark } from '../../scripts/benchmark-memory-recall.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

test('development benchmark meets recall, qualification, precision and order gates', () => {
  const result = runRecallBenchmark('development');
  expect(result.rows.filter(row => !row.pass)).toEqual([]);
  expect(result.necessaryFactRecall).toBe(1);
  expect(result.qualifiedCoverage).toBe(1);
  expect(result.factPrecision).toBeGreaterThanOrEqual(0.8);
  expect(result.factCharPrecision).toBeGreaterThanOrEqual(0.8);
  expect(result.stableCases).toBe(result.cases);
});

test('partial names match whole Unicode tokens without matching substrings', () => {
  const john = createEntity('person', 'John Smith');
  repository.createFact(john.id, 'support_queue', 'Priority inbox');
  createEntity('person', 'Joanna');
  expect(getKnowledgeForMessage('John support')).toContain('Priority inbox');
  expect(getKnowledgeForMessage('Ann')).toBe('');
  expect(recallTerms('JOSÉ Jose Jose')).toEqual(['jose']);
  expect(recallTerms('отчёт')).toContain('отчет');
});

test('unrelated self requests abstain but explicit self overview still works', () => {
  saveUserProfile({ preferred_name: 'Sofia', interests: 'Cooking' });
  expect(getKnowledgeForMessage('Help me solve quantum physics')).toBe('');
  expect(getKnowledgeForMessage('My quantum physics question')).toBe('');
  expect(getKnowledgeForMessage('What do you know about me?')).toContain('Cooking');
});

test('aliases shared by different subjects preserve ambiguity and evidence qualification', () => {
  for (const name of ['North service', 'South service']) {
    const entity = createEntity('project', name);
    repository.createFact(entity.id, 'alias', 'beacon', { source: 'llm_extraction', confidence: 0.95 });
    repository.createFact(entity.id, 'endpoint', `${name.split(' ')[0]}.example`);
  }
  const context = getKnowledgeForMessage('beacon endpoint');
  expect(context).toContain('North.example');
  expect(context).toContain('South.example');
  expect(context).toContain('"basis":"inferred"');
  expect(context).toContain('"binding_eligible":false');
});

test('whole qualified facts fit the exact budget; oversize facts cannot hide small siblings', () => {
  const entity = createEntity('project', 'Atlas');
  const huge = repository.createFact(entity.id, 'notes', 'x'.repeat(3900));
  const small = repository.createFact(entity.id, 'deadline', 'Friday', { source: 'meeting', confidence: 0.7 });
  const profiles = [{ entity, facts: [huge, small], relationships: [] }];
  const context = packRecallContext(profiles, 1300);
  expect(context.length).toBeLessThanOrEqual(1300);
  expect(context).toContain('deadline: Friday');
  expect(context).toContain('"source":"meeting"');
  expect(context).not.toContain('notes:');
  expect(context).toContain('omitted');
  expect(packRecallContext(profiles, 5)).toBe('');
});

test('entity and fact budgets distribute useful context across subjects', () => {
  for (let i = 0; i < 9; i++) {
    const entity = createEntity('project', `Release ${i}`);
    for (let j = 0; j < 20; j++) repository.createFact(entity.id, `release_step_${j}`, `owner-${i}-${j}`);
  }
  const profiles = retrieveForMessage('release');
  const context = formatKnowledgeContext(profiles);
  expect(profiles.length).toBeLessThanOrEqual(6);
  expect((context.match(/\*\*Release/g) ?? []).length).toBe(6);
  expect((context.match(/  - release_step/g) ?? []).length).toBeLessThanOrEqual(RECALL_LIMITS.facts);
  expect(context.length).toBeLessThanOrEqual(RECALL_LIMITS.chars);
  expect(context).toContain('omitted');
});

test('relationship context is bounded, stable and unverified', () => {
  const entity = createEntity('person', 'Ari');
  for (let i = 0; i < 8; i++) createRelationship(entity.id, createEntity('project', `Project ${i}`).id, 'supports');
  const first = getKnowledgeForMessage('Ari');
  getDb().run('UPDATE relationships SET created_at = -created_at');
  expect(getKnowledgeForMessage('Ari')).toBe(first);
  expect((first.match(/Unverified relationship/g) ?? []).length).toBe(4);
  expect(first).toContain('omitted');
});

test('ranking respects C8 states and periods while retaining contested facts', () => {
  const entity = createEntity('person', 'Tao');
  const base = repository.createFact(entity.id, 'preferred_editor', 'Zed');
  const records: RecallFact[] = [
    { ...base, status: 'active', valid_from: 50, valid_to: 200 },
    { ...base, id: 'old', object: 'Vim', status: 'superseded' },
    { ...base, id: 'expired', object: 'Atom', valid_to: 100 },
    { ...base, id: 'future', object: 'Nova', valid_from: 101 },
    { ...base, id: 'conflict', object: 'Emacs', status: 'contested', source: 'llm_extraction' },
  ];
  const ranked = rankRecall('Tao editor', [entity], records, 100);
  expect(ranked.flatMap(profile => profile.facts.map(fact => fact.object))).toEqual(['Emacs', 'Zed']);
});

test('packing keeps C8 source references, scope, validity and contested status intact', () => {
  const entity = createEntity('person', 'Tao');
  const base = repository.createFact(entity.id, 'preferred_editor', 'Zed');
  const fact: RecallFact = { ...base, status: 'contested', basis: 'reported', scope: 'work', binding_eligible: false,
    valid_from: 1, valid_to: Date.now() + 86_400_000,
    evidence: [{ id: 'evidence-1', fact_id: base.id, basis: 'reported', source: 'conversation', source_ref: 'turn:123', quote: 'Zed for work', confidence: 0.6, recorded_at: 1 }] };
  const context = packRecallContext([{ entity, facts: [fact], relationships: [] }]);
  for (const qualification of ['"state":"contested"', '"basis":"reported"', '"scope":"work"', '"binding_eligible":false', 'turn:123', 'Zed for work', '1970-01-01T00:00:00.001Z']) {
    expect(context).toContain(qualification);
  }
});

test('default recall recovers qualified facts after a database restart', () => {
  closeDb();
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-recall-'));
  try {
    const file = join(dir, 'vault.db');
    initDatabase(file, { quiet: true });
    const entity = createEntity('person', 'Михаил');
    repository.createFact(entity.id, 'срок', 'Завтра', { source: 'meeting', confidence: 0.8 });
    const before = getKnowledgeForMessage('Михаил срок');
    closeDb(); initDatabase(file, { quiet: true });
    expect(getKnowledgeForMessage('Михаил срок')).toBe(before);
    expect(before).toContain('Завтра');
  } finally { closeDb(); rmSync(dir, { recursive: true, force: true }); }
});

const hasC8 = Reflect.has(repository, 'correctFact');
test.skipIf(!hasC8)('actual C8 corrections, periods and source ledger survive default recall', () => {
  const entity = createEntity('person', 'C8 integration');
  const create = repository.createFact as (id: string, predicate: string, object: string, options: Record<string, unknown>) => RecallFact;
  const correct = Reflect.get(repository, 'correctFact') as (id: string, object: string, reason: string) => RecallFact;
  const old = create(entity.id, 'preferred_editor', 'OldEditor', { source: 'llm_extraction' });
  correct(old.id, 'CurrentEditor', 'Confirmed by the owner');
  create(entity.id, 'preferred_editor', 'PossibleEditor', { source: 'llm_extraction', sourceRef: 'message:456', quote: 'PossibleEditor perhaps', confidence: 0.99 });
  create(entity.id, 'location', 'ExpiredPlace', { validTo: 1 });
  create(entity.id, 'location', 'FuturePlace', { validFrom: Date.now() + 1_000_000 });
  const context = getKnowledgeForMessage('C8 integration editor location');
  expect(context).toContain('CurrentEditor');
  expect(context).toContain('PossibleEditor');
  expect(context).toContain('message:456');
  expect(context).toContain('"state":"contested"');
  expect(context).not.toContain('OldEditor');
  expect(context).not.toContain('ExpiredPlace');
  expect(context).not.toContain('FuturePlace');
});
