/**
 * #882. A settings save stops the channel service and starts it again, which
 * builds a new TelegramAdapter. It started at offset 0, and Telegram confirms
 * an update only when a LATER getUpdates passes an offset above it, so the
 * update the old adapter was still answering was delivered again and run
 * twice.
 *
 * The fake Bot API below keeps Telegram's rule: getUpdates(offset) forgets
 * every update below `offset` and returns the rest, so re-delivery happens
 * exactly when the real one would. It honours the request's abort signal, as
 * a real socket does.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { ChannelService } from './channel-service.ts';
import { TELEGRAM_BUSY_REPLY, TELEGRAM_RESTARTING_REPLY, TELEGRAM_RESUME_MAX_AGE_MS, TELEGRAM_UPDATES_LIMIT, TelegramAdapter } from '../comms/channels/telegram.ts';

/** `token` set: only that bot's polls see it (ids are per bot). Unset: every bot's. */
type Update = { update_id: number; message: Record<string, unknown>; token?: string };

function fakeBotApi() {
  const pending: Update[] = [];
  const offsets: Array<{ token: string; offset: number }> = [];
  const replies: string[] = [];
  const signals: AbortSignal[] = [];
  let nextId = 1;
  /** Hold the next getUpdates open until released, to keep a poll in flight. */
  let hold: Promise<void> | null = null;

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const token = /\/bot([^/]+)\//.exec(url)?.[1] ?? '';
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as { offset?: number; limit?: number; text?: string; chat_id?: string };
    if (url.endsWith('/getMe')) return Response.json({ ok: true, result: { username: 'bot' } });
    if (url.endsWith('/sendMessage')) { replies.push(body.text ?? ''); return Response.json({ ok: true }); }
    if (url.endsWith('/getUpdates')) {
      const signal = init?.signal ?? undefined;
      if (signal) signals.push(signal);
      const offset = body.offset ?? 0;
      offsets.push({ token, offset });
      // Telegram forgets (confirms) everything below the offset.
      const mine = (u: Update) => u.token === undefined || u.token === token;
      for (let i = pending.length - 1; i >= 0; i--) if (mine(pending[i]!) && pending[i]!.update_id < offset) pending.splice(i, 1);
      const aborted = new Promise<never>((_, reject) => {
        if (signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
      await Promise.race([hold ?? Bun.sleep(5), aborted]);
      // At most `limit` (default 100) of them, oldest first, as Telegram does.
      const batch = pending.filter((u) => mine(u) && u.update_id >= offset).slice(0, body.limit ?? 100);
      return Response.json({ ok: true, result: batch.map(({ token: _t, ...u }) => u) });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const send = (fromId: number, text: string, token?: string) => {
    const id = nextId++;
    pending.push({ update_id: id, token, message: { message_id: id, from: { id: fromId, first_name: 'A' }, chat: { id: fromId, type: 'private' }, date: 0, text } });
    return id;
  };
  /** Strip an update's chat, as a malformed update would come. */
  const breakChat = (id: number) => { const u = pending.find((p) => p.update_id === id); if (u) delete u.message.chat; };
  return {
    fetchImpl, send, offsets, replies, signals, breakChat,
    holdPolls: () => { let release!: () => void; hold = new Promise<void>((r) => { release = r; }); return () => { hold = null; release(); }; },
  };
}

async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(5);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

/** An agent whose answer to `text` waits until released, as a long LLM turn does. */
function slowAgent() {
  const turns: string[] = [];
  const gates = new Map<string, () => void>();
  const agent = {
    handleThreadMessage: async (text: string) => {
      turns.push(text);
      if (text.startsWith('slow')) await new Promise<void>((r) => gates.set(text, r));
      return `answer to ${text}`;
    },
  };
  return { agent, turns, release: (text: string) => gates.get(text)?.() };
}

function service910(api: ReturnType<typeof fakeBotApi>) {
  globalThis.fetch = api.fetchImpl;
  const slow = slowAgent();
  const config = { channels: { telegram: { enabled: true, bot_token: 'tok', allowed_users: [42] } } };
  return { svc: new ChannelService(config as never, slow.agent as never), ...slow };
}

// The fixtures name their senders in `allowed_users` because #908 refuses to
// START an enabled channel whose list is empty -- at the default authority
// level an unlisted sender's turn gets run_command with no approval. These
// tests are about update offsets across a reload, not about the allow-list, so
// a legal list keeps the subject unchanged; an empty one would register no
// adapter and every assertion here would time out.
describe('#882: a settings reload does not re-run what the old Telegram adapter took', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { initDatabase(':memory:'); originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; closeDb(); });

  test('an update still being answered when settings are saved is answered once', async () => {
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const { agent, turns, release } = slowAgent();
    const config = { channels: { telegram: { enabled: true, bot_token: 'tok', allowed_users: [42] } } };
    const svc = new ChannelService(config as never, agent as never);
    try {
      await svc.start();
      api.send(42, 'slow question');
      await until(() => turns.length === 1, 'the first turn');

      // The save: stop and start, while the old adapter is mid-turn.
      const polls = api.offsets.length;
      await svc.stop();
      await svc.start();
      // A re-delivery lands in the new adapter's first poll.
      await until(() => api.offsets.length > polls, 'the new adapter to poll');
      await Bun.sleep(50);
      expect(turns).toEqual(['slow question']);

      release('slow question');
      await until(() => api.replies.length === 1, 'the reply');
      await Bun.sleep(30);
      expect(turns).toEqual(['slow question']);
      expect(api.replies).toEqual(['answer to slow question']);
      // And the new adapter asked from past the taken update, which confirms it.
      expect(api.offsets.at(-1)).toEqual({ token: 'tok', offset: 2 });
    } finally {
      release('slow question');
      await svc.stop();
    }
  });

  test('the rest of a batch the old adapter left unhandled still reaches the new one, once', async () => {
    // The trap #882 names. The old adapter fetched updates 1 and 2, took 1,
    // and was disconnected while answering it, so #860 drops 2 there and
    // leaves it for the new adapter, to be judged against the new list.
    // Carrying the POLL offset (3) would lose it.
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const { agent, turns, release } = slowAgent();
    const config = { channels: { telegram: { enabled: true, bot_token: 'tok', allowed_users: [7] } } };
    const svc = new ChannelService(config as never, agent as never);
    try {
      const releasePolls = api.holdPolls();
      await svc.start();
      api.send(7, 'slow question');
      api.send(7, 'second');
      releasePolls();
      await until(() => turns.length === 1, 'the first turn');

      await svc.stop();
      await svc.start();
      // It waits for the turn before it in the same chat, still answered by
      // the old adapter (#910: one turn at a time per chat).
      const polls = api.offsets.length;
      await until(() => api.offsets.length > polls, 'the new adapter to poll');
      await Bun.sleep(30);
      expect(turns).toEqual(['slow question']);

      release('slow question');
      await until(() => turns.length === 2, 'the second update to reach the new adapter');
      expect(turns).toEqual(['slow question', 'second']);
      await until(() => api.replies.length === 2, 'both answers');
      await Bun.sleep(30);
      expect(turns).toEqual(['slow question', 'second']);
      expect(api.replies.sort()).toEqual(['answer to second', 'answer to slow question']);
    } finally {
      release('slow question');
      await svc.stop();
    }
  });

  test('another bot token starts from the beginning: update ids are numbered per bot', async () => {
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const { agent, turns } = slowAgent();
    const config = { channels: { telegram: { enabled: true, bot_token: 'old', allowed_users: [42] } } };
    const svc = new ChannelService(config as never, agent as never);
    try {
      await svc.start();
      api.send(42, 'hello');
      await until(() => turns.length === 1, 'the turn');
      config.channels = { telegram: { ...config.channels.telegram, bot_token: 'new' } };
      await svc.stop();
      await svc.start();
      await until(() => api.offsets.some((o) => o.token === 'new'), 'the new bot to poll');
      expect(api.offsets.find((o) => o.token === 'new')).toEqual({ token: 'new', offset: 0 });
    } finally {
      await svc.stop();
    }
  });
});

describe('#882: disconnect aborts the long poll in flight', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  test('the request is aborted, the loop ends, and nothing is logged as an error', async () => {
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const releasePolls = api.holdPolls();
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    const adapter = new TelegramAdapter('tok');
    adapter.onMessage(async () => '');
    try {
      await adapter.connect();
      await until(() => api.signals.length === 1, 'the first poll');
      expect(api.signals[0]!.aborted).toBe(false);

      await adapter.disconnect();
      expect(api.signals[0]!.aborted).toBe(true);
      await Bun.sleep(30);
      // No second poll: the loop stopped instead of sleeping and asking again.
      expect(api.signals).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      releasePolls();
      console.error = originalError;
      await adapter.disconnect();
    }
  });
});

describe('#882 review: what the abort and the per-bot record cover', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { initDatabase(':memory:'); originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; closeDb(); });

  test('a poll whose body stalls is ended by disconnect too, not left holding the loop', async () => {
    let polls = 0;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/getMe')) return Response.json({ ok: true, result: { username: 'bot' } });
      polls++;
      // Headers arrive, the body never does.
      return { status: 200, ok: true, json: () => new Promise(() => {}) } as unknown as Response;
    }) as typeof fetch;
    const adapter = new TelegramAdapter('tok');
    adapter.onMessage(async () => '');
    // This adapter's own loop, not a log line another test's adapter could print.
    const internals = adapter as unknown as { startPolling(): Promise<void> };
    const startPolling = internals.startPolling.bind(adapter);
    let loop: Promise<void> | null = null;
    internals.startPolling = () => (loop = startPolling());
    try {
      await adapter.connect();
      await until(() => polls === 1, 'the first poll');
      await Bun.sleep(10);
      await adapter.disconnect();
      const outcome = await Promise.race([loop!.then(() => 'ended'), Bun.sleep(500).then(() => 'still running')]);
      expect(outcome).toBe('ended');
    } finally {
      await adapter.disconnect();
    }
  });

  test('switching to another bot and back resumes the first bot past what it took', async () => {
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const { agent, turns, release } = slowAgent();
    const config = { channels: { telegram: { enabled: true, bot_token: 'a', allowed_users: [42, 9] } } };
    const svc = new ChannelService(config as never, agent as never);
    try {
      await svc.start();
      api.send(42, 'slow question', 'a');
      await until(() => turns.length === 1, 'the first turn');
      const switchTo = async (token: string) => {
        config.channels = { telegram: { ...config.channels.telegram, bot_token: token } };
        await svc.stop();
        await svc.start();
      };
      await switchTo('b');
      // Bot b takes an update of its own before the owner switches back.
      api.send(9, 'to bot b', 'b');
      await until(() => turns.length === 2, 'bot b to take its update');
      await switchTo('a');
      const polls = api.offsets.length;
      await until(() => api.offsets.length > polls, 'bot a to poll again');
      await Bun.sleep(50);
      expect(api.offsets.filter((o) => o.token === 'a').at(-1)).toEqual({ token: 'a', offset: 2 });
      expect(turns).toEqual(['slow question', 'to bot b']);
    } finally {
      release('slow question');
      await svc.stop();
    }
  });
});

