import type { ReadinessIssue } from '../workflows/runtime/workflow-readiness';
import { forCard } from '../util/card-text';
import type { WorkflowFix } from './workflow-removal-contracts';

export interface WorkflowBlocker { reason: string; fix: WorkflowFix | null }

/**
 * Step names, app names and field labels are graph or piece text, and an
 * issue's message can echo graph text too (a reference name, a nested
 * workflow's first issue). So each is reduced the way an approval card reduces
 * a value (`forCard`: invisible, bidi and control characters dropped,
 * whitespace collapsed) and capped. A name sits mid-sentence, so its cap is
 * short and it is quoted; the message always goes LAST, so nothing after it can
 * be forged, and a cut one says so instead of stopping mid-word. The bounds
 * keep the whole reason under the 1000 characters the list accepts for a
 * refused change.
 */
const NAME_CHARS = 60;
const MESSAGE_CHARS = 400;
/** How much raw text is read at all, before any regex runs over it. */
const SCAN_CHARS = 2000;
const CONNECTIONS_FIX: WorkflowFix = { kind: 'connections', label: 'Open Connected workspace' };
const WORKFLOW_FIX: WorkflowFix = { kind: 'workflow', label: 'Open workflow' };

function shown(value: string, max: number): string {
  const s = forCard(value.slice(0, SCAN_CHARS), max);
  return value.length > SCAN_CHARS && !s.endsWith('...') ? `${s.slice(0, max - 3)}...` : s;
}
const quote = (name: string) => {
  const s = shown(name, NAME_CHARS).replace(/"/g, "'");
  return s ? `"${s}"` : 'a step without a name';
};
const plural = (n: number) => `${n} more thing${n === 1 ? '' : 's'}`;

/** A validator's own wording turned into a clause a founder can read, cut at a word with a note when long. */
function plainMessage(message: string): string {
  const raw = message.slice(0, SCAN_CHARS);
  const s = forCard(raw.replace(/\s+at\s+\/\S*/g, ''), Number.POSITIVE_INFINITY).replace(/[.\s]+$/, '');
  if (s.length <= MESSAGE_CHARS && raw.length === message.length) return s || 'it is not ready yet';
  const head = s.slice(0, MESSAGE_CHARS);
  const space = head.lastIndexOf(' ');
  const kept = (space > MESSAGE_CHARS / 2 ? head.slice(0, space) : head).replace(/[\s.,;:]+$/, '');
  return `${kept}... (shortened; the workflow shows the full detail)`;
}

/**
 * The first concrete thing standing between a workflow and being turned on,
 * said in plain words, with where to go to fix it. Readiness issues stay the
 * only source: this reads them and invents no check of its own. `stepName`
 * maps an issue's step to the name the person sees.
 */
export function explainBlocker(
  issues: readonly ReadinessIssue[],
  stepName: (node: string) => string,
  extra = 0,
): WorkflowBlocker {
  const first = issues[0];
  const more = issues.length - (first ? 1 : 0) + extra;
  const tail = more > 0 ? `, and ${plural(more)} to fix` : '';
  if (!first) {
    return { reason: `This workflow needs a change before it can be turned on${tail}.`, fix: WORKFLOW_FIX };
  }
  const step = quote(stepName(first.node));
  if (first.connect) {
    const app = shown(first.connect.app, NAME_CHARS);
    return { reason: `Connect ${app ? `a ${app} account` : 'an account'} for ${step} first${tail}.`, fix: CONNECTIONS_FIX };
  }
  if (first.code === 'SETUP_REQUIRED') {
    const label = /^(.+?): fill in this required input$/.exec(first.message.slice(0, SCAN_CHARS))?.[1];
    if (label) return { reason: `Fill in ${quote(label)} for ${step} first${tail}.`, fix: WORKFLOW_FIX };
  }
  return { reason: `Fix ${step} first${more > 0 ? ` (and ${plural(more)} after it)` : ''}: ${plainMessage(first.message)}.`, fix: WORKFLOW_FIX };
}

/** A workflow that runs code the person has not yet allowed. */
export function explainCodeSteps(stepNames: readonly string[], stepName: (node: string) => string, extra = 0): WorkflowBlocker {
  const more = stepNames.length - 1 + extra;
  const tail = more > 0 ? `, and ${plural(more)} to fix` : '';
  return { reason: `${quote(stepName(stepNames[0] ?? 'code'))} runs code and needs your permission first${tail}.`, fix: WORKFLOW_FIX };
}
