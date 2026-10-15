import { test, expect, describe } from 'bun:test';
import { TelegramAdapter, TelegramSendError, telegramErrorFromResponse, telegramSendBody, type ChannelMessage } from './telegram.ts';

describe('telegramErrorFromResponse', () => {
  test('returns null for a successful response', () => {
    expect(telegramErrorFromResponse(200, { ok: true, result: {} })).toBeNull();
  });

  test('surfaces retry_after as retryAfterMs on 429', () => {
    const error = telegramErrorFromResponse(429, {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 27',
      parameters: { retry_after: 27 },
    });

    expect(error).toBeInstanceOf(TelegramSendError);
    expect(error!.status).toBe(429);
    expect(error!.retryAfterMs).toBe(27_000);
    expect(error!.message).toContain('429');
  });

  test('recognizes a 429 from the body error_code even if the HTTP status differs', () => {
    const error = telegramErrorFromResponse(200, {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 5',
      parameters: { retry_after: 5 },
    });

    expect(error!.status).toBe(429);
    expect(error!.retryAfterMs).toBe(5_000);
  });

  test('handles a 429 with missing or garbled parameters', () => {
    const error = telegramErrorFromResponse(429, {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 'soon' },
    });

    expect(error!.retryAfterMs).toBeUndefined();
    expect(error!.message).toContain('429');
  });

  test('returns a plain send error without retryAfterMs for non-429 failures', () => {
    const error = telegramErrorFromResponse(400, {
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found',
    });

    expect(error!.status).toBe(400);
    expect(error!.retryAfterMs).toBeUndefined();
    expect(error!.message).toBe('Telegram API error: Bad Request: chat not found');
  });

  test('falls back to the HTTP status when the body has no description', () => {
    const error = telegramErrorFromResponse(502, null);

    expect(error!.status).toBe(502);
    expect(error!.message).toBe('Telegram API error: HTTP 502');
  });
});