/**
 * #910. The poll loop awaited each update's turn before polling again, so one
 * long turn held up every later message on the channel, the owner's
 * `approve <id>` in the same private chat included.
 */
describe('#910: one long turn does not hold up the rest of the channel', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { initDatabase(':memory:'); originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; closeDb(); });

  const service = (api: ReturnType<typeof fakeBotApi>, allowed: number[]) => {
    globalThis.fetch = api.fetchImpl;
    const slow = slowAgent();
    const config = { channels: { telegram: { enabled: true, bot_token: 'tok', allowed_users: allowed } } };
    const svc = new ChannelService(config as never, slow.agent as never);
    const decisions: string[] = [];
    svc.setApprovalHandler(async (action, shortId) => { decisions.push(`${action} ${shortId}`); return `decided ${shortId}`; });
    return { svc, decisions, ...slow };
  };

  test('an approve typed in the same private chat is decided while the turn is still running', async () => {
    const api = fakeBotApi();
    const { svc, decisions, turns, release } = service(api, [42]);
    try {
      await svc.start();
      api.send(42, 'slow question');
      await until(() => turns.length === 1, 'the long turn');
      api.send(42, 'approve 1a2b3c4d');
      await until(() => api.replies.includes('decided 1a2b3c4d'), 'the decision to be answered');
      expect(decisions).toEqual(['approve 1a2b3c4d']);
      // The long turn is still unanswered: the decision did not wait for it.
      expect(api.replies).toEqual(['decided 1a2b3c4d']);
    } finally {
      release('slow question');
      await svc.stop();
    }
  });

  test('another chat is answered while the turn is still running', async () => {
    const api = fakeBotApi();
    const { svc, turns, release } = service(api, [42, 9]);
    try {
      await svc.start();
      api.send(42, 'slow question');
      await until(() => turns.length === 1, 'the long turn');
      api.send(9, 'hello');
      await until(() => api.replies.includes('answer to hello'), 'the other chat to be answered');
      expect(turns).toEqual(['slow question', 'hello']);
    } finally {
      release('slow question');
      await svc.stop();
    }
  });

  test('messages in one chat still start in order, each after the one before it ends', async () => {
    const api = fakeBotApi();
    const { svc, turns, release } = service(api, [42]);
    try {
      await svc.start();
      api.send(42, 'slow first');
      await until(() => turns.length === 1, 'the first turn');
      api.send(42, 'second');
      // Long enough for the next poll (pollingInterval is 1s) to fetch it.
      await until(() => api.offsets.length >= 3, 'the next polls');
      await Bun.sleep(30);
      expect(turns).toEqual(['slow first']);
      release('slow first');
      await until(() => api.replies.length === 2, 'both answers');
      expect(turns).toEqual(['slow first', 'second']);
      expect(api.replies).toEqual(['answer to slow first', 'answer to second']);
    } finally {
      release('slow first');
      await svc.stop();
    }
  });

  test('a reload hands the new adapter what was still waiting, after the turn before it, and not a decision already made', async () => {
    // The decision started while an earlier message in its chat still waited.
    // The new adapter must run the waiting one, once the old adapter's turn
    // in that chat has ended, and must not decide again.
    const api = fakeBotApi();
    const { svc, decisions, turns, release } = service(api, [42]);
    try {
      await svc.start();
      api.send(42, 'slow first');
      await until(() => turns.length === 1, 'the first turn');
      api.send(42, 'waiting');
      api.send(42, 'approve 1a2b3c4d');
      await until(() => decisions.length === 1, 'the decision');

      await svc.stop();
      await svc.start();
      const polls = api.offsets.length;
      await until(() => api.offsets.length > polls, 'the new adapter to poll');
      await Bun.sleep(30);
      expect(turns).toEqual(['slow first']);
      release('slow first');
      await until(() => turns.length === 2, 'the waiting message to reach the new adapter');
      const more = api.offsets.length;
      await until(() => api.offsets.length > more, 'another poll');
      await Bun.sleep(30);
      expect(turns).toEqual(['slow first', 'waiting']);
      expect(decisions).toEqual(['approve 1a2b3c4d']);
    } finally {
      release('slow first');
      await svc.stop();
    }
  });

  test('a message that starts while a poll is in flight runs once', async () => {
    // The poll was sent before the waiting message started, and its answer
    // arrives after: whatever it brings, the message must not run again.
    const api = fakeBotApi();
    const { svc, turns, release } = service(api, [42]);
    try {
      await svc.start();
      api.send(42, 'slow first');
      await until(() => turns.length === 1, 'the first turn');
      api.send(42, 'second');
      const polls = api.offsets.length;
      await until(() => api.offsets.length > polls, 'the poll that fetches the second message');
      await Bun.sleep(30);
      const releasePolls = api.holdPolls();
      const held = api.offsets.length;
      await until(() => api.offsets.length > held, 'a poll to be in flight');
      release('slow first');
      await until(() => turns.length === 2, 'the second message to start');
      releasePolls();
      const after = api.offsets.length;
      await until(() => api.offsets.length > after + 1, 'two more polls');
      await Bun.sleep(30);
      expect(turns).toEqual(['slow first', 'second']);
    } finally {
      release('slow first');
      await svc.stop();
    }
  });

  test('a flood from strangers does not keep an approve from being fetched', async () => {
    // Messages from someone the list does not name are dropped, and must not
    // stay in Telegram's 100-update window while the owner's message waits.
    const api = fakeBotApi();
    const { svc, decisions, turns, release } = service(api, [42]);
    try {
      await svc.start();
      api.send(42, 'slow first');
      await until(() => turns.length === 1, 'the first turn');
      api.send(42, 'waiting');
      for (let i = 0; i < 120; i++) api.send(666, `spam ${i}`);
      api.send(42, 'approve 1a2b3c4d');
      await until(() => decisions.length === 1, 'the approve to be fetched and decided');
      expect(turns).toEqual(['slow first']);
    } finally {
      release('slow first');
      await svc.stop();
    }
  });

  test('past the bound on waiting messages, the sender is told it was not read', async () => {
    const api = fakeBotApi();
    const { svc, turns, release } = service(api, [42]);
    try {
      await svc.start();
      api.send(42, 'slow first');
      await until(() => turns.length === 1, 'the first turn');
      for (let i = 0; i < TELEGRAM_UPDATES_LIMIT + 1; i++) api.send(42, `queued ${i}`);
      await until(() => api.replies.includes(TELEGRAM_BUSY_REPLY), 'the busy reply');
      expect(api.replies).toEqual([TELEGRAM_BUSY_REPLY]);
      release('slow first');
      await until(() => turns.length === TELEGRAM_UPDATES_LIMIT + 1, 'every queued message that was read');
      expect(turns.at(-1)).toBe(`queued ${TELEGRAM_UPDATES_LIMIT - 1}`);
    } finally {
      release('slow first');
      await svc.stop();
    }
  });
});

