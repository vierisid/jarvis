/**
 * #1155. What bounds a channel turn once it is admitted: one cap on how many
 * run at once across every chat and channel, a cap on each guest's turns, and
 * a turn whose sender is removed (or stops being the owner) mid-turn runs no
 * further tool and sends no reply.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  CHANNEL_BUSY_REPLY, CHANNEL_MAX_CONCURRENT_TURNS, CHANNEL_MAX_WAITING_TURNS, ChannelSenderRevokedError,
  ChannelService, GUEST_CAP_REPLY, GUEST_ONE_AT_A_TIME_REPLY, GUEST_TURN_WINDOW_MS, GUEST_TURNS_PER_WINDOW,
} from './channel-service.ts';
import type { ChannelMessage } from '../comms/channels/telegram.ts';
import { checkpointExecution } from '../actions/execution-scope.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';

const OWNER = 42;
const GUEST = 7;

const msg = (userId: number, text: string, chat = userId): ChannelMessage => ({
  id: 'm', channel: 'telegram', from: 'someone', text, timestamp: 0,
  metadata: { chatId: chat, userId, chatType: 'private' },
  senderAllowListed: true,
});

/** An agent whose turn for `text` waits until released, then dispatches once (as a tool call does). */
function gatedAgent() {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const dispatch: Array<{ text: string; refused: unknown }> = [];
  let running = 0;
  let peak = 0;
  const agent = {
    handleThreadMessage: async (text: string) => {
      started.push(text);
      running++;
      peak = Math.max(peak, running);
      try {
        if (text.startsWith('slow')) await new Promise<void>((r) => gates.set(text, r));
        let refused: unknown = null;
        try { checkpointExecution(); } catch (err) { refused = err; }
        dispatch.push({ text, refused });
        return `answer to ${text}`;
      } finally {
        running--;
      }
    },
  };
  return {
    agent, started, dispatch, peak: () => peak,
    release: (text: string) => gates.get(text)?.(),
  };
}

function service(allowed: number[], now?: () => number) {
  const config = { channels: { telegram: { enabled: false, bot_token: '', allowed_users: allowed } } };
  const a = gatedAgent();
  const svc = new ChannelService(config as never, a.agent as never, now ? { now } : undefined);
  const handle = (m: ChannelMessage) =>
    (svc as unknown as { handleChannelMessage(m: ChannelMessage): Promise<string> }).handleChannelMessage(m);
  return { config, handle, ...a };
}

async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(2);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

describe('#1155: a channel turn whose sender is removed mid-turn', () => {
  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDb());

  test('runs no further tool and sends no reply once the owner is removed from the list', async () => {
    const { config, handle, started, dispatch, release } = service([OWNER, GUEST]);
    const reply = handle(msg(OWNER, 'slow work'));
    await until(() => started.length === 1, 'the turn to start');
    config.channels.telegram.allowed_users = [GUEST];
    release('slow work');
    expect(await reply).toBe('');
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]!.refused).toBeInstanceOf(ChannelSenderRevokedError);
    // The reply is not kept as the conversation's answer either.
    const rows = getDb().query("SELECT role FROM conversation_messages ORDER BY created_at").all() as Array<{ role: string }>;
    expect(rows.map((r) => r.role)).toEqual(['user']);
  });

  test('stopping being the owner counts too: the turn was started with the owner\'s tools', async () => {
    const { config, handle, started, dispatch, release } = service([OWNER, GUEST]);
    const reply = handle(msg(OWNER, 'slow work'));
    await until(() => started.length === 1, 'the turn to start');
    config.channels.telegram.allowed_users = [GUEST, OWNER];
    release('slow work');
    expect(await reply).toBe('');
    expect(dispatch[0]!.refused).toBeInstanceOf(ChannelSenderRevokedError);
  });

  test('not vacuous: with the list unchanged the turn dispatches and its reply is sent', async () => {
    const { handle, started, dispatch, release } = service([OWNER, GUEST]);
    const reply = handle(msg(OWNER, 'slow work'));
    await until(() => started.length === 1, 'the turn to start');
    release('slow work');
    expect(await reply).toBe('answer to slow work');
    expect(dispatch[0]!.refused).toBeNull();
  });
});

