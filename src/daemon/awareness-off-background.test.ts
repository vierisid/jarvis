/**
 * #1314 follow-up: screen text that awareness research and the EventReactor
 * hand the background agent stops reaching the model once screen awareness
 * is turned off, and never enters the primary history that later background
 * turns re-send.
 *
 * The background agent runs a real AgentOrchestrator on a real LLMManager
 * with a scripted provider, so what the model was sent is what is asserted.
 */
import { afterEach, expect, test } from 'bun:test';
import { LLMManager } from '../llm/manager.ts';
import { LLMProviderError, type LLMMessage, type LLMOptions, type LLMProvider, type LLMResponse, type LLMStreamEvent } from '../llm/provider.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { JarvisConfig } from '../config/types.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { setScreenCaptureEnabledSource } from '../actions/tools/desktop-guard.ts';
import { AwarenessHeldError } from '../awareness/history-guard.ts';
import { BackgroundAgentService, type BackgroundTurnOptions } from './background-agent-service.ts';
import { EventReactor } from './event-reactor.ts';
import { classifyEvent } from './event-classifier.ts';

let on = true;
setScreenCaptureEnabledSource(() => on);
afterEach(() => { on = true; });

const SCREEN = 'OCR-SECRET-7f3a';
const ROLE = { id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [], tools: [], authority_level: 10 } as unknown as RoleDefinition;
const answer = (content: string): LLMResponse => ({ content, tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'rec', finish_reason: 'stop' });

class ScriptedProvider implements LLMProvider {
  name = 'rec';
  seen: LLMMessage[][] = [];
  constructor(private script: (call: number, messages: LLMMessage[]) => Promise<LLMResponse> | LLMResponse = () => answer('done')) {}
  async chat(m: LLMMessage[], _o?: LLMOptions): Promise<LLMResponse> {
    this.seen.push([...m]);
    return this.script(this.seen.length, m);
  }
  async *stream(m: LLMMessage[]): AsyncIterable<LLMStreamEvent> {
    const response = await this.chat(m);
    yield { type: 'text', text: response.content };
    yield { type: 'done', response };
  }
  async listModels(): Promise<string[]> { return ['rec']; }
}

function background(provider: ScriptedProvider, onTool: () => void = () => {}) {
  const llm = new LLMManager();
  llm.registerProvider(provider);
  llm.setTierMap({ medium: { provider: provider.name } });
  const svc = new BackgroundAgentService({} as JarvisConfig, llm);
  const orch = svc.getOrchestrator();
  orch.setLLMManager(llm);
  const tools = new ToolRegistry();
  const ran: unknown[] = [];
  tools.register({ name: 'web_search', description: 'Search the web', category: 'research',
    parameters: { query: { type: 'string', description: 'query', required: true } },
    execute: async (params) => { ran.push(params); onTool(); return 'results'; } });
  orch.setToolRegistry(tools);
  orch.createPrimary(ROLE);
  return { svc, orch, ran };
}
const sentText = (messages: LLMMessage[]) => JSON.stringify(messages);

test('a screen-derived turn queued behind another starts only if awareness is still on', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = new ScriptedProvider(async (call) => { if (call === 1) await gate; return answer('done'); });
  const { svc } = background(provider);
  const first = svc.handleMessage('a commitment is due', 'system');
  const research = svc.handleMessage(`screen: ${SCREEN}`, 'awareness', { screenDerived: true });
  await Bun.sleep(0);
  on = false;
  release();
  expect(await first).toBe('done');
  await expect(research).rejects.toBeInstanceOf(AwarenessHeldError);
  expect(provider.seen).toHaveLength(1);
  expect(sentText(provider.seen[0]!)).not.toContain(SCREEN);
});

const searches = (...queries: string[]): LLMResponse => ({ ...answer(''), finish_reason: 'tool_use',
  tool_calls: queries.map((query, i) => ({ id: `t${i}`, name: 'web_search', arguments: { query } })) });

test('awareness turned off while the model answers: its tool calls are dropped and nothing more is sent', async () => {
  const provider = new ScriptedProvider((call) => {
    if (call > 1) return answer('fix');
    on = false;
    return searches(SCREEN);
  });
  const { svc, ran } = background(provider);
  await expect(svc.handleMessage(`screen: ${SCREEN}`, 'awareness', { screenDerived: true })).rejects.toBeInstanceOf(AwarenessHeldError);
  expect(ran).toEqual([]);
  expect(provider.seen).toHaveLength(1);
});

