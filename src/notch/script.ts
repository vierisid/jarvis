/**
 * The dev route for the stand-in model (src/llm/scripted.ts): load a script,
 * read back what was asked of it, and send words as if they had been typed or
 * spoken on the notch.
 *
 * It sits behind the notch's dev gate (./demo-gate.ts), so what the gate's
 * secret is worth must not grow by more than is written here:
 *
 *   - A script's words are free: the secret already lets its holder put
 *     sentences on the notch.
 *   - A script's tool calls are not. Tools are real and really run, so only
 *     the calls listed in NOTCH_SCRIPT_TOOLS are accepted, with exactly the
 *     arguments given there: read this machine's name, ask for an approval
 *     (which runs nothing), and the one fixed echo the fixtures already use.
 *   - Words can be sent as if typed or spoken only while the stand-in is the
 *     model that answers. On a brain with a real model the route refuses:
 *     there, an instruction to Jarvis has to come from the person's own hands.
 */
import { NOTCH_FIXTURE_COMMAND } from './fixtures.ts';
import type { ScriptedCall, ScriptedStep, ScriptedTurn } from '../llm/scripted.ts';

/**
 * The failures a script may fake. The ones the model manager tries again by
 * itself (a rate limit, the network, a server fault) are left out: a scripted
 * one would be tried three times and answer the same each time.
 */
const LLM_ERROR_CODES: ReadonlySet<string> = new Set(['auth', 'forbidden', 'bad_request', 'not_found', 'content_policy', 'unknown']);

export const NOTCH_SCRIPT_MAX_TURNS = 40;
export const NOTCH_SCRIPT_MAX_STEPS = 8;
export const NOTCH_SCRIPT_MAX_TEXT = 8000;

/** The only tool calls a script may make, and how each one's arguments are checked. */
export const NOTCH_SCRIPT_TOOLS: Record<string, (args: Record<string, unknown>) => Record<string, unknown> | null> = {
  get_system_info: (args) => (Object.keys(args).length === 0 ? {} : null),
  run_command: (args) => (Object.keys(args).length === 1 && args.command === NOTCH_FIXTURE_COMMAND ? { command: NOTCH_FIXTURE_COMMAND } : null),
  request_approval: (args) => {
    const keys = Object.keys(args);
    if (keys.some((key) => key !== 'action_category' && key !== 'intent')) return null;
    const category = args.action_category, intent = args.intent;
    if (typeof category !== 'string' || !/^[a-z_]{3,40}$/.test(category)) return null;
    if (typeof intent !== 'string' || intent.length < 3 || intent.length > 160 || /[\r\n]/.test(intent)) return null;
    return { action_category: category, intent };
  },
};

export class NotchScriptError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function step(raw: unknown, where: string): ScriptedStep {
  if (!isObject(raw)) throw new NotchScriptError(`${where} is not an object`);
  const made: ScriptedStep = {};
  if (raw.text !== undefined) {
    if (typeof raw.text !== 'string' || raw.text.length > NOTCH_SCRIPT_MAX_TEXT) throw new NotchScriptError(`${where}: text must be a string of at most ${NOTCH_SCRIPT_MAX_TEXT} characters`);
    made.text = raw.text;
  }
  if (raw.delay_ms !== undefined) {
    if (typeof raw.delay_ms !== 'number' || !Number.isInteger(raw.delay_ms) || raw.delay_ms < 0 || raw.delay_ms > 60_000) throw new NotchScriptError(`${where}: delay_ms must be a whole number from 0 to 60000`);
    made.delay_ms = raw.delay_ms;
  }
  if (raw.error !== undefined) {
    if (!isObject(raw.error) || typeof raw.error.message !== 'string' || raw.error.message.length > 300
      || typeof raw.error.code !== 'string' || !LLM_ERROR_CODES.has(raw.error.code)) throw new NotchScriptError(`${where}: error needs a known code and a message`);
    made.error = { code: raw.error.code as NonNullable<ScriptedStep['error']>['code'], message: raw.error.message };
  }
  if (raw.tool_calls !== undefined) {
    if (!Array.isArray(raw.tool_calls) || raw.tool_calls.length > 3) throw new NotchScriptError(`${where}: tool_calls must be a list of at most 3`);
    made.tool_calls = raw.tool_calls.map((call, i) => {
      if (!isObject(call) || typeof call.name !== 'string') throw new NotchScriptError(`${where}: tool call ${i + 1} has no name`);
      const check = Object.hasOwn(NOTCH_SCRIPT_TOOLS, call.name) ? NOTCH_SCRIPT_TOOLS[call.name] : undefined;
      const args = call.arguments === undefined ? {} : call.arguments;
      const allowed = check && isObject(args) ? check(args) : null;
      if (!allowed) {
        throw new NotchScriptError(`${where}: a script may only call ${Object.keys(NOTCH_SCRIPT_TOOLS).join(', ')}, with their fixed arguments. "${call.name.slice(0, 40)}" with those arguments is not one of them`);
      }
      return { name: call.name, arguments: allowed };
    });
  }
  for (const key of Object.keys(raw)) {
    if (!['text', 'delay_ms', 'error', 'tool_calls'].includes(key)) throw new NotchScriptError(`${where}: "${key.slice(0, 40)}" is not part of a step`);
  }
  return made;
}

