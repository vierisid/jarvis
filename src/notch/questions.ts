/**
 * A workflow's question on the notch.
 *
 * A workflow step can stop and ask a person: to approve or reject, or to fill
 * a small form (workflows/runtime/human-input.ts). The run waits, with a
 * deadline. Nothing in the product announces such a question; the dashboard
 * finds them by looking, and so does this.
 *
 * What the notch does with one depends on whether it can show it whole,
 * which is the rule every surface smaller than the dashboard follows:
 *
 *   - approve or reject, and it fits one line: yes approves. Not now is
 *     never reject, and there is no key for reject.
 *   - one choice from a few short options, and it fits one line: a row of
 *     choices.
 *   - a yes-or-no field: two choices.
 *   - anything else (text to type, several fields, a long explanation, many
 *     or long options): the line says who asks and for what, and yes opens
 *     the dashboard, where the whole of it is.
 *
 * An answer burns a fuse first, like everything that goes out from the
 * notch, and goes through the product's own function for answering, which
 * refuses a second answer.
 */
import type { HumanRequest, InputField } from '../workflows/runtime/human-input-contract.ts';
import type { NotchInbox, NotchItem, NotchItemEnd } from './inbox.ts';
import type { NotchPart } from './protocol.ts';
import type { NotchStage } from './stage.ts';

/** How often the pending questions are looked at. */
export const NOTCH_QUESTION_LOOK_MS = 5000;
/** How long the fuse burns between an answer and its going out. */
export const NOTCH_QUESTION_FUSE_MS = 3000;
/** A question older than this when first seen joins the count without speaking up. */
const FRESH_MS = 60_000;
/** The most a question's words may be for the notch to show it whole. */
const WHOLE_CHARS = 120;
const MAX_OPTIONS = 4;
const OPTION_CHARS = 24;

export interface NotchQuestionDeps {
  /** The questions waiting for an answer now. */
  pending(): HumanRequest[];
  get(id: string): HumanRequest | null;
  /** Answers through the product's own function. `status` is 200 when it was taken. */
  answer(id: string, input: { decision: 'approve' | 'submit'; generation: number; answers?: Record<string, unknown> }): { status: number; error?: string };
  openDashboard?: (sidecarId: string | null) => void;
  now?: () => number;
  fuseMs?: number;
  log?: (line: string) => void;
}

export interface NotchQuestions {
  sync(): void;
  itemId(request: Pick<HumanRequest, 'id' | 'generation'>): string;
}

/** How the notch can ask it: with a yes, with a row of choices, or only by pointing at the dashboard. */
export type NotchQuestionShape =
  | { way: 'yes' }
  | { way: 'choices'; field: InputField; options: string[]; values: unknown[] }
  | { way: 'open' };

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The question's own words: its title, and its prompt when there is one. */
export function questionWords(request: Pick<HumanRequest, 'title' | 'prompt'>): string {
  const title = oneLine(request.title), prompt = oneLine(request.prompt);
  if (!prompt || prompt === title) return title;
  return /[.?!:]$/.test(title) ? `${title} ${prompt}` : `${title}. ${prompt}`;
}

export function notchQuestionShape(request: HumanRequest): NotchQuestionShape {
  const whole = [...questionWords(request)].length <= WHOLE_CHARS;
  if (!whole) return { way: 'open' };
  if (request.kind === 'approval') return { way: 'yes' };
  if (request.fields.length !== 1) return { way: 'open' };
  const field = request.fields[0]!;
  if (field.type === 'boolean') return { way: 'choices', field, options: ['Yes', 'No'], values: [true, false] };
  if (field.type !== 'select') return { way: 'open' };
  const options = field.options ?? [];
  if (options.length < 1 || options.length > MAX_OPTIONS || options.some((option) => [...option].length > OPTION_CHARS)) return { way: 'open' };
  return { way: 'choices', field, options, values: options };
}

const em = (text: string): NotchPart => ({ em: text });

