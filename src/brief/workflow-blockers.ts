import type { ReadinessIssue } from '../workflows/runtime/workflow-readiness';
import type { WorkflowFix } from './workflow-removal-contracts';

export interface WorkflowBlocker { reason: string; fix: WorkflowFix | null }

const STEP_CHARS = 60;
const CONNECTIONS_FIX: WorkflowFix = { kind: 'connections', label: 'Open Connected workspace' };
const WORKFLOW_FIX: WorkflowFix = { kind: 'workflow', label: 'Open workflow' };

const quote = (name: string) => `"${(name.length > STEP_CHARS ? `${name.slice(0, STEP_CHARS)}...` : name).replace(/"/g, "'")}"`;
const plural = (n: number) => `${n} more thing${n === 1 ? '' : 's'}`;

/** A validator's own wording turned into a clause a founder can read. */
function plainMessage(message: string): string {
  return message
    .replace(/\s+at\s+\/\S*/g, '')
    .replace(/[.\s]+$/, '')
    .trim();
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
    return { reason: `Connect a ${first.connect.app} account for ${step} first${tail}.`, fix: CONNECTIONS_FIX };
  }
  if (first.code === 'SETUP_REQUIRED') {
    const label = /^(.+?): fill in this required input$/.exec(first.message)?.[1];
    if (label) return { reason: `Fill in ${quote(label)} for ${step} first${tail}.`, fix: WORKFLOW_FIX };
  }
  return { reason: `Fix ${step} first: ${plainMessage(first.message)}${tail}.`, fix: WORKFLOW_FIX };
}

/** A workflow that runs code the person has not yet allowed. */
export function explainCodeSteps(stepNames: readonly string[], stepName: (node: string) => string, extra = 0): WorkflowBlocker {
  const more = stepNames.length - 1 + extra;
  const tail = more > 0 ? `, and ${plural(more)} to fix` : '';
  return { reason: `${quote(stepName(stepNames[0] ?? 'code'))} runs code and needs your permission first${tail}.`, fix: WORKFLOW_FIX };
}