describe('#1155: one cap on channel turns running at once', () => {
  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDb());

  test(`at most ${CHANNEL_MAX_CONCURRENT_TURNS} run at once; the rest wait their turn, in order`, async () => {
    // Every chat a different listed user's, so no per-chat order is involved.
    const users = Array.from({ length: CHANNEL_MAX_CONCURRENT_TURNS + 2 }, (_, i) => 100 + i);
    const { handle, started, peak, release } = service([OWNER, ...users, 99]);
    const replies = users.map((u) => handle(msg(u, `slow ${u}`)));
    await until(() => started.length === CHANNEL_MAX_CONCURRENT_TURNS, 'the first turns to start');
    await Bun.sleep(20);
    expect(started).toHaveLength(CHANNEL_MAX_CONCURRENT_TURNS);
    release(`slow ${users[0]}`);
    await until(() => started.length === CHANNEL_MAX_CONCURRENT_TURNS + 1, 'a waiting turn to start');
    expect(started.at(-1)).toBe(`slow ${users[CHANNEL_MAX_CONCURRENT_TURNS]}`);
    // The slot was handed over, not freed: a message arriving now waits too.
    const late = handle(msg(99, 'slow late'));
    await Bun.sleep(20);
    expect(started).not.toContain('slow late');
    expect(peak()).toBe(CHANNEL_MAX_CONCURRENT_TURNS);
    for (;;) {
      for (const u of users) release(`slow ${u}`);
      release('slow late');
      if (started.includes('slow late')) break;
      await Bun.sleep(2);
    }
    release('slow late');
    await Promise.all([...replies, late]);
    expect(peak()).toBe(CHANNEL_MAX_CONCURRENT_TURNS);
  });

  test('past the waiting bound the sender is told to send it again, and no turn starts', async () => {
    const users = Array.from({ length: CHANNEL_MAX_CONCURRENT_TURNS + CHANNEL_MAX_WAITING_TURNS + 1 }, (_, i) => 1000 + i);
    const { handle, started, release } = service([OWNER, ...users]);
    // Guests have their own cap; each sends one message here.
    const replies = users.map((u) => handle(msg(u, `slow ${u}`)));
    expect(await replies.at(-1)).toBe(CHANNEL_BUSY_REPLY);
    expect(started).toHaveLength(CHANNEL_MAX_CONCURRENT_TURNS);
    for (;;) {
      for (const u of users) release(`slow ${u}`);
      if (started.length >= users.length - 1) break;
      await Bun.sleep(2);
    }
    for (const u of users) release(`slow ${u}`);
    await Promise.all(replies.slice(0, -1));
    expect(started).toHaveLength(users.length - 1);
  });

  test('an approve or deny does not wait for a slot: it touches no conversation', async () => {
    const users = Array.from({ length: CHANNEL_MAX_CONCURRENT_TURNS }, (_, i) => 100 + i);
    const config = { channels: { telegram: { enabled: false, bot_token: '', allowed_users: [OWNER, ...users] } } };
    const a = gatedAgent();
    const svc = new ChannelService(config as never, a.agent as never);
    svc.setApprovalHandler(async () => 'decided');
    const handle = (m: ChannelMessage) =>
      (svc as unknown as { handleChannelMessage(m: ChannelMessage): Promise<string> }).handleChannelMessage(m);
    const replies = users.map((u) => handle(msg(u, `slow ${u}`)));
    await until(() => a.started.length === CHANNEL_MAX_CONCURRENT_TURNS, 'every slot to fill');
    expect(await handle(msg(OWNER, 'approve 1a2b3c4d'))).toBe('decided');
    for (const u of users) a.release(`slow ${u}`);
    await Promise.all(replies);
  });
});

