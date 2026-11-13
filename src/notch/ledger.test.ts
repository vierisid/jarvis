import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NOTCH_ANSWER_MAX, NotchLedger } from './ledger.ts';

function ledger() {
  let now = 1_000;
  const db = new Database(':memory:');
  return { db, ledger: new NotchLedger(db, () => now), tick: (ms = 1) => { now += ms; } };
}

describe('the ledger of what was asked on the notch', () => {
  test('a typed instruction begins as heard, a spoken one as listening', () => {
    const { ledger: l } = ledger();
    expect(l.open('a', 'typed', 'send it').state).toBe('heard');
    expect(l.open('b', 'spoken')).toMatchObject({ state: 'listening', heard: '' });
  });

  test('a row is claimed exactly once', () => {
    const { ledger: l } = ledger();
    l.open('a', 'typed', 'send it');
    expect(l.claim('a', 'turn', { conversationId: 'c', turnId: 't', requestId: 'r' })).toBe(true);
    expect(l.claim('a', 'turn', { conversationId: 'c', turnId: 't', requestId: 'r' })).toBe(false);
    expect(l.get('a')).toMatchObject({ state: 'running', kind: 'turn', turnId: 't', requestId: 'r' });
  });

  test('a recording that was turned away can never be claimed, whatever arrives after', () => {
    const { ledger: l } = ledger();
    l.open('a', 'spoken');
    expect(l.transcribing('a')).toBe(true);
    expect(l.dismiss('a')).toBe(true);
    // Its words arrive late.
    expect(l.heard('a', 'delete everything')).toBe(false);
    expect(l.claim('a', 'turn')).toBe(false);
    expect(l.get('a')).toMatchObject({ state: 'dismissed', heard: '' });
    // Dismissed while the words were already there.
    l.open('b', 'spoken');
    expect(l.heard('b', 'delete everything')).toBe(true);
    expect(l.dismiss('b')).toBe(true);
    expect(l.claim('b', 'turn')).toBe(false);
  });

  test('what is running cannot be dismissed, missed or refused', () => {
    const { ledger: l } = ledger();
    l.open('a', 'typed', 'do it');
    l.claim('a', 'turn');
    expect(l.dismiss('a')).toBe(false);
    expect(l.missed('a', 'x')).toBe(false);
    expect(l.refused('a', 'x')).toBe(false);
    expect(l.get('a')!.state).toBe('running');
  });

  test('what was done is kept in order, and the end is written once', () => {
    const { ledger: l, tick } = ledger();
    l.open('a', 'typed', 'do it');
    l.did('a', 'Too early.');
    l.claim('a', 'turn');
    l.understood('a', 'Run a command');
    l.did('a', 'Running a command.');
    l.did('a', 'Running a command.');
    l.did('a', 'Searching the web.');
    tick(50);
    expect(l.finish('a', 'done', { answer: 'All done.' })).toBe(true);
    expect(l.finish('a', 'failed', { note: 'late' })).toBe(false);
    expect(l.get('a')).toMatchObject({
      state: 'done', understood: 'Run a command', did: ['Running a command.', 'Searching the web.'], answer: 'All done.', endedAt: 1_050,
    });
    l.did('a', 'After the end.');
    expect(l.get('a')!.did).toHaveLength(2);
  });

  test('a very long answer is cut to what the ledger keeps', () => {
    const { ledger: l } = ledger();
    l.open('a', 'typed', 'write');
    l.claim('a', 'turn');
    l.finish('a', 'done', { answer: 'x'.repeat(NOTCH_ANSWER_MAX + 10) });
    expect(l.get('a')!.answer).toHaveLength(NOTCH_ANSWER_MAX);
  });

  test('unseen results are the ones that ran and were not closed', () => {
    const { ledger: l, tick } = ledger();
    for (const id of ['a', 'b', 'c', 'd']) { l.open(id, 'typed', id); tick(); }
    l.claim('a', 'turn'); l.finish('a', 'done', { answer: 'A' });
    l.claim('b', 'turn'); l.finish('b', 'failed', { note: 'no' });
    l.dismiss('c');
    l.seen('a');
    expect(l.unseen().map((row) => row.id)).toEqual(['b']);
    expect(l.unfinished().map((row) => row.id)).toEqual(['d']);
    expect(l.recent(10).map((row) => row.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  test('the table survives being opened again', () => {
    const { db, ledger: l } = ledger();
    l.open('a', 'typed', 'kept');
    expect(new NotchLedger(db).get('a')?.heard).toBe('kept');
  });
});
