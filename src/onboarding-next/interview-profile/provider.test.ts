import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, initDatabase } from '../../vault/schema.ts';
import { appendUserProfileFact, clearUserProfile, getUserProfile, saveUserProfile } from '../../vault/user-profile.ts';
import { getSetting, setSetting } from '../../vault/settings.ts';
import { USER_PROFILE_SETTING_KEY } from '../../user/profile.ts';
import { createCanonicalInterviewProfileStore, createInterviewProfileProvider } from './index.ts';
import { factId, receiptKey } from './provider.ts';
import type { CommitInput, Store, Transaction } from './types.ts';

const owner = { actorId: 'owner', projectId: 'project' };
const fact = { theme: 'work', summary: 'Builds an app' };
const input = (overrides: Partial<CommitInput> = {}): CommitInput => ({ scope: owner, sessionId: 'session', turnId: 'turn',
  clientRequestId: 'request', attemptId: 'attempt', facts: [fact], wrap: false,
  signal: new AbortController().signal, isCurrent: () => true, ...overrides });
let dir: string, path: string, store: Store;
const provider = (s = store) => createInterviewProfileProvider({ enabled: true, store: s });
const wrapStore = (alter: (tx: Transaction) => Transaction): Store => ({ transaction(scope, work) {
  return store.transaction(scope, tx => work(alter(tx)));
} });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'on-b-05-')); path = join(dir, 'vault.db');
  initDatabase(path, { quiet: true });
  store = createCanonicalInterviewProfileStore({ owner, database: getDb });
});
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('canonical atomic acknowledgements', () => {
  test('default-off and missing storage have no effects', async () => {
    await expect(createInterviewProfileProvider({ store }).commit(input())).rejects.toThrow('unavailable');
    await expect(createInterviewProfileProvider({ enabled: true }).commit(input())).rejects.toThrow('unavailable');
    expect(getUserProfile()).toBeNull();
  });
  test('confirms unique persisted identities, never completing on a fact alone', async () => {
    const result = await provider().commit(input({ facts: [fact, { ...fact, theme: ' WORK ', summary: ' Builds an app ' },
      { theme: 'goals', summary: 'Launch a pilot' }] }));
    expect(result.confirmedFactIds).toEqual([factId(owner, fact), factId(owner, { theme: 'goals', summary: 'Launch a pilot' })]);
    expect(getUserProfile()?.interview_facts).toHaveLength(2);
    expect(getUserProfile()?.completed_at).toBeNull();
  });
  test('existing legacy facts deduplicate without rewriting timestamps or quotes', async () => {
    appendUserProfileFact({ ...fact, raw_quote: 'Original quote' });
    const before = getSetting(USER_PROFILE_SETTING_KEY);
    const result = await provider().commit(input({ facts: [{ theme: 'WORK', summary: 'BUILDS AN APP', raw_quote: 'new quote' }] }));
    expect(result.confirmedFactIds).toEqual([factId(owner, fact)]);
    expect(getSetting(USER_PROFILE_SETTING_KEY)).toBe(before);
  });
  test('one transaction stores facts before completion and receipt', async () => {
    const order: string[] = [];
    const s = wrapStore(tx => ({ ...tx, append(f) { order.push('fact'); tx.append(f); expect(tx.readProfile()?.completed_at).toBeNull(); },
      wrap() { order.push('wrap'); expect(tx.readProfile()?.interview_facts).toHaveLength(1); tx.wrap(); },
      writeReceipt(k, r) { order.push('receipt'); tx.writeReceipt(k, r); } }));
    await provider(s).commit(input({ wrap: true }));
    expect(order).toEqual(['fact', 'wrap', 'receipt']);
    expect(getUserProfile()?.completed_at).toBeNumber();
  });
  test.each(['append', 'wrap', 'receipt'] as const)('%s failure rolls back facts and completion, retry succeeds once', async stage => {
    const broken = wrapStore(tx => ({ ...tx,
      append(f) { tx.append(f); if (stage === 'append') throw new Error('private fact'); },
      wrap() { tx.wrap(); if (stage === 'wrap') throw new Error('private wrap'); },
      writeReceipt(k, r) { tx.writeReceipt(k, r); if (stage === 'receipt') throw new Error('private receipt'); },
    }));
    await expect(provider(broken).commit(input({ wrap: true }))).rejects.toThrow('storage_unavailable');
    expect(getUserProfile()).toBeNull();
    expect(getSetting(receiptKey(owner, 'attempt'))).toBeNull();
    const first = await provider().commit(input({ wrap: true }));
    const saved = getSetting(USER_PROFILE_SETTING_KEY);
    expect(await provider().commit(input({ wrap: true }))).toEqual(first);
    expect(getSetting(USER_PROFILE_SETTING_KEY)).toBe(saved);
    expect(getUserProfile()?.interview_facts).toHaveLength(1);
  });
  test('later failure preserves earlier facts and wizard corrections', async () => {
    saveUserProfile({ preferred_name: 'Corrected name' });
    await provider().commit(input());
    const previous = getSetting(USER_PROFILE_SETTING_KEY);
    await expect(provider(wrapStore(tx => ({ ...tx, wrap() { throw Error('disk'); } }))).commit(input({
      attemptId: 'next', facts: [{ theme: 'tools', summary: 'Uses Calendar, not Gmail' }], wrap: true,
    }))).rejects.toThrow('storage_unavailable');
    expect(getSetting(USER_PROFILE_SETTING_KEY)).toBe(previous);
    expect(getUserProfile()?.answers.preferred_name).toBe('Corrected name');
  });
  test('lost acknowledgement survives close/reopen and never reruns canonical effects', async () => {
    const committed = await provider().commit(input({ wrap: true }));
    const raw = getSetting(USER_PROFILE_SETTING_KEY);
    closeDb(); initDatabase(path, { quiet: true });
    const noEffects = wrapStore(tx => ({ ...tx, append() { throw Error('duplicate'); }, wrap() { throw Error('duplicate'); },
      writeReceipt() { throw Error('duplicate'); } }));
    expect(await provider(noEffects).commit(input({ wrap: true }))).toEqual(committed);
    expect(getSetting(USER_PROFILE_SETTING_KEY)).toBe(raw);
  });
  test('simultaneous commits and repeated facts under new attempts do not inflate count', async () => {
    let writes = 0;
    const p = provider(wrapStore(tx => ({ ...tx, append(f) { writes++; tx.append(f); } })));
    const results = await Promise.all([p.commit(input()), p.commit(input()), p.commit(input({ attemptId: 'other' }))]);
    expect(writes).toBe(1);
    expect(new Set(results.flatMap(r => r.confirmedFactIds)).size).toBe(1);
    expect(getUserProfile()?.interview_facts).toHaveLength(1);
  });
  test.each(['facts', 'wrap', 'sessionId', 'turnId', 'clientRequestId'] as const)('changed %s cannot reuse an attempt', async key => {
    await provider().commit(input());
    const changed = key === 'facts' ? [{ ...fact, summary: 'Correction' }] : key === 'wrap' ? true : 'different';
    await expect(provider().commit(input({ [key]: changed }))).rejects.toThrow('conflict');
    expect(getUserProfile()?.interview_facts).toHaveLength(1);
    expect(getUserProfile()?.completed_at).toBeNull();
  });
  test('receipt reconciliation never resurrects a forgotten profile', async () => {
    await provider().commit(input({ wrap: true })); clearUserProfile();
    await expect(provider().commit(input({ wrap: true }))).rejects.toThrow('profile_changed');
    expect(getUserProfile()).toBeNull();
  });
  test('external correction invalidates old acknowledgement instead of restoring its old text', async () => {
    await provider().commit(input());
    const profile = getUserProfile()!; profile.interview_facts![0]!.summary = 'Builds a service';
    setSetting(USER_PROFILE_SETTING_KEY, JSON.stringify(profile));
    await expect(provider().commit(input())).rejects.toThrow('profile_changed');
    expect(getUserProfile()?.interview_facts?.[0]?.summary).toBe('Builds a service');
  });
  test('early wrap and unknown routines store no invented facts', async () => {
    expect(await provider().commit(input({ facts: [], wrap: true }))).toEqual({ confirmedFactIds: [] });
    expect(getUserProfile()?.interview_facts ?? []).toEqual([]);
    expect(getUserProfile()?.completed_at).toBeNumber();
  });
  test('abort, skip or lost lease cannot commit any part of a batch', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(provider().commit(input({ signal: abort.signal }))).rejects.toThrow('stale');
    await expect(provider().commit(input({ isCurrent: () => false }))).rejects.toThrow('stale');
    let current = true;
    const s = wrapStore(tx => ({ ...tx, append(f) { tx.append(f); current = false; } }));
    await expect(provider(s).commit(input({ wrap: true, isCurrent: () => current }))).rejects.toThrow('stale');
    expect(getUserProfile()).toBeNull();
  });
  test('wrong owner and wrong canonical database are rejected', async () => {
    await expect(provider().commit(input({ scope: { ...owner, actorId: 'stranger' } }))).rejects.toThrow('stale');
    const old = getDb(); initDatabase(':memory:', { quiet: true });
    const wrong = createCanonicalInterviewProfileStore({ owner, database: () => old });
    await expect(provider(wrong).commit(input())).rejects.toThrow('storage_unavailable');
    expect(getUserProfile()).toBeNull();
  });
  test.each(['null', '{"version":2}', '{broken', '{"version":1,"answers":{}}'])('corrupt canonical profile is retained: %s', async raw => {
    setSetting(USER_PROFILE_SETTING_KEY, raw);
    // JSON null is a present corrupt record too, not a missing profile.
    await expect(provider().commit(input())).rejects.toThrow('storage_unavailable');
    expect(getSetting(USER_PROFILE_SETTING_KEY)).toBe(raw);
  });
  test('unknown receipt version stays intact and blocks replay', async () => {
    setSetting(receiptKey(owner, 'attempt'), '{"schemaVersion":2}');
    await expect(provider().commit(input())).rejects.toThrow('storage_unavailable');
    expect(getUserProfile()).toBeNull();
    expect(getSetting(receiptKey(owner, 'attempt'))).toBe('{"schemaVersion":2}');
  });
  test.each([
    [{ theme: 'workflow', summary: 'run immediately' }], [{ theme: 'work', summary: ' ' }],
    [{ theme: 'work', summary: 'x'.repeat(121) }], [{ theme: 'work', summary: 'x', raw_quote: 'x'.repeat(4001) }],
    Array.from({ length: 129 }, () => fact),
  ].map(facts => ({ facts })))('invalid model facts never partially persist', async ({ facts }) => {
    await expect(provider().commit(input({ facts: facts as CommitInput['facts'] }))).rejects.toThrow('invalid_input');
    expect(getUserProfile()).toBeNull();
  });
  test('a writer returning without persistence cannot acknowledge success', async () => {
    await expect(provider(wrapStore(tx => ({ ...tx, append() {} }))).commit(input())).rejects.toThrow('storage_unavailable');
    await expect(provider(wrapStore(tx => ({ ...tx, wrap() {} }))).commit(input({ facts: [], wrap: true }))).rejects.toThrow('storage_unavailable');
    expect(getSetting(receiptKey(owner, 'attempt'))).toBeNull();
  });
  test('receipts contain only opaque identities, never fact text or raw quote', async () => {
    await provider().commit(input({ facts: [{ ...fact, raw_quote: 'My private phrasing' }] }));
    const raw = getSetting(receiptKey(owner, 'attempt'))!;
    expect(raw).not.toContain(fact.summary); expect(raw).not.toContain('My private');
    expect(raw).not.toContain('session'); expect(raw).not.toContain('owner');
  });
});