test('awareness turned off while one tool runs: the next tool call does not run and nothing more is sent', async () => {
  const provider = new ScriptedProvider((call) => call > 1 ? answer('fix') : searches(`${SCREEN} one`, `${SCREEN} two`));
  const { svc, ran } = background(provider, () => { on = false; });
  await expect(svc.handleMessage(`screen: ${SCREEN}`, 'awareness', { screenDerived: true })).rejects.toBeInstanceOf(AwarenessHeldError);
  expect(ran).toEqual([{ query: `${SCREEN} one` }]);
  expect(provider.seen).toHaveLength(1);
});

test('awareness turned off during a provider call stops its retry: the prompt is not sent again', async () => {
  const provider = new ScriptedProvider((call) => {
    if (call > 1) return answer('fix');
    on = false;
    throw new LLMProviderError('connection reset', 'network');
  });
  const { svc } = background(provider);
  await expect(svc.handleMessage(`screen: ${SCREEN}`, 'awareness', { screenDerived: true })).rejects.toBeInstanceOf(AwarenessHeldError);
  expect(provider.seen).toHaveLength(1);
});

test('a screen-derived turn runs on its own thread: its screen text is never re-sent by a later background turn', async () => {
  const provider = new ScriptedProvider((call) => answer(call === 1 ? `the fix for ${SCREEN}` : 'done'));
  const { svc, orch } = background(provider);
  expect(await svc.handleMessage(`screen: ${SCREEN}`, 'awareness', { screenDerived: true })).toBe(`the fix for ${SCREEN}`);
  expect(sentText(provider.seen[0]!)).toContain(SCREEN);
  expect(await svc.handleMessage('a commitment is due', 'system')).toBe('done');
  expect(sentText(provider.seen[1]!)).not.toContain(SCREEN);
  expect(JSON.stringify(orch.getPrimary()!.getMessages())).not.toContain(SCREEN);
});

test('a turn that is not screen-derived keeps the primary history and is not held by the switch', async () => {
  const provider = new ScriptedProvider(() => answer('done'));
  const { svc, orch } = background(provider);
  on = false;
  expect(await svc.handleMessage('a commitment is due', 'system')).toBe('done');
  expect(JSON.stringify(orch.getPrimary()!.getMessages())).toContain('a commitment is due');
});

// --- EventReactor ---

type Call = { text: string; options?: BackgroundTurnOptions };
function reactor(handle: (call: Call) => Promise<string> = async () => 'reaction text') {
  const calls: Call[] = [];
  const shown: string[] = [];
  const r = new EventReactor();
  r.setAgentService({ handleMessage: (text: string, _channel?: string, options?: BackgroundTurnOptions) => {
    const call = { text, ...(options ? { options } : {}) };
    calls.push(call);
    return handle(call);
  } });
  r.setReactionCallback((text) => { shown.push(text); });
  return { r, calls, shown };
}
const screenError = (errorText = SCREEN) => classifyEvent({ type: 'error_detected', data: { errorText, appName: 'Editor' }, timestamp: 1 });

test('the reactor does not react to a screen event while awareness is off', async () => {
  const { r, calls } = reactor();
  on = false;
  expect(await r.react(screenError())).toBe(false);
  expect(calls).toEqual([]);
});

test('a screen reaction runs screen-derived; another event keeps its ordinary turn and still runs while awareness is off', async () => {
  const { r, calls, shown } = reactor();
  await r.react(screenError());
  expect(calls[0]!.options).toEqual({ screenDerived: true });
  on = false;
  const overdue = classifyEvent({ type: 'commitment_overdue', data: { id: 'c1', what: 'pay rent' }, timestamp: 2 });
  expect(overdue.priority).toBe('critical');
  expect(await r.react(overdue)).toBe(true);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.options).toBeUndefined();
  expect(shown).toEqual(['reaction text', 'reaction text']);
});

test('a queued screen event is dropped once awareness is off', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { r, calls } = reactor(async (call) => { if (calls.length === 1) await gate; return `reacted to ${call.text.length}`; });
  const running = r.react(screenError('first screen error'));
  expect(await r.react(screenError('second screen error'))).toBe(true);
  on = false;
  release();
  await running;
  expect(calls).toHaveLength(1);
});

test('a screen reaction that finishes after awareness is turned off is not shown', async () => {
  const { r, shown } = reactor(async () => { on = false; return `here is what ${SCREEN} means`; });
  await r.react(screenError());
  expect(shown).toEqual([]);
});
