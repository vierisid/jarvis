/**
 * The notch's back office against the product's real memory: what the
 * Memory sheet lists is what is remembered, and forgetting from the notch is
 * the product's own Forget.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEntity } from '../vault/entities';
import { createFact, getFact } from '../vault/facts';
import { FactSuppressedError } from '../vault/memory-suppression';
import { closeDb, getDb, initDatabase } from '../vault/schema';
import { notchForgetFact, notchKeyPairs, notchKeysRefusal, notchMemoryFacts } from './notch-office.ts';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'notch-office-')); initDatabase(join(dir, 'jarvis.db')); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('memory, as the notch lists it', () => {
  test('each fact comes with who it is about and where it came from, newest first', () => {
    const sam = createEntity('person', 'Sam Reed');
    const anna = createEntity('person', 'Anna');
    createFact(sam.id, 'prefers', 'calls', { source: 'you told me', sourceRef: 'notch:a1', quote: 'Remember that Sam prefers calls', confirmed: true });
    createFact(anna.id, 'works at', 'Northwind', { source: 'conversation', sourceRef: 'chat:1', quote: 'Anna is at Northwind now' });
    const listed = notchMemoryFacts();
    expect(listed.map(({ about, text, source }) => ({ about, text, source })).sort((a, b) => a.about.localeCompare(b.about))).toEqual([
      { about: 'Anna', text: 'works at Northwind', source: 'conversation' },
      { about: 'Sam Reed', text: 'prefers calls', source: 'you told me' },
    ]);
  });

  test('forgetting from the notch is the product\'s own Forget: the fact and its evidence are gone, and it is not learned again from the same place', () => {
    const sam = createEntity('person', 'Sam Reed');
    // Learned by itself from a conversation, as the product's own extraction learns.
    const learned = { source: 'llm_extraction', sourceRef: 'conversation:7', quote: 'Sam would rather have a call', basis: 'reported' as const };
    const fact = createFact(sam.id, 'prefers', 'calls', learned);
    expect(notchForgetFact(getDb(), fact.id)).toBe(true);
    expect(getFact(fact.id)).toBeNull();
    expect(notchMemoryFacts()).toEqual([]);
    expect((getDb().query('SELECT COUNT(*) AS n FROM fact_evidence WHERE fact_id = ?').get(fact.id) as { n: number }).n).toBe(0);
    // A receipt is kept, as for a Forget from the dashboard.
    expect((getDb().query('SELECT COUNT(*) AS n FROM memory_forget_receipts WHERE fact_id = ?').get(fact.id) as { n: number }).n).toBe(1);
    // The same thing from the same place is refused from now on.
    expect(() => createFact(sam.id, 'prefers', 'calls', learned)).toThrow(FactSuppressedError);
    // Forgetting it again is not an error: it is gone.
    expect(notchForgetFact(getDb(), fact.id)).toBe(true);
  });

  test('a fact that was never there cannot be forgotten, and says so by failing', () => {
    expect(() => notchForgetFact(getDb(), 'no-such-fact')).toThrow();
  });
});

describe('the keys, as a desktop app answers them', () => {
  test('two pairs of its own keys are taken; anything else is not an answer', () => {
    expect(notchKeyPairs({ talk: ['ctrl', 'meta'], yes: ['meta', 'alt'], mac: false })).toEqual({ talk: ['ctrl', 'meta'], yes: ['meta', 'alt'], mac: false });
    expect(notchKeyPairs({ talk: ['ctrl', 'alt'], yes: ['alt', 'meta'], mac: true })?.mac).toBe(true);
    for (const bad of [null, 'ctrl+meta', {}, { talk: ['ctrl', 'meta'] }, { talk: ['ctrl', 'ctrl'], yes: ['meta', 'alt'] }, { talk: ['ctrl', 'space'], yes: ['meta', 'alt'] }, { talk: ['ctrl'], yes: ['meta', 'alt'] }]) {
      expect(notchKeyPairs(bad)).toBeNull();
    }
  });

  test('why a pair was refused is said in a sentence, never as the machine put it', () => {
    expect(notchKeysRefusal(new Error('notch.keys: talk and yes cannot be the same two keys'))).toBe('Talk and yes cannot be the same two keys.');
    expect(notchKeysRefusal(new Error('notch.keys: the keys could not be saved: open C:\\\\Users\\\\x: access denied'))).toBe('This computer could not save them.');
    expect(notchKeysRefusal(new Error('RPC_TIMEOUT'))).toBe('This computer did not take them.');
  });
});
