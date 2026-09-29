import type { FlowTriggerNode } from '../db/repos/flow-version';
import type { ComposeResult } from '../../actions/tools/workflow-composer';
import { fingerprint } from '../../actions/tools/composition-provenance';
import type { EffectReceipt, QualityTask, Scenario, ScenarioResult } from './types';

const pieces: Record<string, readonly string[]> = {
  '@jarvispieces/piece-jarvis-notify': ['notify'],
  '@jarvispieces/piece-jarvis-regex': ['extract', 'match', 'replace'],
  '@jarvispieces/piece-jarvis-ask': ['ask'],
};
/** The executor only admits known local pieces. It never loads model-selected packages or CODE. */
export function inspectGraph(trigger: FlowTriggerNode): { issues: string[]; aiSteps: number } {
  const issues: string[] = [];
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
      if (!pieces[node.settings?.pieceName]?.includes(node.settings?.actionName)) issues.push('Unsupported evaluation action');
      if (node.settings?.pieceName === '@jarvispieces/piece-jarvis-ask') aiSteps++;
      if (node.settings?.input?.auth !== undefined) issues.push('Credentials are outside the evaluation envelope');
    } else if (!['ROUTER', 'LOOP_ON_ITEMS'].includes(node.type)) issues.push('Unsupported evaluation node');
    if (node.nextAction) queue.push({ node: node.nextAction, root: false });
    if (node.firstLoopAction) queue.push({ node: node.firstLoopAction, root: false });
    if (node.children !== undefined && !Array.isArray(node.children)) issues.push('Invalid branch children');
    else for (const child of node.children ?? []) if (child) queue.push({ node: child, root: false });
  }
  return { issues, aiSteps };
}
export function staticChecks(task: QualityTask, result: ComposeResult | null, reportedBlocked: boolean) {
  if (task.expectation.blocked) return { aiSteps: null, checks: [
    { name: 'explicit abstention (not a provider/validation failure)', pass: result?.ok === false && reportedBlocked && !result.errorCode },
  ] };
  if (!result?.ok) return { aiSteps: null, checks: [{ name: 'composition returned a graph', pass: false }] };
  const trigger = result.flow.trigger, expected = task.expectation.trigger;
  const kind = trigger.type === 'EMPTY' ? 'manual' : trigger.settings?.pieceName === 'schedule' ? 'schedule'
    : trigger.settings?.pieceName === 'webhook' ? 'webhook' : trigger.settings?.pieceName === '@jarvispieces/piece-jarvis-trigger' ? 'event' : 'unknown';
  const inspection = inspectGraph(trigger);
  const checks = [
    { name: 'supported execution envelope', pass: inspection.issues.length === 0 },
    { name: 'trigger kind', pass: kind === expected.kind },
    { name: 'AI steps within task allowance', pass: inspection.aiSteps <= task.expectation.maxAiSteps },
  ];
  if (expected.cron) checks.push({ name: 'requested cron encoding', pass:
    String((trigger.settings?.input as any)?.cron_expression ?? '').trim().replace(/\s+/g, ' ') === expected.cron });
  if (expected.eventType) checks.push({ name: 'event type', pass:
    (trigger.settings?.input as any)?.eventType === expected.eventType });
  return { aiSteps: inspection.aiSteps, checks };
}
export function checkScenario(scenario: Scenario, status: string, receipts: EffectReceipt[]) {
  const notifications = receipts.filter(r => r.kind === 'notification').map(r => ({
    message: r.input.message, channels: Array.isArray(r.input.channels) ? [...r.input.channels].sort() : null,
  }));
  const canonical = (items: unknown[]) => items.map(fingerprint).sort();
  const ai = receipts.filter(r => r.kind === 'ai');
  return [
    { name: 'run succeeded', pass: status === 'SUCCEEDED' },
    { name: 'exact simulated effects, destinations and multiplicity', pass: JSON.stringify(canonical(notifications))
      === JSON.stringify(canonical(scenario.notifications.map(n => ({ ...n, channels: [...n.channels].sort() })))) },
    { name: 'AI input wiring', pass: scenario.ai
      ? ai.length === 1 && scenario.ai.promptIncludes.every(text => String(ai[0]!.input.prompt).includes(text))
      : ai.length === 0 },
  ];
}
export function passed(staticResult: { pass: boolean }[], scenarios: ScenarioResult[], task: QualityTask) {
  return staticResult.length > 0 && staticResult.every(c => c.pass)
    && (task.expectation.blocked ? scenarios.length === 0
      : scenarios.length === task.scenarios.length && scenarios.length > 0
        && scenarios.every(s => s.checks.length > 0 && s.checks.every(c => c.pass)));
}
