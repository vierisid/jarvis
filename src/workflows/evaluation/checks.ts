import type { FlowTriggerNode } from '../db/repos/flow-version';
import type { ComposeResult } from '../../actions/tools/workflow-composer';
import { fingerprint } from '../../actions/tools/composition-provenance';
import { canonicalToolParams, environmentFor, type EvaluationEnvironment } from './environment';
import type { EffectReceipt, ExternalStepExpectation, QualityTask, Scenario, ScenarioResult, ToolCallExpectation } from './types';

const JARVIS = '@jarvispieces/piece-jarvis-';
/** Actions each Jarvis piece may run here; jarvis-trigger only starts flows. */
const JARVIS_ACTIONS: Record<string, readonly string[]> = {
  notify: ['notify'], regex: ['extract', 'match', 'replace'], ask: ['ask'], tool: ['invoke'], agent: ['delegate'],
  context: ['vault_search', 'vault_get_entity', 'awareness_recent', 'commitments_list'],
};
const CONNECTION = /^\{\{\s*connections(?:\.([A-Za-z0-9_-]+)|\[\s*(['"])([^'"]+)\2\s*\])\s*\}\}$/;
/** The connection a complete `{{connections.id}}` or `{{connections['id']}}` binding names. */
export function connectionOf(auth: unknown): string | null {
  const match = typeof auth === 'string' ? auth.match(CONNECTION) : null;
  return match ? (match[1] ?? match[3]!) : null;
}
export interface GraphStep { piece: string; action: string; input: Record<string, any> }

/** The executor only admits pieces the environment installs. It never loads
 * model-selected packages or CODE, and connection-bound steps never run. */
export function inspectGraph(trigger: FlowTriggerNode, environment: EvaluationEnvironment = environmentFor('w8')) {
  const issues: string[] = [], steps: GraphStep[] = [], external: GraphStep[] = [];
  const jarvis = new Map(environment.jarvisPieces.filter(n => JARVIS_ACTIONS[n]).map(n => [JARVIS + n, JARVIS_ACTIONS[n]!]));
  const outside = new Map(environment.external.map(e => [e.name, Object.keys(e.actions)]));
  const tools = new Set(environment.tools.map(t => t.name));
  let aiSteps = 0;
  const queue: Array<{ node: any; root: boolean }> = [{ node: trigger, root: true }];
  const seen = new Set<object>();
  while (queue.length) {
    const { node, root } = queue.shift()!;
    if (!node || typeof node !== 'object' || seen.has(node) || seen.size >= 100) {
      issues.push('Invalid, cyclic or oversized graph'); break;
    }
    seen.add(node);
    if (root) {
      if (node.type !== 'EMPTY' && !(node.type === 'PIECE_TRIGGER'
        && ['schedule', 'webhook', '@jarvispieces/piece-jarvis-trigger'].includes(node.settings?.pieceName))) {
        issues.push('Unsupported evaluation trigger');
      }
    } else if (node.type === 'PIECE') {
      const step: GraphStep = { piece: node.settings?.pieceName, action: node.settings?.actionName, input: node.settings?.input ?? {} };
      if (jarvis.get(step.piece)?.includes(step.action)) {
        steps.push(step);
        if (step.piece === JARVIS + 'ask' || step.piece === JARVIS + 'agent') aiSteps++;
        if (step.input.auth !== undefined) issues.push('Credentials are outside the evaluation envelope');
        if (step.piece === JARVIS + 'tool' && !(typeof step.input.toolName === 'string' && tools.has(step.input.toolName)))
          issues.push('Tool is not available to workflows here');
      } else if (outside.get(step.piece)?.includes(step.action)) {
        steps.push(step); external.push(step);
        if (!connectionOf(step.input.auth)) issues.push('External step without a complete connection binding');
      } else issues.push('Unsupported evaluation action');
    } else if (!['ROUTER', 'LOOP_ON_ITEMS'].includes(node.type)) issues.push('Unsupported evaluation node');
    if (node.nextAction) queue.push({ node: node.nextAction, root: false });
    if (node.firstLoopAction) queue.push({ node: node.firstLoopAction, root: false });
    if (node.children !== undefined && !Array.isArray(node.children)) issues.push('Invalid branch children');
    else for (const child of node.children ?? []) if (child) queue.push({ node: child, root: false });
  }
  return { issues, aiSteps, steps, external };
}

function respectsForbidden(steps: GraphStep[], forbidden: NonNullable<QualityTask['expectation']['forbidden']>): boolean {
  return steps.every(s => !(forbidden.pieces ?? []).includes(s.piece)
    && !(forbidden.actions ?? []).includes(s.piece + ':' + s.action)
    && !(s.piece === JARVIS + 'tool' && (forbidden.tools ?? []).includes(s.input.toolName))
    && !(forbidden.agents && s.piece === JARVIS + 'agent')
    && !(s.piece === JARVIS + 'notify' && Array.isArray(s.input.channels) && s.input.channels.some((c: unknown) => (forbidden.channels ?? []).includes(c as string))));
}

/** Each expected external step must appear once with its action, connection and
 * literal inputs; any external step beyond them is an unexpected effect. */
function externalChecks(expected: ExternalStepExpectation[], actual: GraphStep[]) {
  const remaining = [...actual];
  const checks = expected.map(e => {
    const index = remaining.findIndex(s => s.piece === e.piece && s.action === e.action && connectionOf(s.input.auth) === e.connection
      && Object.entries(e.input).every(([key, value]) => fingerprint(s.input[key]) === fingerprint(value)));
    if (index >= 0) remaining.splice(index, 1);
    return { name: 'external ' + e.piece.replace('@activepieces/piece-', '') + ':' + e.action + ' on ' + e.connection, pass: index >= 0 };
  });
  return [...checks, { name: 'no unexpected external steps', pass: remaining.length === 0 }];
}

export function staticChecks(task: QualityTask, result: ComposeResult | null, reportedBlocked: boolean,
  environment: EvaluationEnvironment = environmentFor('w8')) {
  if (task.expectation.blocked) return { aiSteps: null, checks: [
    { name: 'explicit abstention (not a provider/validation failure)', pass: result?.ok === false && reportedBlocked && !result.errorCode },
  ] };
  if (!result?.ok) return { aiSteps: null, checks: [{ name: 'composition returned a graph', pass: false }] };
  const trigger = result.flow.trigger, expected = task.expectation.trigger;
  const kind = trigger.type === 'EMPTY' ? 'manual' : trigger.settings?.pieceName === 'schedule' ? 'schedule'
    : trigger.settings?.pieceName === 'webhook' ? 'webhook' : trigger.settings?.pieceName === '@jarvispieces/piece-jarvis-trigger' ? 'event' : 'unknown';
  const inspection = inspectGraph(trigger, environment);
  const graphOnly = (task.expectation.external ?? []).length > 0;
  const checks = [
    { name: 'supported execution envelope', pass: inspection.issues.length === 0 && (graphOnly || inspection.external.length === 0) },
    { name: 'trigger kind', pass: kind === expected.kind },
    { name: 'AI steps within task allowance', pass: inspection.aiSteps <= task.expectation.maxAiSteps },
  ];
  if (expected.cron) checks.push({ name: 'requested cron encoding', pass:
    String((trigger.settings?.input as any)?.cron_expression ?? '').trim().replace(/\s+/g, ' ') === expected.cron });
  if (expected.eventType) checks.push({ name: 'event type', pass:
    (trigger.settings?.input as any)?.eventType === expected.eventType });
  if (task.expectation.forbidden) checks.push({ name: 'no forbidden pieces, actions, tools, channels or agents',
    pass: respectsForbidden(inspection.steps, task.expectation.forbidden) });
  if (graphOnly) checks.push(...externalChecks(task.expectation.external!, inspection.external));
  return { aiSteps: inspection.aiSteps, checks };
}

function sameToolCalls(expected: ToolCallExpectation[], receipts: EffectReceipt[]): boolean {
  const call = (toolName: unknown, params: Record<string, unknown>, outcome: unknown) =>
    fingerprint({ toolName, outcome, params: canonicalToolParams(params) });
  const actual = receipts.map(r => call(r.input.toolName, (r.input.params ?? {}) as Record<string, unknown>, r.outcome)).sort();
  const wanted = expected.map(e => call(e.toolName, e.params, e.outcome ?? 'succeeded')).sort();
  return JSON.stringify(actual) === JSON.stringify(wanted);
}

export function checkScenario(scenario: Scenario, status: string, receipts: EffectReceipt[]) {
  const notifications = receipts.filter(r => r.kind === 'notification').map(r => ({
    message: r.input.message, channels: Array.isArray(r.input.channels) ? [...r.input.channels].sort() : null,
  }));
  const canonical = (items: unknown[]) => items.map(fingerprint).sort();
  const ai = receipts.filter(r => r.kind === 'ai'), expectedStatus = scenario.status ?? 'SUCCEEDED';
  const prompt = String(ai[0]?.input.prompt ?? '');
  const checks = [
    { name: expectedStatus === 'SUCCEEDED' ? 'run succeeded' : 'run ended ' + expectedStatus, pass: status === expectedStatus },
    { name: 'exact simulated effects, destinations and multiplicity', pass: JSON.stringify(canonical(notifications))
      === JSON.stringify(canonical(scenario.notifications.map(n => ({ ...n, channels: [...n.channels].sort() })))) },
    { name: 'AI input wiring', pass: scenario.ai
      ? ai.length === 1 && scenario.ai.promptIncludes.every(text => prompt.includes(text))
        && (scenario.ai.promptExcludes ?? []).every(text => !prompt.includes(text))
      : ai.length === 0 },
  ];
  // Tool and agent checks appear when either side involves them, so W8 scenarios keep their three checks.
  const tools = receipts.filter(r => r.kind === 'tool'), agents = receipts.filter(r => r.kind === 'agent').length;
  if (scenario.tools || tools.length) checks.push({ name: 'exact tool calls, parameters and outcomes', pass: sameToolCalls(scenario.tools ?? [], tools) });
  if (scenario.agents !== undefined || agents) checks.push({ name: 'agent delegations', pass: agents === (scenario.agents ?? 0) });
  return checks;
}
/** A graph-only task passes on its static checks; every other task also needs every scenario to pass. */
export function passed(staticResult: { pass: boolean }[], scenarios: ScenarioResult[], task: QualityTask) {
  const graphOnly = (task.expectation.external ?? []).length > 0;
  return staticResult.length > 0 && staticResult.every(c => c.pass)
    && (task.expectation.blocked || graphOnly ? scenarios.length === 0
      : scenarios.length === task.scenarios.length && scenarios.length > 0
        && scenarios.every(s => s.checks.length > 0 && s.checks.every(c => c.pass)));
}
