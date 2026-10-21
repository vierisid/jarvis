/**
 * #927. Two halves of one Pebble problem on the conversation tier:
 *
 *  - the router never saw "a spoken request is the authorization": the Pebble
 *    handed that directive to the task tier only, so the tier that decides
 *    whether anything runs could answer "shall I go ahead?" and stop;
 *  - no Pebble turn was ever stored, so every Pebble turn reached the router
 *    with no history and "do that" had nothing to resolve against.
 *
 * These drive a real AgentService into a real ConvOrchestrator with a
 * recording provider and read what the router was actually sent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { getMessages, getRecentConversation } from '../vault/conversations.ts';
import { LLMManager } from '../llm/manager.ts';
import type { LLMMessage, LLMOptions, LLMProvider, LLMResponse, LLMStreamEvent } from '../llm/provider.ts';
import { ConvOrchestrator, PEBBLE_VOICE_ROUTING_NOTE, SITE_CHAT_ROUTING_NOTE } from '../agents/conv/conv-orchestrator.ts';
import { TaskDispatcher } from '../agents/conv/task-dispatcher.ts';
import { TaskRegistry } from '../agents/conv/task-registry.ts';
import { AgentService } from './agent-service.ts';
import { PEBBLE_CHANNEL, PEBBLE_DIALOGUE_WINDOW_MS, recordPebbleExchange } from './pebble-dialogue.ts';

class RecordingProvider implements LLMProvider {
  name = 'rec';
  seen: LLMMessage[][] = [];
  async chat(m: LLMMessage[], _o?: LLMOptions): Promise<LLMResponse> {
    this.seen.push(m.map((x) => ({ ...x })));
    return { content: 'reply', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'rec', finish_reason: 'stop' };
  }
  async *stream(m: LLMMessage[]): AsyncIterable<LLMStreamEvent> {
    const response = await this.chat(m);
    yield { type: 'text', text: response.content };
    yield { type: 'done', response };
  }
  async listModels(): Promise<string[]> { return ['rec']; }
}

function convAgent() {
  const provider = new RecordingProvider();
  const llm = new LLMManager();
  llm.registerProvider(provider);
  llm.setTierMap({ medium: { provider: provider.name }, conversation: { provider: provider.name } });
  const registry = new TaskRegistry();
  const dispatcher = new TaskDispatcher(llm, registry, async () => { throw new Error('no task runs here'); });
  const conv = new ConvOrchestrator(llm, registry, dispatcher, 'persona');
  const agent = new AgentService({} as never);
  Object.assign(agent as unknown as Record<string, unknown>, {
    config: {},
    convOrchestrator: conv,
    llmManager: llm,
    extractKnowledge: async () => {},
    learnFromInteraction: async () => {},
  });
  return { agent, provider };
}

async function turn(agent: AgentService, text: string, channel: string, siteContext?: string) {
  const { stream } = agent.streamMessage(text, channel, siteContext);
  for await (const _ of stream) { /* drain */ }
}

/** The one router call a turn makes (the provider answers with plain text). */
function routerCall(provider: RecordingProvider, i = 0): LLMMessage[] {
  const call = provider.seen[i];
  expect(call).toBeDefined();
  return call!;
}

const systemText = (call: LLMMessage[]) =>
  call.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');

const PANEL_MARKER = 'PANEL-CONTEXT-MARKER: window title from another app';

