/**
 * What running a skill will actually do, resolved from its stored steps.
 *
 * run_skill replays whatever the named skill holds, so no single category on
 * the tool can be right: the steps span control_app (every click), and
 * through the app they drive, send_email, send_message, make_payment or
 * delete_data. The authority gate therefore classifies each step and gates
 * the run on the worst case, the same shape #474 gave workflow pieces.
 *
 * Rules:
 *   - Every acting step is at least control_app: the floor is the same
 *     category as desktop_click, because that is what it dispatches.
 *   - An author-declared `effect` adds a check; it never removes a detected
 *     effect, even when the declared category has a higher severity.
 *   - Acting steps without a business-effect hint/declaration need explicit
 *     review. A hint is not proof of an arbitrary event handler's semantics.
 *   - The classifier raises a step from what the skill's app and the target's
 *     accessible name say: "Send" in a mail app sends email, Enter in a
 *     messaging composer sends a message, "Pay"/"Checkout" pays,
 *     "Delete"/"Discard" destroys.
 *   - A step whose action the runtime does not know cannot be classified. It
 *     is gated as UNRESOLVED_STEP_CATEGORY, the most severe category a UI
 *     action reaches, and the skill is marked invalid so run_skill refuses it
 *     before dispatching anything. Over-gated, never under-gated.
 *
 * Pure: no I/O, no vault access. The intent sentence it builds is what the
 * approval card shows, with the resolved parameter values, so the user
 * approves "clicks Send in Gmail", not "run a skill".
 */

import type { ActionCategory } from '../roles/authority.ts';
import { AUTHORITY_REQUIREMENTS } from '../roles/authority.ts';
import { severityRank, stricterCategory } from '../authority/tool-action-map.ts';
import { fillParams, isSkillAction, resolveArgs, type Skill, type SkillParam, type SkillStep } from './types.ts';
import { uiEffectHints } from '../authority/ui-intent';
import { forCard } from '../util/card-text.ts';

export const SKILL_EFFECT_FLOOR: ActionCategory = 'control_app';

/**
 * Mirrors the `unknownActionCategory` choice of the governed piece adapters:
 * an unclassifiable step is gated as a deletion, the most severe thing a
 * click can do short of a payment, and the run is refused anyway.
 */
export const UNRESOLVED_STEP_CATEGORY: ActionCategory = 'delete_data';

export type StepEffect = {
  index: number;
  /** The stricter of the floor and what the step does; what the audit row carries. */
  category: ActionCategory;
  /**
   * Every category the step reaches: the floor, plus its semantic effect
   * when it has one even if that sits below the floor (send_message is
   * level 3, control_app level 5, and a config may govern the former).
   */
  reached: ActionCategory[];
  /** Short present-tense description, e.g. `click Send (sends email)`. */
  summary: string;
  /** No business-effect hint/declaration is available for this acting step. */
  uncertain?: boolean;
};

export type SkillEffect = {
  /** Worst case across the steps; what the run is gated on. */
  category: ActionCategory;
  /** Every category the run must clear, most severe first. */
  categories: ActionCategory[];
  steps: StepEffect[];
  /** Set when a step cannot be classified; run_skill refuses such a skill. */
  invalid?: string;
  /** Card-ready sentence with resolved parameter values. */
  intent: string;
  requiresReview: boolean;
};

const SECRET_PARAM_NAME = /password|passcode|passwd|\bpin\b|secret|cvv|token|api[_-]?key|otp/i;

function skillContext(skill: Pick<Skill, 'name' | 'app' | 'match'>): string {
  return [skill.name, skill.app, ...(skill.match.domains ?? []), ...(skill.match.processNames ?? []), ...(skill.match.keywords ?? [])]
    .filter(Boolean)
    .join(' ');
}

function categoryVerb(category: ActionCategory): string {
  switch (category) {
    case 'send_email': return 'sends email';
    case 'send_message': return 'sends a message';
    case 'make_payment': return 'pays';
    case 'delete_data': return 'deletes';
    case 'modify_settings': return 'changes settings';
    default: return category.replace(/_/g, ' ');
  }
}

