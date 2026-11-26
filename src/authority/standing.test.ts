/**
 * The standing of a turn the owner started on the notch (./standing.ts): an
 * object made in one place and tied to one turn, not a way of naming ids.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ownerAskedOnNotch } from './app-open.ts';
import { currentStanding, grantStanding, isUnusedStanding, mintStanding, ownersOwnWords, type TurnStanding } from './standing.ts';
import { outsideBriefTurn, withBriefTurn, type BriefExecutionContext } from '../brief/chat-context.ts';
import { BriefChatTransport, type ScopedChatInput } from '../brief/chat-transport.ts';
import { NOTCH_SWITCH } from '../notch/switch.ts';
import { getOrCreateConversation } from '../vault/conversations.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';

let before: string | undefined;
beforeEach(() => { before = process.env[NOTCH_SWITCH]; process.env[NOTCH_SWITCH] = '1'; });
afterEach(() => { if (before === undefined) delete process.env[NOTCH_SWITCH]; else process.env[NOTCH_SWITCH] = before; });

const bare = (requestId = 'notch-typed-1', controller = new AbortController()): BriefExecutionContext =>
  ({ conversationId: 'c', turnId: 'notch-1', requestId, signal: controller.signal, progress: () => {} });

describe('a standing is made in one place and tied to one turn', () => {
  test('a turn that was given one has it; who wrote the words decides whether it is the owner\'s word', () => {
    for (const [origin, owners] of [['typed', true], ['spoken', true], ['shown', false]] as const) {
      const context = bare('req-1');
      expect(grantStanding(context, mintStanding(origin))).toBe(true);
      expect(withBriefTurn(context, () => currentStanding())).toEqual({ origin });
      expect(withBriefTurn(context, () => ownerAskedOnNotch())).toBe(owners);
      expect(ownersOwnWords({ origin })).toBe(owners);
    }
    expect(ownersOwnWords(null)).toBe(false);
  });

  test('the way a turn\'s ids are written gives it nothing', () => {
    for (const requestId of ['notch-typed-1', 'notch-spoken-1', 'notch-typed-0f8fad5b-d9cb-469f-a165-70867728950e']) {
      expect(withBriefTurn(bare(requestId), () => currentStanding())).toBeNull();
      expect(withBriefTurn(bare(requestId), () => ownerAskedOnNotch())).toBe(false);
    }
  });

  test('an object that only looks like a standing is not one, on the turn or handed to the door', () => {
    const lookalike = { origin: 'typed' } as TurnStanding;
    expect(isUnusedStanding(lookalike)).toBe(false);
    expect(isUnusedStanding(Object.freeze({ origin: 'typed' }))).toBe(false);
    for (const nothing of [null, undefined, 'typed', 1, true, {}]) expect(isUnusedStanding(nothing)).toBe(false);
    const context = bare();
    expect(grantStanding(context, lookalike)).toBe(false);
    expect(withBriefTurn(context, () => currentStanding())).toBeNull();
    // Written onto the context by hand, as a field: nobody reads it there.
    const dressed = { ...bare(), standing: mintStanding('typed'), origin: 'typed' } as BriefExecutionContext;
    expect(withBriefTurn(dressed, () => currentStanding())).toBeNull();
    expect(withBriefTurn(dressed, () => ownerAskedOnNotch())).toBe(false);
  });

  test('a copy of a turn\'s context is not that turn', () => {
    const context = bare('req-1');
    grantStanding(context, mintStanding('typed'));
    expect(withBriefTurn({ ...context }, () => currentStanding())).toBeNull();
  });

  test('it is used up by the one turn that takes it', () => {
    const standing = mintStanding('typed');
    expect(isUnusedStanding(standing)).toBe(true);
    const first = bare('req-1');
    const second = bare('req-2');
    expect(grantStanding(first, standing)).toBe(true);
    expect(isUnusedStanding(standing)).toBe(false);
    expect(grantStanding(second, standing)).toBe(false);
    expect(withBriefTurn(second, () => currentStanding())).toBeNull();
    // Nor is a turn's own standing changed for another: what the owner did not say stays unsaid.
    const shown = bare('req-3');
    expect(grantStanding(shown, mintStanding('shown'))).toBe(true);
    expect(grantStanding(shown, mintStanding('typed'))).toBe(false);
    expect(withBriefTurn(shown, () => ownerAskedOnNotch())).toBe(false);
  });

  test('an origin nobody knows cannot be made', () => {
    expect(() => mintStanding('offered' as never)).toThrow();
    expect(() => mintStanding(undefined as never)).toThrow();
  });

  test('it is frozen: a shown turn cannot be rewritten into a typed one', () => {
    const standing = mintStanding('shown');
    expect(() => { (standing as { origin: string }).origin = 'typed'; }).toThrow();
    expect(standing.origin).toBe('shown');
  });

  test('it ends with the turn, with Esc, with the switch, and outside the turn', () => {
    const controller = new AbortController();
    const context = bare('req-1', controller);
    grantStanding(context, mintStanding('spoken'));
    expect(withBriefTurn(context, () => ownerAskedOnNotch())).toBe(true);
    expect(currentStanding()).toBeNull();
    // Detached work (a background task) leaves the turn, and its standing with it.
    expect(withBriefTurn(context, () => outsideBriefTurn(() => currentStanding()))).toBeNull();
    delete process.env[NOTCH_SWITCH];
    expect(withBriefTurn(context, () => currentStanding())).toBeNull();
    process.env[NOTCH_SWITCH] = '1';
    expect(withBriefTurn(context, () => ownerAskedOnNotch())).toBe(true);
    process.env[NOTCH_SWITCH] = 'true';
    expect(withBriefTurn(context, () => currentStanding())).toBeNull();
    process.env[NOTCH_SWITCH] = '1';
    controller.abort();
    expect(withBriefTurn(context, () => currentStanding())).toBeNull();
    const ended = bare('req-2');
    grantStanding(ended, mintStanding('typed'));
    ended.over = true;
    expect(withBriefTurn(ended, () => currentStanding())).toBeNull();
  });
});

describe('through the turn store', () => {
  afterEach(() => closeDb());
  const done = { type: 'done' as const, response: { content: '', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'x', finish_reason: 'stop' as const } };
  type Seen = { requestId: string; standing: TurnStanding | null; owners: boolean };

  function setup(options: { concurrency?: number; during?: (input: ScopedChatInput) => Promise<void> } = {}) {
    initDatabase(':memory:', { quiet: true });
    const seen: Seen[] = [];
    const later: Array<() => Seen> = [];
    const sent: { type: string }[] = [];
    const transport = new BriefChatTransport({ db: getDb(), send: (_client, message) => { sent.push(message); }, concurrency: options.concurrency,
      runner: { ready: () => true, stream: (input) => ({ onComplete: async () => {}, stream: (async function* () {
        const look = (): Seen => ({ requestId: input.requestId, standing: currentStanding(), owners: ownerAskedOnNotch() });
        seen.push(look());
        // A helper agent, a retry, a tool call: all awaited inside the turn.
        await new Promise((resolve) => setTimeout(resolve, 1));
        await options.during?.(input);
        seen.push(await (async () => look())());
        // Work the turn does not wait for: it keeps the context it was started in.
        await new Promise<void>((resolve) => { later.push(look); resolve(); });
        yield done;
      })() }) } });
    const conversation = (name: string): string => getOrCreateConversation(name, { label: name }).id;
    return { transport, seen, later, sent, conversation };
  }

  test('a turn submitted from inside the brain under the notch\'s way of naming, with no standing, has none', async () => {
    const h = setup();
    h.transport.submit({ conversationId: h.conversation('notch'), turnId: 'notch-a', requestId: 'notch-typed-a', text: 'open steam' });
    await h.transport.idle();
    expect(h.seen).toEqual([{ requestId: 'notch-typed-a', standing: null, owners: false }, { requestId: 'notch-typed-a', standing: null, owners: false }]);
  });

  test('nor with something that only looks like one', async () => {
    const h = setup();
    h.transport.submit({ conversationId: h.conversation('notch'), turnId: 'notch-a', requestId: 'notch-spoken-a', text: 'open steam',
      standing: { origin: 'spoken' } });
    await h.transport.idle();
    expect(h.seen.map((one) => one.owners)).toEqual([false, false]);
    expect(h.seen.map((one) => one.standing)).toEqual([null, null]);
  });

  test('the notch\'s own standing reaches the turn and everything awaited inside it, and whatever the id says', async () => {
    const h = setup();
    h.transport.submit({ conversationId: h.conversation('notch'), turnId: 't1', requestId: 'r1', text: 'open steam', standing: mintStanding('typed') });
    await h.transport.idle();
    expect(h.seen).toEqual([{ requestId: 'r1', standing: { origin: 'typed' }, owners: true }, { requestId: 'r1', standing: { origin: 'typed' }, owners: true }]);
  });

  test('a turn whose words the notch wrote is known as that, and is not the owner\'s word', async () => {
    const h = setup();
    h.transport.submit({ conversationId: h.conversation('notch'), turnId: 'notch-a', requestId: 'notch-typed-a', text: 'What does this tell me?', standing: mintStanding('shown') });
    await h.transport.idle();
    expect(h.seen.map((one) => one.standing)).toEqual([{ origin: 'shown' }, { origin: 'shown' }]);
    expect(h.seen.map((one) => one.owners)).toEqual([false, false]);
  });

  test('what a turn left running has no standing once the turn is over', async () => {
    const h = setup();
    h.transport.submit({ conversationId: h.conversation('notch'), turnId: 't1', requestId: 'r1', text: 'open steam', standing: mintStanding('typed') });
    await h.transport.idle();
    expect(h.later).toHaveLength(1);
    expect(h.later[0]!()).toEqual({ requestId: 'r1', standing: null, owners: false });
  });

  test('a turn that was stopped has none from the moment it is stopped', async () => {
    let stopped: Seen | null = null;
    const h = setup({ during: async (input) => {
      h.transport.cancelTurn({ conversationId: input.conversationId, turnId: input.turnId, requestId: input.requestId });
      stopped = { requestId: input.requestId, standing: currentStanding(), owners: ownerAskedOnNotch() };
    } });
    h.transport.submit({ conversationId: h.conversation('notch'), turnId: 't1', requestId: 'r1', text: 'open steam', standing: mintStanding('typed') });
    await h.transport.idle();
    expect(h.seen[0]).toEqual({ requestId: 'r1', standing: { origin: 'typed' }, owners: true });
    expect(stopped!).toEqual({ requestId: 'r1', standing: null, owners: false });
  });

  test('submitting a turn again does not give it a standing it was not started with, nor take one away', async () => {
    const h = setup();
    const conversationId = h.conversation('notch');
    const plain = { conversationId, turnId: 'notch-a', requestId: 'notch-typed-a', text: 'open steam' };
    expect(h.transport.submit(plain).created).toBe(true);
    const late = mintStanding('typed');
    expect(h.transport.submit({ ...plain, standing: late }).created).toBe(false);
    await h.transport.idle();
    expect(h.seen.map((one) => one.owners)).toEqual([false, false]);
    // And after it ended: the same request is the same finished turn.
    expect(h.transport.submit({ ...plain, standing: mintStanding('typed') }).created).toBe(false);
    await h.transport.idle();
    expect(h.seen).toHaveLength(2);

    const other = h.conversation('other');
    const shown = { conversationId: other, turnId: 'notch-b', requestId: 'notch-typed-b', text: 'What does this tell me?' };
    expect(h.transport.submit({ ...shown, standing: mintStanding('shown') }).created).toBe(true);
    expect(h.transport.submit({ ...shown, standing: mintStanding('typed') }).created).toBe(false);
    expect(h.transport.submit(shown).created).toBe(false);
    await h.transport.idle();
    expect(h.seen.slice(2).map((one) => one.standing)).toEqual([{ origin: 'shown' }, { origin: 'shown' }]);
  });

  test('one standing is one turn: handed to a second turn it gives nothing', async () => {
    const h = setup();
    const standing = mintStanding('typed');
    h.transport.submit({ conversationId: h.conversation('notch'), turnId: 't1', requestId: 'r1', text: 'first', standing });
    await h.transport.idle();
    h.transport.submit({ conversationId: h.conversation('notch'), turnId: 't2', requestId: 'r2', text: 'second', standing });
    await h.transport.idle();
    expect(h.seen.map((one) => [one.requestId, one.owners])).toEqual([['r1', true], ['r1', true], ['r2', false], ['r2', false]]);
  });

  test('two turns running side by side each have their own, and a dashboard turn beside a notch turn has none', async () => {
    const h = setup({ concurrency: 3 });
    h.transport.submit({ conversationId: h.conversation('notch'), turnId: 't1', requestId: 'r-typed', text: 'open steam', standing: mintStanding('typed') });
    h.transport.submit({ conversationId: h.conversation('desk'), turnId: 't2', requestId: 'r-plain', text: 'hello' });
    h.transport.submit({ conversationId: h.conversation('look'), turnId: 't3', requestId: 'r-shown', text: 'What does this tell me?', standing: mintStanding('shown') });
    await h.transport.idle();
    const by = (requestId: string) => h.seen.filter((one) => one.requestId === requestId).map((one) => [one.standing?.origin ?? null, one.owners]);
    expect(by('r-typed')).toEqual([['typed', true], ['typed', true]]);
    expect(by('r-plain')).toEqual([[null, false], [null, false]]);
    expect(by('r-shown')).toEqual([['shown', false], ['shown', false]]);
  });

  test('a turn that is refused uses nothing up and starts nothing', async () => {
    const h = setup();
    const conversationId = h.conversation('notch');
    const standing = mintStanding('typed');
    expect(() => h.transport.submit({ conversationId, turnId: 't1', requestId: 'r1', text: '   ', standing })).toThrow();
    expect(isUnusedStanding(standing)).toBe(true);
    await h.transport.idle();
    expect(h.seen).toEqual([]);
  });

  test('a socket has no way to hand one over, and cannot take the notch\'s ids', async () => {
    const h = setup();
    const conversationId = h.conversation('notch');
    const { BriefCapabilities } = await import('../brief/capabilities.ts');
    const { registerChatTransport } = await import('../brief/registrations/chat-transport.ts');
    const { registerConversations } = await import('../brief/registrations/conversations.ts');
    const { BriefConversationProvider } = await import('../brief/conversations.ts');
    const conversations = new BriefConversationProvider();
    conversations.repository.setOpen(conversationId, true);
    const caps = new BriefCapabilities([...registerConversations(conversations), ...registerChatTransport(h.transport)], ['conversations', 'chatTransport']);
    const send = (payload: Record<string, unknown>) =>
      h.transport.handle({ type: 'brief_chat_send', payload: { conversationId, text: 'open steam', ...payload }, timestamp: Date.now() }, {} as never, caps);
    // A field named like it is refused with the whole message, whatever it holds.
    await send({ turnId: 't1', requestId: 'r1', standing: { origin: 'typed' } });
    await send({ turnId: 't2', requestId: 'r2', standing: 'typed' });
    await send({ turnId: 't3', requestId: 'r3', origin: 'typed' });
    await send({ turnId: 'notch-x', requestId: 'r4' });
    await send({ turnId: 't5', requestId: 'notch-typed-x' });
    await h.transport.idle();
    expect(h.seen).toEqual([]);
    expect(h.sent.filter((message) => message.type === 'brief_chat_error')).toHaveLength(5);
    // What a socket can send runs, with nothing.
    await send({ turnId: 't6', requestId: 'r6' });
    await h.transport.idle();
    expect(h.seen.map((one) => [one.requestId, one.standing, one.owners])).toEqual([['r6', null, false], ['r6', null, false]]);
  });
});
