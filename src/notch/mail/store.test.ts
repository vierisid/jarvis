import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MailStore, mailProposalId, type MailProposalRow } from './store.ts';
import { mailPerson } from './thread.ts';

const leo = mailPerson('Leo Bianchi', 'leo@lumen.example');
const anna = mailPerson('Anna Conti', 'anna@lumen.example');
const T = Date.UTC(2026, 10, 14, 9, 0);

const row = (extra: Partial<MailProposalRow> = {}): MailProposalRow => ({
  id: mailProposalId('19a1b2c3d4e5f607', T), thread: '19a1b2c3d4e5f607', messageAt: T, state: 'ready', who: leo, subject: 'Deck for Thursday?',
  to: [leo], cc: [anna], draft: 'Hi Leo,\nThursday at 10:00 works.\nSam', time: 'Thursday at 10:00', missing: '', lookFor: 'Lumen deck',
  found: [{ id: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', name: 'Lumen deck v3', kind: 'Google Slides' }], tone: '', told: '', about: '', model: 'm',
  tokensIn: 1200, tokensOut: 80, createdAt: T + 1, updatedAt: T + 1, sentAt: null, ...extra,
});

describe('what is remembered of a thread', () => {
  test('what the list showed, and when to look again by the clock', () => {
    const store = new MailStore(new Database(':memory:'));
    expect(store.seen('t1')).toBeNull();
    store.saw('t1', '2|leo@lumen.example|', T, T + 100);
    expect(store.seen('t1')).toEqual({ signature: '2|leo@lumen.example|', readAt: T, dueAt: T + 100 });
    expect(store.due(T + 99)).toEqual([]);
    expect(store.due(T + 100)).toEqual(['t1']);
    // Read again with nothing due: it is not looked at by the clock any more.
    store.saw('t1', '3|sam@northwind.example|', T + 200, null);
    expect(store.due(T + 10_000)).toEqual([]);
  });
});

describe('a prepared reply', () => {
  test('is kept whole, and found again after the database is opened again', () => {
    const db = new Database(':memory:');
    new MailStore(db).put(row());
    const again = new MailStore(db);
    expect(again.proposal(row().id)).toEqual(row());
    expect(again.ready().map((entry) => entry.id)).toEqual([row().id]);
  });

  // A send and a thread that moved on both want to end a reply. Only one of them does.
  test('leaves a state once: the second to try is told no', () => {
    const store = new MailStore(new Database(':memory:'));
    store.put(row());
    expect(store.move(row().id, 'ready', 'sent', T + 50)).toBe(true);
    expect(store.move(row().id, 'ready', 'answered', T + 51)).toBe(false);
    expect(store.proposal(row().id)).toMatchObject({ state: 'sent', sentAt: T + 50 });
    expect(store.ready()).toEqual([]);
  });

  test('is overtaken when its thread has a newer message waiting, or none', () => {
    const store = new MailStore(new Database(':memory:'));
    const newer = row({ id: mailProposalId('19a1b2c3d4e5f607', T + 1000), messageAt: T + 1000 });
    store.put(row());
    store.put(newer);
    store.put(row({ id: mailProposalId('29a1b2c3d4e5f607', T), thread: '29a1b2c3d4e5f607' }));
    expect(store.overtake('19a1b2c3d4e5f607', newer.id, T + 2000)).toEqual([row().id]);
    expect(store.proposal(row().id)!.state).toBe('answered');
    expect(store.ready().map((entry) => entry.id).sort()).toEqual([newer.id, mailProposalId('29a1b2c3d4e5f607', T)].sort());
    expect(store.overtake('19a1b2c3d4e5f607', null, T + 3000)).toEqual([newer.id]);
    // What was not waiting is not touched.
    store.put(row({ state: 'sent', sentAt: T + 5 }));
    expect(store.overtake('19a1b2c3d4e5f607', null, T + 4000)).toEqual([]);
  });

  test('what was sent today and what the mail has cost are read back', () => {
    const store = new MailStore(new Database(':memory:'));
    store.put(row({ state: 'sent', sentAt: T + 500 }));
    store.put(row({ id: mailProposalId('29a1b2c3d4e5f607', T), thread: '29a1b2c3d4e5f607', state: 'silent', tokensIn: 900, tokensOut: 20 }));
    store.put(row({ id: mailProposalId('39a1b2c3d4e5f607', T), thread: '39a1b2c3d4e5f607', state: 'sent', sentAt: T - 86_400_000, createdAt: T - 86_400_000 }));
    expect(store.sentSince(T).map((entry) => entry.thread)).toEqual(['19a1b2c3d4e5f607']);
    expect(store.costSince(T)).toEqual({ asked: 2, tokensIn: 2100, tokensOut: 100 });
  });

  // The owner's test brain had the table before this column existed.
  test('a table made by an earlier build gets the column for what the owner told, and its rows read as told nothing', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE notch_mail_proposals (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, message_at INTEGER NOT NULL, state TEXT NOT NULL,
      who_name TEXT NOT NULL DEFAULT '', who_address TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', to_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]', draft TEXT NOT NULL DEFAULT '', time TEXT, missing TEXT NOT NULL DEFAULT '', look_for TEXT NOT NULL DEFAULT '',
      found_json TEXT, tone TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sent_at INTEGER)`);
    db.run(`INSERT INTO notch_mail_proposals (id, thread_id, message_at, state, created_at, updated_at) VALUES ('old:1', 'old', 1, 'ready', 1, 1)`);
    const store = new MailStore(db);
    expect(store.proposal('old:1')).toMatchObject({ told: '', about: '', state: 'ready' });
    store.put(row({ told: 'Tuesday at 15:00 works', about: 'Leo wants a time for the call.' }));
    expect(store.proposal(row().id)).toMatchObject({ told: 'Tuesday at 15:00 works', about: 'Leo wants a time for the call.' });
    // Opened again: the column is not added twice.
    expect(new MailStore(db).proposal(row().id)!.told).toBe('Tuesday at 15:00 works');
  });

  test('a row written badly by an older build reads as empty lists, not as a crash', () => {
    const db = new Database(':memory:');
    const store = new MailStore(db);
    store.put(row());
    db.run(`UPDATE notch_mail_proposals SET to_json = 'not json', found_json = '{' WHERE id = ?`, [row().id]);
    expect(store.proposal(row().id)).toMatchObject({ to: [], found: null });
  });
});