/**
 * Caps for unvetted text in the MIDDLE of the run_skill sentence (#706). Every
 * value here has more sentence after it -- the `(sends email)` this file
 * appends, the next step, the trailing review notice -- so each takes a short
 * cap, the one that stops a value forging an ending or pushing the step that
 * sends thousands of characters down the sentence. It bounds the sentence, not
 * the surface: a card that clamps to a few lines can still hide a later step,
 * and the eight-step cap below can drop one; neither is decided here. 80 for a
 * name or label is the sibling convention
 * (`CARD_NAME_MAX` in actions/tools/skills.ts, `UI_CARD_VALUE` in ui.ts); 40
 * for a typed value, a key chord or a URL is the cap `shortValue` always had.
 */
const CARD_LABEL_MAX = 80;
const CARD_VALUE_MAX = 40;

/**
 * Unvetted text, reduced for the card (#706): `forCard` drops every
 * Default_Ignorable code point and the C0/DEL/C1 controls, collapses
 * whitespace and caps with a visible `...`. A bidi override in a recorded
 * label would otherwise reorder the rest of the line, including a later
 * `click Send (sends email)`.
 */
function cardLabel(v: unknown, max = CARD_LABEL_MAX): string {
  return forCard(v, max);
}

/**
 * The same, inside quotes that cannot be closed from within: `JSON.stringify`
 * escapes `"` and `\`, so a name such as `x" in Notepad (v9, authored): ...`
 * stays visibly one quoted value. A look-alike quote (U+201D) is not escaped;
 * it cannot end the literal, only resemble an end, and the escaped real quote
 * after it still shows where the value stops. Ordinary text is unchanged.
 */
function quotedCardValue(v: unknown, max: number): string {
  return JSON.stringify(cardLabel(v, max));
}

function shortValue(v: string | undefined, secret: boolean): string {
  if (v === undefined) return '';
  if (secret) return '[secret]';
  return quotedCardValue(v, CARD_VALUE_MAX);
}

/** Params whose value must never appear on a card or in a log line. */
export function isSecretParam(p: Pick<SkillParam, 'name' | 'secret'>): boolean {
  return p.secret === true || SECRET_PARAM_NAME.test(p.name);
}

/** True when `value` is a template that references a secret param. */
function referencesSecret(value: string | undefined, params: SkillParam[]): boolean {
  if (!value) return false;
  const names = [...value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!);
  return names.some((n) => {
    const p = params.find((x) => x.name === n);
    return p ? isSecretParam(p) : SECRET_PARAM_NAME.test(n);
  });
}

export function classifyStep(
  step: SkillStep,
  index: number,
  skill: Pick<Skill, 'name' | 'app' | 'match' | 'params'>,
  args: Record<string, string>,
): StepEffect {
  const ctx = skillContext(skill);
  if (!isSkillAction(step.action)) {
    return { index, category: UNRESOLVED_STEP_CATEGORY, reached: [UNRESOLVED_STEP_CATEGORY, SKILL_EFFECT_FLOOR],
      summary: `unknown action ${quotedCardValue(String(step.action), CARD_VALUE_MAX)}` };
  }
  const secret = referencesSecret(step.value, skill.params);
  const filled = step.value !== undefined && !secret ? fillParams(step.value, args) : step.value;
  // Display only: the classifier below still judges the raw accessible name.
  // A name that reduces to nothing (invisibles only) falls back to the role.
  const target = cardLabel(step.ref?.name) || cardLabel(step.ref?.role) || 'element';

  // What the step does beyond controlling the app, if anything.
  const semantics = uiEffectHints(step.action, step.ref?.name ?? '', ctx, filled ?? '');
  let summary: string;
  switch (step.action) {
    case 'wait':
      return { index, category: 'read_data', reached: ['read_data'], summary: `wait ${step.ms ?? 500}ms` };
    case 'click':
      summary = `click ${target}`;
      break;
    case 'set_value':
      summary = `type ${shortValue(filled, secret)} into ${target}`;
      break;
    case 'press_keys': {
      summary = `press ${cardLabel(filled, CARD_VALUE_MAX)}`.trim();
      break;
    }
    case 'navigate':
      summary = `open ${shortValue(filled, secret)}`;
      break;
    case 'launch_app':
      summary = `launch ${shortValue(filled, secret)}`;
      break;
  }
  if (step.effect && Object.hasOwn(AUTHORITY_REQUIREMENTS, step.effect) && step.effect !== 'read_data') {
    semantics.push(step.effect);
  }
  // Severity is for display only. A declared payment/delete must never erase
  // an inferred send: every reached category keeps its own deny/approval rule.
  const reached = [...new Set<ActionCategory>([SKILL_EFFECT_FLOOR, ...semantics])]
    .sort((a, b) => severityRank(b) - severityRank(a));
  const category = reached[0]!;
  for (const semantic of new Set(semantics)) {
    if (semantic !== SKILL_EFFECT_FLOOR) summary += ` (${categoryVerb(semantic)})`;
  }
  const uncertain = !semantics.some(c => c !== SKILL_EFFECT_FLOOR);
  return { index, category, reached, summary, uncertain };
}

