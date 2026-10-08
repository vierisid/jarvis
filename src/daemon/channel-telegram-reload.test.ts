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
import { TelegramAdapter } from '../comms/channels/telegram.ts';

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
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as { offset?: number; text?: string };
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
      return Response.json({ ok: true, result: pending.filter((u) => mine(u) && u.update_id >= offset).map(({ token: _t, ...u }) => u) });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const send = (fromId: number, text: string, token?: string) => {
    const id = nextId++;
    pending.push({ update_id: id, token, message: { message_id: id, from: { id: fromId, first_name: 'A' }, chat: { id: fromId, type: 'private' }, date: 0, text } });
    return id;
  };
  return {
    fetchImpl, send, offsets, replies, signals,
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

describe('#882: a settings reload does not re-run what the old Telegram adapter took', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { initDatabase(':memory:'); originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; closeDb(); });

  test('an update still being answered when settings are saved is answered once', async () => {
    const api = fakeBotApi();
    globalThis.fetch = api.fetchImpl;
    const { agent, turns, release } = slowAgent();
    const config = { channels: { telegram: { enabled: true, bot_token: 'tok', allowed_users: [] as number[] } } };
    const svc = new ChannelService(config as never, agent as never);
    try {
      await svc.start();
      api.send(42, 'slow question');
      await until(() => turns.length === 1, 'the first turn');

      // The save: stop and start, while the old adapter is mid-turn. It
      // polls no more: it is still inside the turn its last poll returned.
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
    const config = { channels: { telegram: { enabled: true, bot_token: 'tok', allowed_users: [] as number[] } } };
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
      await until(() => turns.length === 2, 'the second update to reach the new adapter');
      expect(turns).toEqual(['slow question', 'second']);

      release('slow question');
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
    const config = { channels: { telegram: { enabled: true, bot_token: 'old', allowed_users: [] as number[] } } };
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
    const config = { channels: { telegram: { enabled: true, bot_token: 'a', allowed_users: [] as number[] } } };
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
