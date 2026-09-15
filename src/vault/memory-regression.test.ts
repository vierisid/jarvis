import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initDatabase, closeDb } from './schema';
import { createEntity } from './entities';
import { createFact, findFacts, verifyFact, queryFact } from './facts';
import { getKnowledgeForMessage } from './retrieval';

beforeEach(() => { initDatabase(); });
afterEach(() => { closeDb(); });

// These use only pre-existing APIs so the regression also runs on clean main.
test('recall preserves the source and confidence of an extracted assertion', () => {
  const person = createEntity('person', 'Alex');
  createFact(person.id, 'preferred_editor', 'Vim', { confidence: 0.65, source: 'llm_extraction' });
  const context = getKnowledgeForMessage('Alex editor');
  expect(context).toContain('llm_extraction'); expect(context).toContain('0.65'); expect(context).toContain('inferred');
});
test('repeated extraction does not add duplicate facts', () => {
  const person = createEntity('person', 'Alex');
  createFact(person.id, 'location_is', 'Berlin', { source: 'llm_extraction' });
  createFact(person.id, 'location', 'berlin', { source: 'llm_extraction' });
  expect(findFacts({ subject_id: person.id })).toHaveLength(1);
});
test('confirming the corrected current preference removes the old value from next recall', () => {
  const person = createEntity('person', 'Alex');
  createFact(person.id, 'preferred_editor', 'Vim', { source: 'llm_extraction' });
  const corrected = createFact(person.id, 'preferred_editor', 'Zed', { source: 'dashboard' });
  verifyFact(corrected.id);
  const context = getKnowledgeForMessage('Alex editor');
  expect(context).toContain('preferred_editor: Zed'); expect(context).not.toContain('preferred_editor: Vim');
});
test('single-fact lookup cannot silently promote a high-confidence inference', () => {
  const person = createEntity('person', 'Alex');
  createFact(person.id, 'primary_email', 'inferred@example.com', { source: 'llm_extraction', confidence: 1 });
  expect(queryFact('Alex', 'primary_email')).toBeNull();
});
