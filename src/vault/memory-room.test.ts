import { test, expect, beforeEach, describe } from 'bun:test';
import { initDatabase } from './schema.ts';
import { createEntity, getEntity, findEntities } from './entities.ts';
import { createFact, findFacts } from './facts.ts';
import { createRelationship, findRelationships } from './relationships.ts';

/**
 * Phase 6.5 — covers the create chain the Memory Room (and the
 * `remember_that` voice action) drives:
 *   createEntity → createFact (subject_id) → createRelationship (from/to).
 *
 * The vault primitives are exercised independently elsewhere; this file
 * pins the integration so a regression in subject/from-id handling
 * surfaces in the test suite immediately.
 */
describe('memory room — create chain', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  test('creates an entity, attaches a fact, and links a relationship', () => {
    const alice = createEntity('person', 'Alice', { team: 'design' }, 'dashboard');
    const project = createEntity('project', 'Bone Paper Refresh', undefined, 'dashboard');

    const fact = createFact(alice.id, 'role', 'design lead', {
      confidence: 0.95,
      source: 'dashboard',
    });
    expect(fact.subject_id).toBe(alice.id);
    expect(fact.predicate).toBe('role');
    expect(fact.object).toBe('design lead');

    const rel = createRelationship(alice.id, project.id, 'leads');
    expect(rel.from_id).toBe(alice.id);
    expect(rel.to_id).toBe(project.id);
    expect(rel.type).toBe('leads');

    // findFacts(subject) should include the fact we attached.
    const facts = findFacts({ subject_id: alice.id });
    expect(facts.some((f) => f.id === fact.id)).toBe(true);

    // findRelationships(from) should include the rel.
    const rels = findRelationships({ from_id: alice.id });
    expect(rels.some((r) => r.id === rel.id)).toBe(true);
  });

  test('findEntities filters by type and name substring', () => {
    createEntity('person', 'Alice', undefined, 'test');
    createEntity('person', 'Bob', undefined, 'test');
    createEntity('project', 'Alice in Wonderland', undefined, 'test');

    const persons = findEntities({ type: 'person' });
    expect(persons.length).toBe(2);

    const aliceMatches = findEntities({ nameContains: 'Alice' });
    expect(aliceMatches.length).toBe(2);

    const personAlice = findEntities({ type: 'person', nameContains: 'Alice' });
    expect(personAlice.length).toBe(1);
    expect(personAlice[0]!.name).toBe('Alice');
  });

  test('voice "remember that" path: lookup-or-create entity then attach fact', () => {
    // Simulates what the Memory Room hook will do: find entity by name;
    // create if missing; attach the fact. Driven by the classifier
    // output `{ subject: "Alice", predicate: "role", object: "design lead" }`.
    const lookup = (name: string) =>
      findEntities({ nameContains: name }).find((e) => e.name.toLowerCase() === name.toLowerCase());

    let subject = lookup('Charlie');
    expect(subject).toBeUndefined();

    if (!subject) {
      subject = createEntity('person', 'Charlie', undefined, 'voice');
    }

    const fact = createFact(subject.id, 'birthday', '2026-04-26', {
      confidence: 0.9,
      source: 'voice',
    });

    // Re-query: the entity exists and the fact is attached.
    const refound = lookup('Charlie');
    expect(refound).toBeDefined();
    expect(refound!.id).toBe(subject.id);

    const facts = findFacts({ subject_id: subject.id });
    expect(facts.some((f) => f.id === fact.id && f.predicate === 'birthday')).toBe(true);
  });

  test('createFact rejects an unknown subject_id via FK constraint', () => {
    // Regression guard: the vault enforces a foreign key on subject_id,
    // so handing it a stale entity id throws. The Memory Room route
    // handler also pre-validates with getEntity → 404, so the user gets
    // a structured error rather than a 500. This test pins the FK so
    // we never accidentally drop it during a schema migration.
    expect(() => createFact('does-not-exist', 'p', 'o')).toThrow(/FOREIGN KEY/);
  });
});
