/**
 * A brain for the page's tests.
 *
 * The page's contract tests say what they tell the page in a few plain
 * words: show this line, rest, this many wait, do this once. This turns each
 * into what the brain really sends in version 2 of the messages (a `state`,
 * a `patch` or an `effect`, numbered in a row, a line with its rules written
 * into it by the brain's own `notchRuled`), so that everything a test tells
 * the page goes through the page's reader as on a desktop. And it does to
 * the page's answers what the brain does: it says `ack` to each, at once.
 *
 * What the test is handed of what the page said is the answer as the person
 * gave it: without its number, its timing and the run of the brain it answers, and without the page's own
 * reports (`at`, `hand`). All of it, as it went out, is in `wire`.
 *
 * A test of the messages themselves says them as they are, with `raw`, and
 * turns the acknowledging off with `acks`.
 */
import { NOTCH_PROTOCOL_VERSION, notchRuled } from '../../../../src/notch/protocol.ts';
import type { NotchFromPage, NotchLine } from '../../../../src/notch/protocol.ts';
import type { NotchSurface, NotchSurfaceOptions } from './index.ts';

/** What a test tells the page: one of the plain words below, or a message as it is. */
export type ScriptedMessage = { type: string } & Record<string, unknown>;

export interface ScriptedSurface extends Omit<NotchSurface, 'receive'> {
  /**
   * `state`, `show`, `rest`, `count`, `face`, `where`, `update` and `act` are
   * said as the brain says them in version 2. Anything else goes to the page
   * as it is.
   */
  receive(message: ScriptedMessage): void;
  /** A message exactly as given: nothing is numbered, nothing is added. */
  raw(message: unknown): void;
  /** Everything the page said, as it went out. */
  wire: NotchFromPage[];
  /** Whether each answer is acknowledged at once, as a brain that is there does. On unless turned off. */
  acks: boolean;
  /** The number of the last message this brain numbered. */
  seq(): number;
  /** The name this brain gives itself in a `state`. */
  brain: string;
}

/** The line as the brain tells it, with its rules. What is not a line stays what it is, for the page to refuse. */
export function ruled(line: unknown): unknown {
  if (line === undefined || line === null) return {};
  try { return notchRuled(line as NotchLine); } catch { return line; }
}

const KEPT = ['eye', 'sound', 'park', 'mouth'] as const;

/** Turns what a test says in plain words into the messages the brain sends, numbered in one row. */
export interface ScriptedBrain {
  /** The messages for one thing a test says: one, or two when version 1 said in one message what version 2 says in two. */
  messages(message: unknown): unknown[];
  /** The number of the last message this brain numbered. */
  seq(): number;
  /** The name this brain gives itself in a `state`. */
  name: string;
}

export function scriptedBrain(name = 'test-brain'): ScriptedBrain {
  let seq = 0;
  const numbered = (message: Record<string, unknown>): unknown => ({ ...message, seq: ++seq });
  const brain: ScriptedBrain = {
    name,
    seq: () => seq,
    messages(message) {
      if (typeof message !== 'object' || message === null || Array.isArray(message)) return [message];
      const { type, ...rest } = message as ScriptedMessage;
      if (type === 'state' && !('seq' in rest)) {
        return [numbered({ type, v: NOTCH_PROTOCOL_VERSION, brain: brain.name, ...rest, ...(rest.line === null || rest.line === undefined ? {} : { line: ruled(rest.line) }) })];
      }
      if (type === 'show') return [numbered({ type: 'patch', line: ruled(rest.line) })];
      if (type === 'rest') return [numbered({ type: 'patch', line: null })];
      if (type === 'count') return [numbered({ type: 'patch', count: 'count' in rest ? rest.count : 'missing' })];
      if (type === 'face') return [numbered({ type: 'patch', face: rest.mood })];
      if (type === 'where') return [numbered({ type: 'patch', where: rest.app })];
      if (type === 'update') return [numbered({ type: 'patch', edit: rest })];
      if (type === 'act') {
        // What the notch is goes as a patch, and what it does once as an effect: version 1 said both in one.
        const kept: Record<string, unknown> = {}, once: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(rest)) ((KEPT as readonly string[]).includes(key) ? kept : once)[key] = value;
        if (kept.mouth === 'gulp') { kept.mouth = 'shut'; once.gulp = true; }
        const out: unknown[] = [];
        if (Object.keys(kept).length > 0) out.push(numbered({ type: 'patch', ...kept }));
        if (Object.keys(once).length > 0 || out.length === 0) out.push(numbered({ type: 'effect', ...once }));
        return out;
      }
      return [message];
    },
  };
  return brain;
}

export function scripted(
  create: (root: HTMLElement, send: (message: NotchFromPage) => void, options?: NotchSurfaceOptions) => NotchSurface,
): (root: HTMLElement, send: (message: NotchFromPage) => void, options?: NotchSurfaceOptions) => ScriptedSurface {
  return (root, send, options) => {
    const brain = scriptedBrain();
    const wire: NotchFromPage[] = [];
    // eslint-disable-next-line prefer-const
    let page: ScriptedSurface;
    const real = create(root, (message) => {
      wire.push(message);
      if (message.type === 'at' || message.type === 'hand') return;
      if (message.type !== 'answer') { send(message); return; }
      const { n, since: _since, brain: _brain, ...said } = message;
      send(said);
      if (page.acks && n !== undefined) real.receive({ type: 'ack', n, took: true });
    }, options);
    page = {
      ...real,
      wire,
      acks: true,
      brain: brain.name,
      seq: brain.seq,
      raw: (message) => real.receive(message as never),
      receive(message) {
        brain.name = page.brain;
        for (const each of brain.messages(message)) real.receive(each as never);
      },
    };
    return page;
  };
}
