import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runWithOrigin } from './origin.ts';
import { LLMProviderError } from './provider.ts';
import type { LLMMessage, LLMProvider, LLMStreamEvent } from './provider.ts';
import {
  SCRIPTED_MODEL, SCRIPTED_NO_MATCH, SCRIPTED_PAST_END, SCRIPTED_PROVIDER_NAME, bindScriptedModel,
  initScriptedModelGate, scriptedCalls, scriptedModelBound, scriptedModelOpen, scriptedProvider, setScriptedTurns,
} from './scripted.ts';
import type { TierMap } from './tiers.ts';

const TOOLS = [{ name: 'get_system_info', description: 'x', parameters: {} }];
const user = (content: string): LLMMessage => ({ role: 'user', content });

function host(names: string[] = []) {
  const state = { names: [...names], tiers: null as TierMap | null };
  return {
    state,
    getProviderNames: () => state.names,
    registerProvider: (provider: LLMProvider) => { state.names.push(provider.name); },
    setTierMap: (tiers: TierMap) => { state.tiers = tiers; },
  };
}

beforeEach(() => { initScriptedModelGate({ hosted: false, localIntegration: true, devGate: true }); });
afterEach(() => { initScriptedModelGate({ hosted: false, localIntegration: false, devGate: false }); });

describe('the stand-in model gate', () => {
  test('opens only on an isolated development brain with the dev gate, never hosted', () => {
    expect(initScriptedModelGate({ hosted: false, localIntegration: true, devGate: true })).toBe(true);
    expect(initScriptedModelGate({ hosted: true, localIntegration: true, devGate: true })).toBe(false);
    expect(initScriptedModelGate({ hosted: false, localIntegration: false, devGate: true })).toBe(false);
    expect(initScriptedModelGate({ hosted: false, localIntegration: true, devGate: false })).toBe(false);
    expect(scriptedModelOpen()).toBe(false);
  });

  test('is bound only with a script loaded and no real provider', () => {
    expect(bindScriptedModel(host())).toBe('no-script');
    setScriptedTurns([{ match: 'hello', steps: [{ text: 'Hi.' }] }]);
    expect(bindScriptedModel(host(['anthropic']))).toBe('real-model');
    const empty = host();
    expect(bindScriptedModel(empty)).toBe('bound');
    expect(empty.state.names).toEqual([SCRIPTED_PROVIDER_NAME]);
    // No conversation tier: the single loop.
    expect(Object.keys(empty.state.tiers ?? {}).sort()).toEqual(['high', 'low', 'medium']);
    expect(scriptedModelBound(empty)).toBe(true);
    expect(bindScriptedModel(empty)).toBe('already');
    initScriptedModelGate({ hosted: false, localIntegration: false, devGate: true });
    setScriptedTurns([{ match: 'hello', steps: [{ text: 'Hi.' }] }]);
    expect(bindScriptedModel(host())).toBe('shut');
  });

  test('a start begins with no script', () => {
    setScriptedTurns([{ match: 'hello', steps: [{ text: 'Hi.' }] }]);
    initScriptedModelGate({ hosted: false, localIntegration: true, devGate: true });
    expect(bindScriptedModel(host())).toBe('no-script');
  });
});

describe('what the stand-in answers', () => {
  const script = (): void => setScriptedTurns([
    { match: 'System', steps: [
      { text: 'One moment.', tool_calls: [{ name: 'get_system_info' }] },
      { text: 'It says: {{last_tool_result}}' },
    ] },
    { match: 'remember', plain: true, steps: [{ text: '{"subject":"Sam"}' }] },
    { match: 'broken', steps: [{ error: { code: 'bad_request', message: 'scripted failure' } }] },
  ]);

  test('the step comes from the conversation, so the same request gets the same answer', async () => {
    script();
    const first = [user('what system is this?')];
    const one = await runWithOrigin('user', () => scriptedProvider.chat(first, { tools: TOOLS }));
    const again = await runWithOrigin('user', () => scriptedProvider.chat(first, { tools: TOOLS }));
    expect(one.finish_reason).toBe('tool_use');
    expect(one.tool_calls.map((call) => call.name)).toEqual(['get_system_info']);
    expect(again.content).toBe(one.content);
    expect(again.tool_calls[0]!.id).not.toBe(one.tool_calls[0]!.id);
    const second: LLMMessage[] = [...first,
      { role: 'assistant', content: one.content, tool_calls: one.tool_calls },
      { role: 'tool', content: 'Linux', tool_call_id: one.tool_calls[0]!.id }];
    const two = await runWithOrigin('user', () => scriptedProvider.chat(second, { tools: TOOLS }));
    expect(two).toMatchObject({ content: 'It says: Linux', finish_reason: 'stop', model: SCRIPTED_MODEL });
    const third: LLMMessage[] = [...second, { role: 'assistant', content: two.content }];
    const three = await runWithOrigin('user', () => scriptedProvider.chat(third, { tools: TOOLS }));
    expect(three.content).toBe(SCRIPTED_PAST_END);
  });

  test('a stream carries its tool calls as events and ends with done', async () => {
    script();
    const events: LLMStreamEvent[] = [];
    await runWithOrigin('user', async () => {
      for await (const event of scriptedProvider.stream([user('system?')], { tools: TOOLS })) events.push(event);
    });
    expect(events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text).join('')).toBe('One moment.');
    expect(events.some((event) => event.type === 'tool_call')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  test('only the person\'s own turns are scripted', async () => {
    script();
    // A background loop: refused, with an error that is not retried.
    await expect(runWithOrigin('background', () => scriptedProvider.chat([user('system?')], { tools: TOOLS })))
      .rejects.toMatchObject({ code: 'bad_request' });
    // A plain call (the memory extractor reads the same words): empty.
    expect((await runWithOrigin('background', () => scriptedProvider.chat([user('remember the system')]))).content).toBe('');
    expect((await runWithOrigin('user', () => scriptedProvider.chat([user('what system is this?')]))).content).toBe('');
    // A plain call inside the person's turn, for a turn that allows it.
    expect((await runWithOrigin('user', () => scriptedProvider.chat([user('Remember that Sam calls.')]))).content).toBe('{"subject":"Sam"}');
    // No origin at all is not the person.
    expect((await scriptedProvider.chat([user('Remember that Sam calls.')])).content).toBe('');
  });

  test('a turn nothing matches says so, where a person can see it', async () => {
    script();
    const none = await runWithOrigin('user', () => scriptedProvider.chat([user('anything else')], { tools: TOOLS }));
    expect(none.content).toBe(SCRIPTED_NO_MATCH);
    expect(scriptedCalls().at(-1)).toMatchObject({ origin: 'user', tools: 1, served: 'default: no match' });
  });

  test('a scripted failure is a provider error with its code', async () => {
    script();
    const failed = runWithOrigin('user', () => scriptedProvider.chat([user('broken')], { tools: TOOLS }));
    await expect(failed).rejects.toBeInstanceOf(LLMProviderError);
  });

  test('a scripted wait ends when the turn is cancelled', async () => {
    setScriptedTurns([{ match: 'slow', steps: [{ delay_ms: 30_000, text: 'Done.' }] }]);
    const controller = new AbortController();
    const pending = runWithOrigin('user', () => scriptedProvider.chat([user('slow')], { tools: TOOLS, signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});
