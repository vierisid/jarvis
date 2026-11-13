/**
 * A stand-in for the model, for development only.
 *
 * It answers from a script written in advance: for a sentence that contains
 * these words, say this, or call this tool and then say that. Nothing thinks.
 * It exists so the paths where Jarvis has to answer can be run end to end on
 * a brain that has no model key.
 *
 * It is never part of the configuration. Nothing here is read from or written
 * to the settings, so no dashboard lists it and no save can keep it. It is put
 * on the live model manager by hand (bindScriptedModel), and only when:
 *
 *   - the gate was opened at startup (initScriptedModelGate), which the daemon
 *     does only on an isolated development brain with the notch's dev secret,
 *   - a script has been loaded, and
 *   - no real provider is bound. A real provider always wins: the two are
 *     never mixed, so nobody has to wonder which one answered.
 *
 * What it answers, and to whom. A provider is not told who is calling it, only
 * the messages and the options. So the script is consulted for the person's
 * own turns alone (origin `user`), and only when tools are offered or the
 * scripted turn says it also answers plain calls. Everything else gets a
 * default that every caller treats as "no answer": empty text for a plain
 * call, an error that is not retried for a background loop. That keeps the
 * memory extractor, the summarisers and every background agent from taking a
 * scripted sentence for real work.
 *
 * The step of a turn is read from the conversation it is given (how many times
 * the model has already answered since the person last spoke), never from a
 * counter. The same request always gets the same answer, so a retry cannot
 * skip a step and a tool loop cannot repeat one for ever.
 */
import { currentOrigin } from './origin.ts';
import { LLMProviderError } from './provider.ts';
import type { LLMErrorCode, LLMMessage, LLMOptions, LLMProvider, LLMResponse, LLMStreamEvent, LLMToolCall } from './provider.ts';
import type { TierMap } from './tiers.ts';

export const SCRIPTED_PROVIDER_NAME = 'dev_scripted';
export const SCRIPTED_MODEL = 'scripted';

/** What is said when a person's turn matches nothing in the script. */
export const SCRIPTED_NO_MATCH = '[stand-in model: nothing is scripted for this]';
/** What ends a turn that has run past its last scripted step. */
export const SCRIPTED_PAST_END = '[stand-in model: the script for this has ended]';

/** The longest a scripted step may wait: under the manager's own limit for one request. */
export const SCRIPTED_MAX_DELAY_MS = 60_000;

export interface ScriptedStep {
  text?: string;
  /** Tools the stand-in "decides" to call at this step. They are real tools and really run. */
  tool_calls?: { name: string; arguments?: Record<string, unknown> }[];
  /** Wait this long first. */
  delay_ms?: number;
  /** Fail in place of answering. */
  error?: { code: LLMErrorCode; message: string };
}

export interface ScriptedTurn {
  /** The turn is this one when the person's last message contains these words. Case is ignored. */
  match: string;
  /** Also answers a call that offers no tools (a small helper call made inside a person's turn). */
  plain?: boolean;
  steps: ScriptedStep[];
}

/** One call the stand-in received, for a test to read back. */
export interface ScriptedCall {
  at: number;
  origin: string;
  tools: number;
  /** The start of the person's last message. */
  said: string;
  /** Which scripted turn and step answered, or which default. */
  served: string;
}

let open = false;
let turns: ScriptedTurn[] = [];
const calls: ScriptedCall[] = [];
let callIds = 0;

/**
 * Resolves the gate once, at startup. Open only on an isolated development
 * brain (the caller says so) that is not hosted and has the notch's dev gate
 * open. Every start begins with no script.
 */
export function initScriptedModelGate(opts: { hosted: boolean; localIntegration: boolean; devGate: boolean }): boolean {
  open = !opts.hosted && opts.localIntegration && opts.devGate;
  turns = [];
  calls.length = 0;
  return open;
}

export function scriptedModelOpen(): boolean {
  return open;
}

/** Replaces the script. */
export function setScriptedTurns(next: ScriptedTurn[]): void {
  turns = structuredClone(next);
}

export function scriptedTurns(): ScriptedTurn[] {
  return structuredClone(turns);
}

/** The calls received so far, oldest first. At most the last 200 are kept. */
export function scriptedCalls(): ScriptedCall[] {
  return calls.map((call) => ({ ...call }));
}

export function clearScriptedCalls(): void {
  calls.length = 0;
}

const textOf = (message: LLMMessage): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content.map((block) => (block.type === 'text' ? block.text : '')).join(' ');

/** The person's last message, and how many times the model has answered since. */
function place(messages: LLMMessage[]): { said: string; step: number; lastToolResult: string } {
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') { at = i; break; }
  }
  const after = at < 0 ? [] : messages.slice(at + 1);
  const lastTool = [...after].reverse().find((message) => message.role === 'tool');
  return {
    said: at < 0 ? '' : textOf(messages[at]!),
    step: after.filter((message) => message.role === 'assistant').length,
    lastToolResult: lastTool ? textOf(lastTool) : '',
  };
}

