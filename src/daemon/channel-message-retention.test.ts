/**
 * #1167 (owner decision): channel conversation messages -- per-sender Telegram
 * and Discord threads and Pebble's voice exchanges -- are kept forever unless
 * `channels.message_retention_days` is set; then a daily sweep deletes the
 * older ones. The dashboard's own chat is never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { addMessage, briefTurnMessageIds, getMessages, getOrCreateConversation, PRUNE_BATCH } from '../vault/conversations.ts';
import { loadConfig } from '../config/loader.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelMessageRetentionDays, startChannelMessageRetention, sweepChannelMessages } from './channel-message-retention.ts';
import { PEBBLE_CHANNEL } from './pebble-dialogue.ts';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

/** A conversation with one message `ageDays` old and one from now. */
function seed(channel: string, sender?: string) {
  const c = getOrCreateConversation(channel, sender ? { sender } : undefined);
  const old = addMessage(c.id, { role: 'user', content: `${channel} old` });
  getDb().run('UPDATE conversation_messages SET created_at = ? WHERE id = ?', [Date.now() - 100 * DAY, old.id]);
  addMessage(c.id, { role: 'user', content: `${channel} new` });
  return c.id;
}

describe('the setting', () => {
  test('off unless a whole number of days from 1 to 3650 is set', () => {
    for (const value of [undefined, 0, -1, 1.5, 3651, '90', null, Number.NaN]) {
      expect(channelMessageRetentionDays({ conversations: { channel_message_retention_days: value as number } })).toBeNull();
    }
    expect(channelMessageRetentionDays({})).toBeNull();
    expect(channelMessageRetentionDays({ conversations: { channel_message_retention_days: 90 } })).toBe(90);
  });

  test('nothing is started, and nothing deleted, when it is not set', () => {
    const tg = seed('telegram', 'tg:1');
    let armed = 0;
    const arm = (() => { armed++; return 0; }) as unknown as typeof setInterval;
    const timers = { setInterval: arm, setTimeout: arm as unknown as typeof setTimeout, clearInterval: (() => {}) as typeof clearInterval, clearTimeout: (() => {}) as typeof clearTimeout };
    expect(startChannelMessageRetention({ conversations: {} }, timers)).toBeNull();
    expect(startChannelMessageRetention({}, timers)).toBeNull();
    expect(armed).toBe(0);
    expect(getMessages(tg)).toHaveLength(2);
  });

  test('when set, it sweeps a minute after start and then daily', () => {
    const tg = seed('telegram', 'tg:1');
    const intervals: number[] = [];
    let first: (() => void) | null = null;
    let firstDelay = 0;
    const cleared: string[] = [];
    const timers = {
      setInterval: ((_fn: () => void, ms: number) => { intervals.push(ms); return 7; }) as unknown as typeof setInterval,
      setTimeout: ((fn: () => void, ms: number) => { first = fn; firstDelay = ms; return 8; }) as unknown as typeof setTimeout,
      clearInterval: (() => { cleared.push('interval'); }) as typeof clearInterval,
      clearTimeout: (() => { cleared.push('timeout'); }) as typeof clearTimeout,
    };
    const stop = startChannelMessageRetention({ conversations: { channel_message_retention_days: 90 } }, timers);
    expect(intervals).toEqual([DAY]);
    expect(firstDelay).toBe(60_000);
    // Nothing during start itself.
    expect(getMessages(tg)).toHaveLength(2);
    first!();
    expect(getMessages(tg).map((m) => m.content)).toEqual(['telegram new']);
    stop!();
    expect(cleared.sort()).toEqual(['interval', 'timeout']);
  });
});

describe('the sweep', () => {
  test('deletes old sender and Pebble messages, keeps the dashboard and anything newer', () => {
    const tg = seed('telegram', 'tg:1');
    const dc = seed('discord', 'dc:1');
    const pebble = seed(PEBBLE_CHANNEL);
    const dashboard = seed('websocket');
    const ownerless = seed('telegram'); // a pre-#884 channel conversation with no sender

    expect(sweepChannelMessages(90)).toBe(3);
    for (const id of [tg, dc, pebble]) expect(getMessages(id)).toHaveLength(1);
    expect(getMessages(dashboard)).toHaveLength(2);
    expect(getMessages(ownerless)).toHaveLength(2);
    // The conversation row stays, its count brought in line.
    expect(getDb().query<{ message_count: number }, [string]>('SELECT message_count FROM conversations WHERE id = ?').get(tg)!.message_count).toBe(1);
  });

  test('nothing younger than the retention goes', () => {
    const tg = seed('telegram', 'tg:1');
    expect(sweepChannelMessages(365)).toBe(0);
    expect(getMessages(tg)).toHaveLength(2);
  });
});