export function attachNotchQuestions(inbox: NotchInbox, deps: NotchQuestionDeps): NotchQuestions {
  const now = deps.now ?? Date.now;
  const fuseMs = deps.fuseMs ?? NOTCH_QUESTION_FUSE_MS;
  const log = deps.log ?? ((line: string) => console.log(line));
  // A form reopened after it closed is a new question with the same id.
  const itemId = (request: Pick<HumanRequest, 'id' | 'generation'>): string => `question:${request.id}:${request.generation ?? 0}`;
  const known = new Map<string, HumanRequest>();
  /** Questions being answered on the notch, from the answer until the notch has said what came of it. */
  const answering = new Set<string>();

  const stillPending = (request: HumanRequest): HumanRequest | null => {
    const current = deps.get(request.id);
    return current && current.status === 'pending' && (current.generation ?? 0) === (request.generation ?? 0) ? current : null;
  };

  async function send(request: HumanRequest, stage: NotchStage, said: NotchPart[], input: { decision: 'approve' | 'submit'; answers?: Record<string, unknown> }): Promise<NotchItemEnd | 'again'> {
    const id = itemId(request);
    answering.add(id);
    try {
      const fuse = await stage.fuse(said, fuseMs, { mood: 'work', who: request.workflowName || undefined });
      if (fuse === 'undo') return 'again';
      if (fuse === 'lost') return 'waits';
      let result: { status: number; error?: string };
      try {
        result = deps.answer(request.id, { ...input, generation: request.generation ?? 0 });
      } catch (error) {
        log(`[notch] a workflow question could not be answered: ${error instanceof Error ? error.message : String(error)}`);
        await stage.say(['That did not go through. It still waits.'], 2600, { mood: 'sorry', mark: 'fail' });
        return 'waits';
      }
      if (result.status === 200) {
        await stage.say(['Answered. The workflow goes on.'], 2000, { mood: 'happy', mark: 'check' });
        return 'settled';
      }
      if (result.status === 409 || result.status === 404) {
        await stage.say(['Already answered somewhere else.'], 2600);
        return 'settled';
      }
      log(`[notch] a workflow question refused the answer (${result.status}): ${result.error ?? ''}`);
      await stage.say(['It did not take that answer. Open it in the dashboard.'], 3200, { mood: 'careful', mark: 'fail' });
      return 'waits';
    } finally {
      answering.delete(id);
    }
  }

  async function play(first: HumanRequest, stage: NotchStage): Promise<NotchItemEnd> {
    for (;;) {
      const request = stillPending(first);
      if (!request) return 'settled';
      const who = request.workflowName || undefined;
      const words = questionWords(request);
      const shape = notchQuestionShape(request);
      if (shape.way === 'open') {
        const title = oneLine(request.title);
        const cut = [...title].length > WHOLE_CHARS ? `${[...title].slice(0, WHOLE_CHARS - 1).join('')}…` : title;
        const answer = await stage.offer(['Needs an answer in the dashboard: ', em(cut)], 'open', { mood: 'curious', who });
        if (answer.act !== 'yes') return 'waits';
        deps.openDashboard?.(stage.from());
        await stage.say(['It is open in the dashboard.'], 1800);
        return 'waits';
      }
      if (shape.way === 'yes') {
        const answer = await stage.offer([/[?]$/.test(words) ? words : `${words.replace(/[.]+$/, '')}?`], 'approve', { mood: 'curious', who });
        if (answer.act !== 'yes') return 'waits';
        const end = await send(request, stage, ['Approving…'], { decision: 'approve' });
        if (end === 'again') continue;
        return end;
      }
      const answer = await stage.choose([words], shape.options, { mood: 'curious', who });
      if (answer.act !== 'pick' || answer.index === undefined || answer.index >= shape.options.length) return 'waits';
      const picked = shape.options[answer.index]!;
      const end = await send(request, stage, ['Answering ', em(picked), '…'], { decision: 'submit', answers: { [shape.field.key]: shape.values[answer.index] } });
      if (end === 'again') continue;
      return end;
    }
  }

  function item(request: HumanRequest): NotchItem {
    return {
      id: itemId(request),
      subject: itemId(request),
      // A run is stopped on it, with a deadline.
      class: 'clock',
      speaks: now() - request.created < FRESH_MS,
      title: () => [request.workflowName ? `${request.workflowName}: ` : '', oneLine(request.title)],
      check: () => stillPending(request) !== null,
      play: (stage) => play(request, stage),
    };
  }

  function sync(): void {
    let pending: HumanRequest[];
    try {
      pending = deps.pending().filter((request) => request.status === 'pending');
    } catch (error) {
      log(`[notch] the workflow questions could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const ids = new Set(pending.map((request) => itemId(request)));
    for (const request of [...pending].sort((a, b) => a.created - b.created)) {
      const id = itemId(request);
      if (known.has(id)) continue;
      known.set(id, request);
      inbox.add(item(request));
    }
    for (const id of [...known.keys()]) {
      if (ids.has(id) || answering.has(id)) continue;
      known.delete(id);
      inbox.remove(id);
    }
  }

  return { sync, itemId };
}