describe('#927: the router hears "execute, don\'t ask" on a Pebble turn', () => {
  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDb());

  test('a Pebble turn gives the router the fixed routing note', async () => {
    const { agent, provider } = convAgent();
    await turn(agent, 'open chrome', PEBBLE_CHANNEL, `# Acting on the user's machine\n${PANEL_MARKER}`);
    expect(systemText(routerCall(provider))).toContain(PEBBLE_VOICE_ROUTING_NOTE);
  });

  test('the panel context still reaches the router as nothing at all', async () => {
    const { agent, provider } = convAgent();
    await turn(agent, 'open chrome', PEBBLE_CHANNEL, `# Acting on the user's machine\n${PANEL_MARKER}`);
    const call = routerCall(provider);
    for (const m of call) expect(String(m.content)).not.toContain('PANEL-CONTEXT-MARKER');
  });

  test('a dashboard turn is not told it was spoken to the Pebble', async () => {
    const { agent, provider } = convAgent();
    await turn(agent, 'open chrome', 'websocket');
    expect(systemText(routerCall(provider))).not.toContain(PEBBLE_VOICE_ROUTING_NOTE);
  });

  test('the note is not the site note, and a Pebble turn is not told it is a project chat', async () => {
    const { agent, provider } = convAgent();
    await turn(agent, 'open chrome', PEBBLE_CHANNEL, PANEL_MARKER);
    expect(systemText(routerCall(provider))).not.toContain(SITE_CHAT_ROUTING_NOTE);
  });

  test('the note sits outside every cached block, and the cached prefix is the same on both channels', async () => {
    const pebble = convAgent();
    await turn(pebble.agent, 'open chrome', PEBBLE_CHANNEL, PANEL_MARKER);
    const dash = convAgent();
    await turn(dash.agent, 'open chrome', 'websocket');

    const cached = (call: LLMMessage[]) => call.filter((m) => m.cache === true).map((m) => String(m.content));
    const pebbleCached = cached(routerCall(pebble.provider));
    // Non-vacuous: there is a cached prefix to compare.
    expect(pebbleCached.length).toBeGreaterThan(0);
    for (const c of pebbleCached) expect(c).not.toContain(PEBBLE_VOICE_ROUTING_NOTE);
    expect(pebbleCached).toEqual(cached(routerCall(dash.provider)));

    const uncached = routerCall(pebble.provider)
      .filter((m) => m.role === 'system' && m.cache !== true)
      .map((m) => String(m.content));
    expect(uncached.some((c) => c.includes(PEBBLE_VOICE_ROUTING_NOTE))).toBe(true);
  });

  test('the note keeps the task tier\'s question: a paused task is relayed, never answered by the router', () => {
    // The task tier's "ask once" for an irreversible action reaches the user
    // only as a paused task's needs_input, which the router must speak. A
    // bare "do not ask for confirmation" would read as leave to skip it.
    expect(PEBBLE_VOICE_ROUTING_NOTE).toContain(
      'If a delegated task comes back needing input or confirmation, ask the user its question as written and wait for their reply; never answer it yourself.',
    );
    expect(PEBBLE_VOICE_ROUTING_NOTE).not.toMatch(/Do not ask for (permission|confirmation)/i);
  });

  test('the note is fixed text: no placeholders, nothing per turn', () => {
    expect(PEBBLE_VOICE_ROUTING_NOTE).not.toMatch(/\$\{|\{\{|%s/);
  });
});

describe('#927: Pebble turns are kept as a conversation', () => {
  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDb());

  test('the next Pebble turn reaches the router with the previous exchange', async () => {
    const { agent, provider } = convAgent();
    expect(recordPebbleExchange('open the browser', 'Opened.')).toBe(true);

    await turn(agent, 'and close it', PEBBLE_CHANNEL);

    const sent = routerCall(provider).filter((m) => m.role !== 'system').map((m) => `${m.role}:${String(m.content)}`);
    expect(sent).toEqual(['user:open the browser', 'assistant:Opened.', 'user:and close it']);
  });

  test('exchanges are stored in order on the pebble channel, as user then assistant pairs', () => {
    recordPebbleExchange('first', 'one');
    recordPebbleExchange('second', 'two');
    const recent = getRecentConversation(PEBBLE_CHANNEL);
    expect(recent).not.toBeNull();
    expect(recent!.conversation.channel).toBe('pebble');
    expect(getMessages(recent!.conversation.id).map((m) => `${m.role}:${m.content}`))
      .toEqual(['user:first', 'assistant:one', 'user:second', 'assistant:two']);
  });

  test('a turn with no reply stores nothing, so no unanswered request is left behind', () => {
    expect(recordPebbleExchange('open the browser', '')).toBe(false);
    expect(recordPebbleExchange('open the browser', '   ')).toBe(false);
    expect(recordPebbleExchange('', 'Opened.')).toBe(false);
    expect(getRecentConversation(PEBBLE_CHANNEL)).toBeNull();
  });

  test('a storage failure is reported as false, not thrown into the spoken turn', () => {
    closeDb();
    try {
      expect(recordPebbleExchange('open the browser', 'Opened.')).toBe(false);
    } finally {
      initDatabase(':memory:');
    }
  });

  test('a stale Pebble exchange is not the antecedent of a turn hours later', async () => {
    recordPebbleExchange('open the browser', 'Opened.');
    const id = getRecentConversation(PEBBLE_CHANNEL)!.conversation.id;
    const age = (ms: number) => getDb().run('UPDATE conversations SET last_message_at = ? WHERE id = ?', [Date.now() - ms, id]);
    const sent = (provider: RecordingProvider) =>
      routerCall(provider).filter((m) => m.role !== 'system').map((m) => `${m.role}:${String(m.content)}`);

    // Inside the window: continued (so the cutoff below is not vacuous).
    age(PEBBLE_DIALOGUE_WINDOW_MS - 60_000);
    const fresh = convAgent();
    await turn(fresh.agent, 'do that again', PEBBLE_CHANNEL);
    expect(sent(fresh.provider)).toEqual(['user:open the browser', 'assistant:Opened.', 'user:do that again']);

    // Past it: a new start, as getOrCreateConversation would also decide.
    age(PEBBLE_DIALOGUE_WINDOW_MS + 60_000);
    const stale = convAgent();
    await turn(stale.agent, 'do that again', PEBBLE_CHANNEL);
    expect(sent(stale.provider)).toEqual(['user:do that again']);
  });

  test('the window is the one getOrCreateConversation uses to start a new conversation', () => {
    const src = readFileSync(new URL('../vault/conversations.ts', import.meta.url), 'utf8');
    expect(src).toContain('const cutoff = now - 4 * 60 * 60 * 1000;');
    expect(PEBBLE_DIALOGUE_WINDOW_MS).toBe(4 * 60 * 60 * 1000);
  });

  test('Pebble history stays out of the dashboard chat', async () => {
    const { agent, provider } = convAgent();
    recordPebbleExchange('open the browser', 'Opened.');
    await turn(agent, 'hello', 'websocket');
    const sent = routerCall(provider).filter((m) => m.role !== 'system').map((m) => `${m.role}:${String(m.content)}`);
    expect(sent).toEqual(['user:hello']);
  });
});

describe('#927: the Pebble response cycle stores what it finished', () => {
  // index.ts's response cycle is one closure inside the daemon's startup, so
  // its wiring is pinned from source, as pebble-confirmation.test.ts does.
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const start = src.indexOf('const runResponseCycleTurn = async (');
  const end = src.indexOf('audioSessions.onComplete(', start);
  const cycle = src.slice(start, end);

  test('the cycle is where the pin looks', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(cycle).toContain('agentService.streamMessage(\n                userText,\n                PEBBLE_CHANNEL,');
  });

  test('a finished, unfailed, undismissed turn is stored before the turn hands off', () => {
    const call = cycle.indexOf('recordPebbleExchange(opts?.historyText ?? userText, fullText)');
    expect(call).toBeGreaterThan(-1);
    const line = cycle.slice(cycle.lastIndexOf('\n', call), cycle.indexOf('\n', call));
    expect(line).toContain('!streamFailed');
    expect(line).toContain('!ctrl.cancelled');
    // After the stream loop has drained, not inside it.
    expect(call).toBeGreaterThan(cycle.indexOf('for await (const event of stream)'));
    expect(call).toBeLessThan(cycle.indexOf('void onComplete(fullText)'));
  });

  test('a region-capture turn is stored as what the user said, not the image framing', () => {
    expect(cycle).toContain('recordPebbleExchange(opts?.historyText ?? userText, fullText)');
    const regionCall = src.indexOf('await runResponseCycle(sidecarId, promptText, ctrl, {');
    expect(regionCall).toBeGreaterThan(-1);
    const args = src.slice(regionCall, src.indexOf('});', regionCall));
    expect(args).toContain('historyText: userText');
    // promptText is the framed one; userText is the spoken text it wraps.
    expect(src).toContain('const promptText = `${userText}\\n\\n(I\'ve attached a screenshot');
  });

  test('a stream error marks the turn failed, so the fallback line is never stored', () => {
    const errBranch = cycle.indexOf("event.type === 'error'");
    expect(errBranch).toBeGreaterThan(-1);
    const branch = cycle.slice(errBranch, cycle.indexOf('break;', errBranch));
    expect(branch).toContain('streamFailed = true');
  });
});