describe('what goes with the messages', () => {
  test('a finished Brief turn posted into a sender thread goes, with its events; a running one stays', () => {
    const tg = seed('telegram', 'tg:1');
    const old = Date.now() - 100 * DAY;
    const turn = (id: string, state: string) => {
      getDb().run(`INSERT INTO brief_chat_turns (turn_id, workspace_id, conversation_id, request_id, input, state, user_message_id, assistant_message_id, created_at)
        VALUES (?, 'w', ?, ?, 'secret typed text', ?, 'u', 'a', ?)`, [id, tg, `r-${id}`, state, old]);
      getDb().run('INSERT INTO brief_chat_events (conversation_id, sequence, event_id, turn_id, payload) VALUES (?, ?, ?, ?, ?)',
        [tg, id === 'done' ? 1 : 2, `e-${id}`, id, '{"text":"secret typed text"}']);
    };
    turn('done', 'completed');
    turn('live', 'running');
    sweepChannelMessages(90);
    expect(getDb().query<{ turn_id: string }, []>('SELECT turn_id FROM brief_chat_turns').all().map((r) => r.turn_id)).toEqual(['live']);
    expect(getDb().query<{ event_id: string }, []>('SELECT event_id FROM brief_chat_events').all().map((r) => r.event_id)).toEqual(['e-live']);
  });

  // #1313 follow-up (security): a guest's next turn leaves out the rows a
  // Brief turn wrote (briefTurnMessageIds). A turn whose reply came after the
  // cutoff keeps its record while that reply is stored, or the reply would be
  // read back to the guest as the guest's own conversation.
  test('a finished turn whose reply is newer than the cutoff stays until the reply goes', () => {
    const tg = seed('telegram', 'tg:1');
    const started = Date.now() - 91 * DAY, replied = Date.now() - 89 * DAY;
    getDb().run("INSERT INTO conversation_messages (id, conversation_id, role, content, created_at) VALUES ('bu', ?, 'user', 'owner asks', ?)", [tg, started]);
    getDb().run("INSERT INTO conversation_messages (id, conversation_id, role, content, created_at) VALUES ('ba', ?, 'assistant', 'OWNER SECRET REPLY', ?)", [tg, replied]);
    getDb().run(`INSERT INTO brief_chat_turns (turn_id, workspace_id, conversation_id, request_id, input, state, user_message_id, assistant_message_id, created_at)
      VALUES ('t', 'w', ?, 'r', 'owner asks', 'completed', 'bu', 'ba', ?)`, [tg, started]);
    sweepChannelMessages(90);
    expect(getMessages(tg).map((m) => m.id)).toContain('ba');
    expect(briefTurnMessageIds(tg).has('ba')).toBe(true);
    // Once the reply is past the retention too, both go.
    sweepChannelMessages(88);
    expect(getMessages(tg).map((m) => m.id)).not.toContain('ba');
    expect(getDb().query('SELECT 1 FROM brief_chat_turns').all()).toEqual([]);
  });

  test('an attachment sent with such a turn is let go of, not a reason for the sweep to fail', () => {
    const tg = seed('telegram', 'tg:1');
    const old = Date.now() - 100 * DAY;
    getDb().run(`INSERT INTO brief_chat_turns (turn_id, workspace_id, conversation_id, request_id, input, state, user_message_id, assistant_message_id, created_at)
      VALUES ('t1', 'w', ?, 'r1', 'x', 'completed', 'u', 'a', ?)`, [tg, old]);
    getDb().run(`INSERT INTO brief_chat_attachments (attachment_id, workspace_id, conversation_id, kind, name, media_type, size, sha256, bytes, extracted_text, expires_at, state, turn_id)
      VALUES ('att1', 'w', ?, 'document', 'n.txt', 'text/plain', 3, 'h', X'616263', 'abc', ?, 'accepted', 't1')`, [tg, old]);
    expect(sweepChannelMessages(90)).toBe(1);
    expect(getDb().query('SELECT 1 FROM brief_chat_turns').all()).toEqual([]);
    expect(getDb().query('SELECT turn_id, bytes, extracted_text, state FROM brief_chat_attachments').all())
      .toEqual([{ turn_id: null, bytes: null, extracted_text: null, state: 'expired' }]);
    expect(getDb().query<{ message_count: number }, [string]>('SELECT message_count FROM conversations WHERE id = ?').get(tg)!.message_count).toBe(1);
  });

  test('more than one batch worth is all deleted', () => {
    const c = getOrCreateConversation('discord', { sender: 'dc:9' });
    const insert = getDb().prepare('INSERT INTO conversation_messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)');
    getDb().transaction(() => { for (let i = 0; i < PRUNE_BATCH * 2 + 5; i++) insert.run(`m${i}`, c.id, 'user', 'x', 1_000); })();
    expect(sweepChannelMessages(1)).toBe(PRUNE_BATCH * 2 + 5);
    expect(getMessages(c.id)).toHaveLength(0);
  });
});

describe('the setting lives in config.yaml, not in the channels section', () => {
  test('a conversations block is read from the file and leaves channels to the dashboard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-retention-'));
    try {
      const path = join(dir, 'config.yaml');
      writeFileSync(path, 'conversations:\n  channel_message_retention_days: 90\n');
      const config = await loadConfig(path);
      expect(channelMessageRetentionDays(config)).toBe(90);
      expect((config.channels as Record<string, unknown> | undefined)?.message_retention_days).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