/** Reads a script as it arrives. Throws a sentence saying what is wrong with it. */
export function readNotchScript(raw: unknown): ScriptedTurn[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > NOTCH_SCRIPT_MAX_TURNS) {
    throw new NotchScriptError(`A script is a list of 1 to ${NOTCH_SCRIPT_MAX_TURNS} turns`);
  }
  return raw.map((turn, i) => {
    const where = `turn ${i + 1}`;
    if (!isObject(turn)) throw new NotchScriptError(`${where} is not an object`);
    if (typeof turn.match !== 'string' || turn.match.trim().length < 2 || turn.match.length > 200) throw new NotchScriptError(`${where}: match must be 2 to 200 characters`);
    if (!Array.isArray(turn.steps) || turn.steps.length === 0 || turn.steps.length > NOTCH_SCRIPT_MAX_STEPS) throw new NotchScriptError(`${where}: steps must be a list of 1 to ${NOTCH_SCRIPT_MAX_STEPS}`);
    if (turn.plain !== undefined && typeof turn.plain !== 'boolean') throw new NotchScriptError(`${where}: plain must be true or false`);
    return {
      match: turn.match.trim(),
      ...(turn.plain === true ? { plain: true } : {}),
      steps: turn.steps.map((raw, j) => step(raw, `${where}, step ${j + 1}`)),
    };
  });
}

/** What the route needs from the brain. */
export interface NotchScriptDeps {
  /** Replaces the script and puts the stand-in on the model manager if it may be there. */
  load(turns: ScriptedTurn[]): 'bound' | 'already' | 'shut' | 'no-script' | 'real-model';
  turns(): ScriptedTurn[];
  calls(): ScriptedCall[];
  /** Whether the stand-in is the model that answers now. */
  bound(): boolean;
  /** Sends words as if typed in Home. */
  type(text: string): void;
  /** Sends words as if spoken. Null: a recording in which nothing was caught. */
  say(text: string | null): void;
}

export interface NotchScriptAnswer {
  status: number;
  body: Record<string, unknown>;
}

const WHY_NOT: Record<string, string> = {
  shut: 'The stand-in model is only for an isolated development brain (bun run dev:local).',
  'real-model': 'A real model is set up on this brain, so the stand-in model is not used.',
};

/** One request to the script route, after the gate has let it through. */
export function notchScriptOp(body: unknown, deps: NotchScriptDeps): NotchScriptAnswer {
  const data = isObject(body) ? body : {};
  const op = typeof data.op === 'string' ? data.op : '';
  if (op === 'list') return { status: 200, body: { turns: deps.turns(), calls: deps.calls().slice(-40), bound: deps.bound() } };
  if (op === 'clear') {
    deps.load([]);
    return { status: 200, body: { turns: 0, bound: deps.bound() } };
  }
  if (op === 'set') {
    let turns: ScriptedTurn[];
    try { turns = readNotchScript(data.turns); } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
    }
    const result = deps.load(turns);
    if (result === 'bound' || result === 'already') return { status: 200, body: { turns: turns.length, bound: true } };
    return { status: 409, body: { error: WHY_NOT[result] ?? 'The stand-in model could not be used.' } };
  }
  if (op === 'type' || op === 'say') {
    if (!deps.bound()) {
      return { status: 409, body: { error: 'Words can be sent this way only while the stand-in model answers. Load a script first; on a brain with a real model, type or speak on the notch itself.' } };
    }
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (text.length > 1000) return { status: 400, body: { error: 'At most 1000 characters.' } };
    if (op === 'type') {
      if (!text) return { status: 400, body: { error: 'Nothing to type.' } };
      deps.type(text);
      return { status: 200, body: { typed: text } };
    }
    deps.say(text || null);
    return { status: 200, body: text ? { said: text } : { said: null } };
  }
  return { status: 400, body: { error: 'op is one of: set, list, clear, type, say' } };
}