describe('#910 review: what the lanes must not do', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { initDatabase(':memory:'); originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; closeDb(); });

  test('a waiting message from a user the save removed is screened out by the new adapter (#860)', async () => {
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const { agent, turns, release } = slowAgent();
    const config = { channels: { telegram: { enabled: true, bot_token: 'tok', allowed_users: [42, 9] } } };
    const svc = new ChannelService(config as never, agent as never);
    try {
      await svc.start();
      api.send(9, 'slow first');
      await until(() => turns.length === 1, 'the first turn');
      api.send(9, 'from the removed user');
      const polls = api.offsets.length;
      await until(() => api.offsets.length > polls + 1, 'the waiting message to be fetched');
      config.channels = { telegram: { ...config.channels.telegram, allowed_users: [42] } };
      await svc.stop();
      await svc.start();
      release('slow first');
      await until(() => api.replies.length === 1, 'the first answer');
      const more = api.offsets.length;
      await until(() => api.offsets.length > more + 1, 'two more polls');
      await Bun.sleep(30);
      expect(turns).toEqual(['slow first']);
    } finally {
      release('slow first');
      await svc.stop();
    }
  });

  test('two settings saves during one turn still keep the chat in order', async () => {
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const { agent, turns, release } = slowAgent();
    const config = { channels: { telegram: { enabled: true, bot_token: 'tok', allowed_users: [42] } } };
    const svc = new ChannelService(config as never, agent as never);
    try {
      await svc.start();
      api.send(42, 'slow first');
      await until(() => turns.length === 1, 'the first turn');
      // Neither the second adapter nor the third ever has a lane for chat 42
      // of its own before the message below.
      await svc.stop();
      await svc.start();
      await svc.stop();
      await svc.start();
      api.send(42, 'second');
      const polls = api.offsets.length;
      await until(() => api.offsets.length > polls + 1, 'the second message to be fetched');
      await Bun.sleep(30);
      expect(turns).toEqual(['slow first']);
      release('slow first');
      await until(() => turns.length === 2, 'the second message after the turn');
      expect(turns).toEqual(['slow first', 'second']);
    } finally {
      release('slow first');
      await svc.stop();
    }
  });

  test('turning the channel off drops what waited, so turning it on later does not run it', async () => {
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const { agent, turns, release } = slowAgent();
    const config = { channels: { telegram: { enabled: true, bot_token: 'tok', allowed_users: [42] } } };
    const svc = new ChannelService(config as never, agent as never);
    try {
      await svc.start();
      api.send(42, 'slow first');
      await until(() => turns.length === 1, 'the first turn');
      api.send(42, 'delete the drafts folder');
      const polls = api.offsets.length;
      await until(() => api.offsets.length > polls + 1, 'the waiting message to be fetched');
      config.channels = { telegram: { ...config.channels.telegram, enabled: false } };
      await svc.stop();
      await svc.start();
      release('slow first');
      await until(() => api.replies.length === 1, 'the first answer');
      config.channels = { telegram: { ...config.channels.telegram, enabled: true } };
      await svc.stop();
      await svc.start();
      const more = api.offsets.length;
      await until(() => api.offsets.length > more + 1, 'the re-enabled bot to poll');
      await Bun.sleep(30);
      expect(turns).toEqual(['slow first']);
    } finally {
      release('slow first');
      await svc.stop();
    }
  });

  test('a resume point more than a week old is not used: Telegram may have renumbered', async () => {
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const first = (savedAt: number) => {
      const adapter = new TelegramAdapter('tok', { resume: { offset: 5, waiting: [], savedAt }, now: () => TELEGRAM_RESUME_MAX_AGE_MS + 1000 });
      adapter.onMessage(async () => '');
      return adapter;
    };
    for (const [savedAt, offset] of [[0, 0], [1000, 5]] as const) {
      const adapter = first(savedAt);
      const polls = api.offsets.length;
      try {
        await adapter.connect();
        await until(() => api.offsets.length > polls, 'the first poll');
        expect(api.offsets[polls]).toEqual({ token: 'tok', offset });
      } finally {
        await adapter.disconnect();
      }
    }
  });

  test('after a full batch the next one is fetched at once, so a flood cannot outpace the loop', async () => {
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const seen: string[] = [];
    const adapter = new TelegramAdapter('tok', { allowedUsers: [42] });
    adapter.onMessage(async (m) => { seen.push(m.text); return ''; });
    // Long enough that only a poll made without the pause can fetch the rest.
    (adapter as unknown as { pollingInterval: number }).pollingInterval = 60_000;
    try {
      const releasePolls = api.holdPolls();
      await adapter.connect();
      for (let i = 0; i < 150; i++) api.send(666, `spam ${i}`);
      api.send(42, 'approve 1a2b3c4d');
      releasePolls();
      await until(() => seen.length === 1, 'the reply past the first full batch');
      expect(seen).toEqual(['approve 1a2b3c4d']);
    } finally {
      await adapter.disconnect();
    }
  });

  test('a listed user past the bound is told once a minute, not once per message', async () => {
    const api = fakeBotApi();
    const { svc, turns, release } = service910(api);
    try {
      await svc.start();
      api.send(42, 'slow first');
      await until(() => turns.length === 1, 'the first turn');
      for (let i = 0; i < TELEGRAM_UPDATES_LIMIT + 5; i++) api.send(42, `queued ${i}`);
      await until(() => api.replies.includes(TELEGRAM_BUSY_REPLY), 'the busy reply');
      const polls = api.offsets.length;
      await until(() => api.offsets.length > polls + 1, 'the rest to be fetched');
      await Bun.sleep(30);
      expect(api.replies).toEqual([TELEGRAM_BUSY_REPLY]);
    } finally {
      release('slow first');
      await svc.stop();
    }
  });

  test('with no approval handler, an approve is chat and waits its turn like any other', async () => {
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const { agent, turns, release } = slowAgent();
    const config = { channels: { telegram: { enabled: true, bot_token: 'tok', allowed_users: [42] } } };
    const svc = new ChannelService(config as never, agent as never);
    try {
      await svc.start();
      api.send(42, 'slow first');
      await until(() => turns.length === 1, 'the first turn');
      api.send(42, 'approve 1a2b3c4d');
      const polls = api.offsets.length;
      await until(() => api.offsets.length > polls + 1, 'the approve to be fetched');
      await Bun.sleep(30);
      // Two turns at once on one conversation would interleave its writes.
      expect(turns).toEqual(['slow first']);
      release('slow first');
      await until(() => turns.length === 2, 'the approve as chat');
    } finally {
      release('slow first');
      await svc.stop();
    }
  });

  test('an update that cannot be read is skipped, not fetched again on every poll', async () => {
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const adapter = new TelegramAdapter('tok', { allowedUsers: [42] });
    const seen: string[] = [];
    adapter.onMessage(async (m) => { seen.push(m.text); return ''; });
    const errors = console.error;
    console.error = () => {};
    try {
      const releasePolls = api.holdPolls();
      await adapter.connect();
      const bad = api.send(42, 'no chat');
      // Malformed: a message with no chat.
      const good = api.send(42, 'fine');
      api.breakChat(bad);
      releasePolls();
      await until(() => seen.includes('fine'), 'the next update to be handled');
      await until(() => api.offsets.some((o) => o.offset > good), 'a poll past both');
      expect(seen).toEqual(['fine']);
    } finally {
      console.error = errors;
      await adapter.disconnect();
    }
  });
});

describe('#910: a message read while the daemon shuts down', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  test('is answered with a plain "send it again", since the restart will not see it', async () => {
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const adapter = new TelegramAdapter('tok', { allowedUsers: [42] });
    adapter.onMessage(async () => {
      const err = new Error('daemon is draining; not accepting new work');
      err.name = 'DrainingError';
      throw err;
    });
    try {
      await adapter.connect();
      api.send(42, 'hello');
      await until(() => api.replies.length === 1, 'the reply');
      expect(api.replies).toEqual([TELEGRAM_RESTARTING_REPLY]);
    } finally {
      await adapter.disconnect();
    }
  });
});