describe('#1155: each guest has a cap on their turns', () => {
  test('a message refused as busy does not count against the guest', async () => {
    initDatabase(':memory:');
    try {
      const others = Array.from({ length: CHANNEL_MAX_CONCURRENT_TURNS + CHANNEL_MAX_WAITING_TURNS }, (_, i) => 1000 + i);
      const { handle, started, release } = service([OWNER, GUEST, ...others]);
      const filling = others.map((u) => handle(msg(u, `slow ${u}`)));
      for (let i = 0; i < 3; i++) expect(await handle(msg(GUEST, 'busy?'))).toBe(CHANNEL_BUSY_REPLY);
      for (;;) {
        for (const u of others) release(`slow ${u}`);
        if (started.length >= others.length) break;
        await Bun.sleep(2);
      }
      for (const u of others) release(`slow ${u}`);
      await Promise.all(filling);
      for (let i = 0; i < GUEST_TURNS_PER_WINDOW; i++) expect(await handle(msg(GUEST, `hello ${i}`))).toBe(`answer to hello ${i}`);
      expect(await handle(msg(GUEST, 'one more'))).toBe(GUEST_CAP_REPLY);
    } finally {
      closeDb();
    }
  });

  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDb());

  test(`a guest gets ${GUEST_TURNS_PER_WINDOW} turns in the window, then is told why; the window moves on`, async () => {
    let now = 1_000_000;
    const { handle, started } = service([OWNER, GUEST], () => now);
    for (let i = 0; i < GUEST_TURNS_PER_WINDOW; i++) {
      expect(await handle(msg(GUEST, `hello ${i}`))).toBe(`answer to hello ${i}`);
    }
    expect(await handle(msg(GUEST, 'one more'))).toBe(GUEST_CAP_REPLY);
    expect(started).toHaveLength(GUEST_TURNS_PER_WINDOW);
    // The owner is not a guest and is not capped.
    expect(await handle(msg(OWNER, 'owner turn'))).toBe('answer to owner turn');
    now += GUEST_TURN_WINDOW_MS;
    expect(await handle(msg(GUEST, 'later'))).toBe('answer to later');
  });
});

describe('#1155 review: a capped guest does not wait in the shared queue', () => {
  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDb());

  test('past their cap, a guest is told at once even while every slot is busy, and takes no place in the queue', async () => {
    const others = Array.from({ length: CHANNEL_MAX_CONCURRENT_TURNS }, (_, i) => 1000 + i);
    const { handle, started, release } = service([OWNER, GUEST, ...others]);
    for (let i = 0; i < GUEST_TURNS_PER_WINDOW; i++) await handle(msg(GUEST, `hello ${i}`));
    const busy = others.map((u) => handle(msg(u, `slow ${u}`)));
    await until(() => started.length === GUEST_TURNS_PER_WINDOW + CHANNEL_MAX_CONCURRENT_TURNS, 'every slot to fill');
    // Answered without waiting for a slot: a waiting one would hang here.
    expect(await handle(msg(GUEST, 'one more'))).toBe(GUEST_CAP_REPLY);
    for (const u of others) release(`slow ${u}`);
    await Promise.all(busy);
  });
});

describe('#1155 final review: one guest\'s burst cannot fill the queue', () => {
  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDb());

  test('a guest has one turn running or waiting at a time; the owner is still answered', async () => {
    const { handle, started, release } = service([OWNER, GUEST]);
    // As Discord delivers them: all at once, none awaited.
    const burst = Array.from({ length: CHANNEL_MAX_CONCURRENT_TURNS + CHANNEL_MAX_WAITING_TURNS + 5 }, (_, i) => handle(msg(GUEST, `slow ${i}`)));
    const replies = await Promise.all(burst.slice(1));
    expect(replies.every((r) => r === GUEST_ONE_AT_A_TIME_REPLY)).toBe(true);
    expect(started).toEqual(['slow 0']);
    expect(await handle(msg(OWNER, 'hello'))).toBe('answer to hello');
    release('slow 0');
    expect(await burst[0]).toBe('answer to slow 0');
    // Answered, they may write again, and only the turn that ran counted.
    expect(await handle(msg(GUEST, 'next'))).toBe('answer to next');
  });
});