const reply = (content: string, toolCalls: LLMToolCall[] = []): LLMResponse => ({
  content,
  tool_calls: toolCalls,
  usage: { input_tokens: 0, output_tokens: 0 },
  model: SCRIPTED_MODEL,
  finish_reason: toolCalls.length > 0 ? 'tool_use' : 'stop',
});

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function note(call: ScriptedCall): void {
  calls.push(call);
  if (calls.length > 200) calls.shift();
}

async function answer(messages: LLMMessage[], options: LLMOptions | undefined): Promise<LLMResponse> {
  const origin = currentOrigin();
  const tools = options?.tools?.length ?? 0;
  const { said, step, lastToolResult } = place(messages);
  const seen = { at: Date.now(), origin: origin ?? 'none', tools, said: said.slice(0, 80) };
  const lower = said.toLowerCase();
  const index = origin === 'user'
    ? turns.findIndex((turn) => (tools > 0 || turn.plain === true) && lower.includes(turn.match.toLowerCase()))
    : -1;
  if (index < 0) {
    if (tools === 0) { note({ ...seen, served: 'default: empty' }); return reply(''); }
    if (origin === 'user') { note({ ...seen, served: 'default: no match' }); return reply(SCRIPTED_NO_MATCH); }
    note({ ...seen, served: 'default: refused' });
    // Not retried, not failed over, and no backoff is written for it.
    throw new LLMProviderError('The stand-in model answers nothing for a background turn', 'bad_request');
  }
  const turn = turns[index]!;
  const scripted = turn.steps[step];
  if (!scripted) { note({ ...seen, served: `turn ${index}: past its end` }); return reply(SCRIPTED_PAST_END); }
  note({ ...seen, served: `turn ${index}, step ${step}` });
  if (scripted.delay_ms) await wait(Math.min(Math.max(0, scripted.delay_ms), SCRIPTED_MAX_DELAY_MS), options?.signal);
  if (scripted.error) throw new LLMProviderError(scripted.error.message, scripted.error.code);
  const toolCalls = (scripted.tool_calls ?? []).map((call): LLMToolCall => ({
    id: `scripted-${++callIds}`, name: call.name, arguments: structuredClone(call.arguments ?? {}),
  }));
  return reply((scripted.text ?? '').replaceAll('{{last_tool_result}}', lastToolResult.slice(0, 2000)), toolCalls);
}

export const scriptedProvider: LLMProvider = {
  name: SCRIPTED_PROVIDER_NAME,
  chat: (messages, options) => answer(messages, options),
  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<LLMStreamEvent> {
    const response = await answer(messages, options);
    // In a few pieces, so what draws an answer as it grows is exercised too.
    const words = response.content.split(/(?<=\s)/);
    const size = Math.max(1, Math.ceil(words.length / 3));
    for (let i = 0; i < words.length; i += size) {
      const text = words.slice(i, i + size).join('');
      if (text) yield { type: 'text', text };
    }
    for (const call of response.tool_calls) yield { type: 'tool_call', tool_call: call };
    yield { type: 'done', response };
  },
  listModels: async () => [SCRIPTED_MODEL],
};

/** The part of the model manager the stand-in is put on. */
export interface ScriptedModelHost {
  getProviderNames(): string[];
  registerProvider(provider: LLMProvider): void;
  setTierMap(tiers: TierMap): void;
}

/**
 * Puts the stand-in on the model manager, if it may be there: the gate is
 * open, a script is loaded, and no real provider is bound. Comes back with
 * what happened. A later reload of the model settings takes it off again,
 * because it is not in them.
 */
export function bindScriptedModel(host: ScriptedModelHost): 'bound' | 'already' | 'shut' | 'no-script' | 'real-model' {
  if (!open) return 'shut';
  if (turns.length === 0) return 'no-script';
  const names = host.getProviderNames();
  if (names.includes(SCRIPTED_PROVIDER_NAME) && names.length === 1) return 'already';
  if (names.some((name) => name !== SCRIPTED_PROVIDER_NAME)) return 'real-model';
  host.registerProvider(scriptedProvider);
  const ref = { provider: SCRIPTED_PROVIDER_NAME, model: SCRIPTED_MODEL };
  // No conversation tier: the brain stays on its single loop, one call per step.
  host.setTierMap({ low: ref, medium: ref, high: ref });
  console.warn('[llm] the stand-in model is bound: this brain answers from a script, not from a model. Development only.');
  return 'bound';
}

/** Whether the stand-in is what the model manager would answer with. */
export function scriptedModelBound(host: Pick<ScriptedModelHost, 'getProviderNames'>): boolean {
  const names = host.getProviderNames();
  return names.length === 1 && names[0] === SCRIPTED_PROVIDER_NAME;
}