const MAX_INTENT_STEPS = 8;

/**
 * WHAT #706 MOVED. The sentence is compared after approval: the deferred
 * executor refuses a call whose gate intent no longer equals the approved one,
 * and a workflow's run_skill step digests it into the reviewed target. So a
 * run_skill approval still PENDING at upgrade whose sentence the reduction
 * changes -- an invisible or control character anywhere in it; a run of
 * whitespace in the skill name, app, a label or a key; a quote or backslash in
 * a quoted value (the skill name, a typed value, a URL or app to open, an
 * unknown action); a name, app or label over 80 characters or
 * a key over 40 -- is refused when approved ("what it would do changed
 * after approval" in chat, "Workflow execution target changed after review"
 * in a workflow), and the person asks again and gets the reduced card. A
 * sentence made only of ordinary text is byte-exact, so its approvals stand.
 */
export function resolveSkillEffect(skill: Skill, callerArgs: Record<string, string>): SkillEffect {
  // The card shows the values the run will actually type: the caller's over
  // the recorded defaults, exactly as the runtime resolves them.
  const args = resolveArgs(skill.params, callerArgs);
  const steps = skill.steps.map((s, i) => classifyStep(s, i, skill, args));
  let category: ActionCategory = SKILL_EFFECT_FLOOR;
  const reached = new Set<ActionCategory>([SKILL_EFFECT_FLOOR]);
  let invalid: string | undefined;
  for (const s of steps) {
    category = stricterCategory(category, s.category);
    for (const c of s.reached) if (c !== 'read_data') reached.add(c);
    if (!isSkillAction(skill.steps[s.index]!.action) && !invalid) {
      invalid = `step ${s.index + 1} has an unknown action "${String(skill.steps[s.index]!.action)}"`;
    }
  }
  const categories = [...reached].sort((a, b) => severityRank(b) - severityRank(a));
  const acting = steps.filter((s) => skill.steps[s.index]!.action !== 'wait');
  const shown = acting.slice(0, MAX_INTENT_STEPS).map((s) => s.summary);
  const more = acting.length > MAX_INTENT_STEPS ? `; +${acting.length - MAX_INTENT_STEPS} more steps` : '';
  const app = cardLabel(skill.app);
  const where = app ? ` in ${app}` : '';
  const requiresReview = acting.some(s => s.uncertain);
  const intent = `Run skill ${quotedCardValue(skill.name, CARD_LABEL_MAX)}${where} (v${skill.version}, ${skill.provenance}): ${shown.join('; ')}${more}${requiresReview ? '. Business effect unknown for some UI steps; review the current screen and the full procedure before approving.' : ''} UI effect labels are hints, not verified business outcomes.`;
  return { category, categories, steps, invalid, intent, requiresReview };
}