describe('sendMessage chunking', () => {
  test('tags a mid-chunk failure with the unsent remainder for resumable retries', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return { status: 200, json: async () => ({ ok: true }) };
      }
      return {
        status: 429,
        json: async () => ({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 3',
          parameters: { retry_after: 3 },
        }),
      };
    }) as unknown as typeof fetch;

    try {
      const adapter = new TelegramAdapter('test-token');
      // 5000 chars with no newlines splits into a 4096 chunk and a 904 chunk.
      const text = 'a'.repeat(5000);

      let thrown: unknown;
      try {
        await adapter.sendMessage('chat-1', text);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(TelegramSendError);
      const sendError = thrown as TelegramSendError & { remainingText?: string };
      expect(sendError.retryAfterMs).toBe(3_000);
      expect(sendError.remainingText).toBe('a'.repeat(904));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('maps a 5xx with a non-JSON body through the status code so it stays retriable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    })) as unknown as typeof fetch;

    try {
      const adapter = new TelegramAdapter('test-token');

      let thrown: unknown;
      try {
        await adapter.sendMessage('chat-1', 'hi');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(TelegramSendError);
      expect((thrown as TelegramSendError).status).toBe(502);
      expect((thrown as TelegramSendError).message).toBe('Telegram API error: HTTP 502');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * #718. Every Telegram message was sent with `parse_mode: 'Markdown'`, the
 * approval card included, so a label's `[text](url)` showed only its text and
 * a `_` or `*` pair vanished from what was being approved.
 */
describe('#718: literal text is sent without parse_mode', () => {
  test('the literal body has no parse_mode and no link preview; the default keeps Markdown', () => {
    expect(telegramSendBody('c1', 'x', { literal: true })).toEqual({ chat_id: 'c1', text: 'x', link_preview_options: { is_disabled: true } });
    expect(telegramSendBody('c1', 'x')).toEqual({ chat_id: 'c1', text: 'x', parse_mode: 'Markdown' });
  });

  test('sendMessage posts exactly that body for a literal send', async () => {
    const originalFetch = globalThis.fetch;
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return { status: 200, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;
    try {
      const card = 'Intent: run: rm -rf /tmp/a_b_c [docs](https://x.example)';
      await new TelegramAdapter('test-token').sendMessage('chat-1', card, { literal: true });
      await new TelegramAdapter('test-token').sendMessage('chat-1', 'a *reply*');
      expect(bodies).toEqual([
        { chat_id: 'chat-1', text: card, link_preview_options: { is_disabled: true } },
        { chat_id: 'chat-1', text: 'a *reply*', parse_mode: 'Markdown' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * #811. An empty allow-list admits everyone to chat; the message says the
 * sender was not named by a list, so the channel service refuses a decision.
 */
describe('#811: senderAllowListed', () => {
  const deliver = async (allowedUsers: number[] | undefined, fromId: number) => {
    const adapter = new TelegramAdapter('test-token', allowedUsers ? { allowedUsers } : undefined);
    const seen: ChannelMessage[] = [];
    adapter.onMessage(async (m) => { seen.push(m); return ''; });
    await (adapter as unknown as { processUpdate(u: unknown): Promise<void> }).processUpdate({
      update_id: 1,
      message: { message_id: 7, from: { id: fromId, first_name: 'A' }, chat: { id: 99, type: 'private' }, date: 0, text: 'approve 1a2b3c4d' },
    });
    return seen;
  };

  test('is false for every sender while the list is empty', async () => {
    for (const list of [undefined, []]) {
      const seen = await deliver(list, 42);
      expect(seen.length).toBe(1);
      expect(seen[0]!.senderAllowListed).toBe(false);
    }
  });

  test('is true for a sender the list names', async () => {
    const seen = await deliver([42], 42);
    expect(seen[0]!.senderAllowListed).toBe(true);
  });

  test('a sender a non-empty list does not name is still dropped before the handler', async () => {
    expect(await deliver([42], 43)).toEqual([]);
  });
});

/**
 * #860. A settings save disconnects this adapter and builds a new one with the
 * new allow-list, but a long poll already in flight can still return a batch.
 */
describe('#860: a batch that lands after disconnect is not handled', () => {
  test('it is left for the new adapter instead of being judged against the old list', async () => {
    let releasePoll!: () => void;
    const pollReturned = new Promise<void>((resolve) => { releasePoll = resolve; });
    let polls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/getMe')) return Response.json({ ok: true, result: { username: 'bot' } });
      if (url.endsWith('/getUpdates')) {
        polls++;
        await pollReturned;
        return Response.json({ ok: true, result: [{
          update_id: 1,
          message: { message_id: 7, from: { id: 42, first_name: 'A' }, chat: { id: 42, type: 'private' }, date: 0, text: 'approve 1a2b3c4d' },
        }] });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      const adapter = new TelegramAdapter('test-token', { allowedUsers: [42] });
      const seen: ChannelMessage[] = [];
      adapter.onMessage(async (m) => { seen.push(m); return ''; });
      await adapter.connect();
      for (let i = 0; i < 100 && polls === 0; i++) await Bun.sleep(5);
      expect(polls).toBe(1);

      await adapter.disconnect();
      releasePoll();
      await Bun.sleep(50);

      expect(seen).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * #883. The gate was `allowedUsers.includes(id)` on whatever the setting held,
 * and a string's `.includes` is a substring test.
 */
describe('#883: an allowed_users value that is not a list of ids', () => {
  const reaches = async (allowedUsers: unknown, fromId: number) => {
    const adapter = new TelegramAdapter('test-token', { allowedUsers });
    const seen: ChannelMessage[] = [];
    adapter.onMessage(async (m) => { seen.push(m); return ''; });
    await (adapter as unknown as { processUpdate(u: unknown): Promise<void> }).processUpdate({
      update_id: 1,
      message: { message_id: 7, from: { id: fromId, first_name: 'A' }, chat: { id: fromId, type: 'private' }, date: 0, text: 'hello' },
    });
    return seen;
  };

  test('a string is not a substring match: "12345" lets in neither 123 nor 234 nor 12345', async () => {
    for (const id of [123, 234, 1234, 12345]) {
      expect(await reaches('12345', id)).toEqual([]);
    }
  });

  test('a list of entries that name nobody lets nobody in, rather than everyone', async () => {
    expect(await reaches(['042'], 42)).toEqual([]);
    expect(await reaches([1.5], 1)).toEqual([]);
  });

  test('the valid entries of a mixed list still work, and only they are allow-listed', async () => {
    const seen = await reaches(['042', 42], 42);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.senderAllowListed).toBe(true);
  });
});

/**
 * #885. Telegram gives every message sent on behalf of a chat the same
 * placeholder sender: 1087968824 (GroupAnonymousBot) for anonymous group
 * admins, 136817688 (Channel_Bot) for "send as channel" and a linked channel's
 * automatic forwards. `sender_chat` is what marks them.
 */
describe('#885: a message sent on behalf of a chat is not handled', () => {
  const GROUP_ANONYMOUS_BOT = 1087968824;
  const CHANNEL_BOT = 136817688;
  const handled = async (allowedUsers: number[], message: Record<string, unknown>) => {
    const adapter = new TelegramAdapter('test-token', { allowedUsers });
    const seen: ChannelMessage[] = [];
    adapter.onMessage(async (m) => { seen.push(m); return ''; });
    await (adapter as unknown as { processUpdate(u: unknown): Promise<void> }).processUpdate({
      update_id: 1,
      message: { message_id: 7, chat: { id: -100123, type: 'supergroup' }, date: 0, text: 'approve 1a2b3c4d', ...message },
    });
    return seen;
  };

  test('an anonymous admin is dropped even when the shared id is listed', async () => {
    const msg = { from: { id: GROUP_ANONYMOUS_BOT, first_name: 'Group', username: 'GroupAnonymousBot' }, sender_chat: { id: -100123, type: 'supergroup', title: 'Any group' } };
    expect(await handled([GROUP_ANONYMOUS_BOT], msg)).toEqual([]);
    // And on an empty list, where anyone may chat, it still cannot.
    expect(await handled([], msg)).toEqual([]);
  });

  test('a post sent as a channel is dropped too', async () => {
    const msg = { from: { id: CHANNEL_BOT, first_name: 'Channel', username: 'Channel_Bot' }, sender_chat: { id: -100999, type: 'channel', title: 'A channel' } };
    expect(await handled([CHANNEL_BOT], msg)).toEqual([]);
    expect(await handled([], msg)).toEqual([]);
  });

  test('a message with no sender at all is dropped instead of throwing', async () => {
    expect(await handled([], {})).toEqual([]);
  });

  test('an ordinary member of the same group is still handled', async () => {
    const seen = await handled([42], { from: { id: 42, first_name: 'A' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.senderAllowListed).toBe(true);
  });

  test('a sender-less update does not take the rest of its batch down with it', async () => {
    const originalFetch = globalThis.fetch;
    let served = false;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/getMe')) return Response.json({ ok: true, result: { username: 'bot' } });
      if (url.endsWith('/getUpdates')) {
        await Bun.sleep(5);
        if (served) return Response.json({ ok: true, result: [] });
        served = true;
        return Response.json({ ok: true, result: [
          { update_id: 1, message: { message_id: 1, chat: { id: -100123, type: 'supergroup' }, date: 0, text: 'from nobody' } },
          { update_id: 2, message: { message_id: 2, from: { id: 42, first_name: 'A' }, chat: { id: 42, type: 'private' }, date: 0, text: 'hello' } },
        ] });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;
    const adapter = new TelegramAdapter('test-token', { allowedUsers: [42] });
    const seen: string[] = [];
    adapter.onMessage(async (m) => { seen.push(m.text); return ''; });
    try {
      await adapter.connect();
      for (let i = 0; i < 100 && seen.length === 0; i++) await Bun.sleep(10);
      expect(seen).toEqual(['hello']);
    } finally {
      await adapter.disconnect();
      globalThis.fetch = originalFetch;
    }
  });
});
