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
 *   - approve or reject, and it fits one line: yes approves, and Esc
 *     rejects, through the same function.
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
 *
 * Esc is a no. On approve-or-reject it rejects. On a question that is not a
 * yes or a no (a choice, a form), there is no "no" to give: Esc takes it off
 * the notch for good, and it stays in the dashboard, where it can still be
 * answered until its deadline. A line left alone until it folds goes back to
 * the count and comes round again.
 */
import type { HumanRequest, InputField } from '../workflows/runtime/human-input-contract.ts';
import { notchAskedHow, type NotchActionAsked, type NotchActionEntry, type NotchActionHow, type NotchActionOutcome, type NotchActions } from './actions.ts';
import { playDecidable } from './decide.ts';
import type { NotchFeatureDef } from './feature.ts';
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
  answer(id: string, input: { decision: 'approve' | 'reject' | 'submit'; generation: number; answers?: Record<string, unknown> }): { status: number; error?: string };
  openDashboard?: (sidecarId: string | null) => void;
  /** Where an answer that was given from the notch is written down (./actions.ts). */
  actions?: NotchActions | null;
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
  /** Questions taken off the notch with Esc that the product still holds: not shown again. */
  const dismissed = new Set<string>();

  const stillPending = (request: HumanRequest): HumanRequest | null => {
    const current = deps.get(request.id);
    return current && current.status === 'pending' && (current.generation ?? 0) === (request.generation ?? 0) ? current : null;
  };

  /** An answer given from the notch, as it is written down (./actions.ts): which question of which workflow, and the answer. */
  const entry = (request: HumanRequest, gave: string, asked: NotchActionAsked, outcome: NotchActionOutcome): NotchActionEntry => ({
    kind: 'question', outcome, what: `${gave}: ${oneLine(request.title)}`, target: request.workflowName || null, asked,
  });

  async function send(request: HumanRequest, stage: NotchStage, said: NotchPart[], input: { decision: 'approve' | 'submit'; answers?: Record<string, unknown> }, gave: string, how: NotchActionHow): Promise<NotchItemEnd | 'again'> {
    const id = itemId(request);
    answering.add(id);
    try {
      // The fuse, the answer, and the one entry of what came of it (./decide.ts).
      const decided = await playDecidable(stage, {
        asked: { seen: 'line', how },
        fuse: { say: said, ms: fuseMs, extras: { mood: 'work', who: request.workflowName || undefined } },
        act: async () => {
          let result: { status: number; error?: string };
          try {
            result = deps.answer(request.id, { ...input, generation: request.generation ?? 0 });
          } catch (error) {
            log(`[notch] a workflow question could not be answered: ${error instanceof Error ? error.message : String(error)}`);
            return { outcome: 'not_done', result: null };
          }
          // Answered somewhere else a moment before (409, 404): this answer did nothing, and is not written down.
          return { outcome: result.status === 409 || result.status === 404 ? null : result.status === 200 ? 'done' : 'not_done', result };
        },
        entry: (outcome, asked) => entry(request, gave, asked, outcome),
      }, deps);
      if (decided.took === 'undo') return 'again';
      if (decided.took !== 'acted') return 'waits';
      const result = decided.result;
      if (!result) {
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

  /** Esc on an approve-or-reject question: reject it, and go on without a word. */
  function reject(request: HumanRequest, stage: NotchStage): NotchItemEnd | Promise<NotchItemEnd> {
    let result: { status: number; error?: string };
    try {
      result = deps.answer(request.id, { decision: 'reject', generation: request.generation ?? 0 });
    } catch (error) {
      log(`[notch] a workflow question could not be rejected: ${error instanceof Error ? error.message : String(error)}`);
      return stage.say(['That did not go through. It still waits.'], 2600, { mood: 'sorry', mark: 'fail' }).then(() => 'waits' as const);
    }
    // Esc on its line was the no, with no fuse: a rejection that was taken is something the workflow acts on.
    if (result.status === 200) deps.actions?.record(entry(request, 'Rejected', { seen: 'line', how: 'key' }, 'done'));
    // Rejected here, or already answered somewhere else: it no longer waits.
    if (result.status === 200 || result.status === 409 || result.status === 404) {
      stage.surface.act({ gesture: 'shake' });
      return 'settled';
    }
    log(`[notch] a workflow question refused the rejection (${result.status}): ${result.error ?? ''}`);
    return stage.say(['It did not take that. Open it in the dashboard.'], 3200, { mood: 'careful', mark: 'fail' }).then(() => 'waits' as const);
  }

  /** Esc on a question with no "no" to give: off the notch for good, still in the dashboard. */
  function dismiss(request: HumanRequest, stage: NotchStage): NotchItemEnd {
    dismissed.add(itemId(request));
    stage.surface.act({ gesture: 'shake' });
    return 'settled';
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
        if (answer.act === 'no') return dismiss(request, stage);
        if (answer.act !== 'yes') return 'waits';
        deps.openDashboard?.(stage.from());
        await stage.say(['It is open in the dashboard.'], 1800);
        return 'waits';
      }
      if (shape.way === 'yes') {
        const answer = await stage.offer([/[?]$/.test(words) ? words : `${words.replace(/[.]+$/, '')}?`], 'approve', { mood: 'curious', who });
        if (answer.act === 'no') return reject(request, stage);
        if (answer.act !== 'yes') return 'waits';
        const end = await send(request, stage, ['Approving…'], { decision: 'approve' }, 'Approved', notchAskedHow(stage));
        if (end === 'again') continue;
        return end;
      }
      const answer = await stage.choose([words], shape.options, { mood: 'curious', who });
      if (answer.act === 'no') return dismiss(request, stage);
      if (answer.act !== 'pick' || answer.index === undefined || answer.index >= shape.options.length) return 'waits';
      const picked = shape.options[answer.index]!;
      const end = await send(request, stage, ['Answering ', em(picked), '…'], { decision: 'submit', answers: { [shape.field.key]: shape.values[answer.index] } }, `Answered ${picked}`, notchAskedHow(stage, 'pick'));
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
    // What is no longer pending needs no remembering.
    for (const id of dismissed) if (!ids.has(id)) dismissed.delete(id);
    for (const request of [...pending].sort((a, b) => a.created - b.created)) {
      const id = itemId(request);
      if (known.has(id) || dismissed.has(id)) continue;
      known.set(id, request);
      inbox.add(item(request));
    }
    for (const id of [...known.keys()]) {
      if ((ids.has(id) && !dismissed.has(id)) || answering.has(id)) continue;
      known.delete(id);
      inbox.remove(id);
    }
  }

  return { sync, itemId };
}

/**
 * The questions as a feature of the notch (./feature.ts): looked for when it
 * is made, and every few seconds after. Absent on a brain that was not given
 * the product's questions.
 */
export function notchQuestionsFeature(given: Pick<NotchQuestionDeps, 'pending' | 'get' | 'answer' | 'openDashboard' | 'actions'> | undefined): NotchFeatureDef<'questions'> {
  return {
    id: 'questions',
    make(ctx) {
      if (!given) return null;
      const api = attachNotchQuestions(ctx.inbox, { ...given, log: ctx.log });
      api.sync();
      return { api, ticks: [{ name: 'looking for questions', everyMs: NOTCH_QUESTION_LOOK_MS, run: () => api.sync() }] };
    },
  };
}
