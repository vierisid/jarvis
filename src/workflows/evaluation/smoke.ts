import { readFileSync } from 'node:fs';
import type { LLMMessage, LLMOptions, LLMProvider, LLMResponse, LLMStreamEvent } from '../../llm/provider';
/** Harness fixtures only. Never used for held-out runs or labelled model quality. */
const notify = (message: string) => ({ name: 'notify', type: 'PIECE',
  settings: { pieceName: 'jarvis-notify', actionName: 'notify', input: { message, channels: ['dashboard'] } } });
export const smokeGraphs: Record<string, any> = {
  'loop-copy': { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook', input: {} }, nextAction: {
    name: 'loop', type: 'LOOP_ON_ITEMS', settings: { items: '{{trigger.names}}' }, firstLoopAction: notify('{{loop.item}}'),
  } },
  'regex-replace': { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook', input: {} }, nextAction: {
    name: 'replace', type: 'PIECE', settings: { pieceName: 'jarvis-regex', actionName: 'replace', input: {
      text: '{{trigger.text}}', pattern: '_', replacement: ' ',
    } }, nextAction: notify('{{replace.result}}'),
  } },
  'clipboard-copy': { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'jarvis-trigger', triggerName: 'on_event',
    input: { eventType: 'observer.clipboard_changed' } }, nextAction: notify('{{trigger.payload.content}}') },
  'manual-literal': { name: 'trigger', type: 'EMPTY', nextAction: notify('Review pipeline') },
  'webhook-copy': { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook', input: {} },
    nextAction: notify('{{trigger.message}}') },
  'weekday-reminder': { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input: { cron_expression: '0 9 * * 1-5' } },
    nextAction: notify('Review overdue invoices') },
  'threshold': { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook', input: {} }, nextAction: {
    name: 'route', type: 'ROUTER', settings: { executionType: 'EXECUTE_FIRST_MATCH', branches: [
      { branchType: 'CONDITION', conditions: [[{ firstValue: '{{trigger.amount}}', operator: 'NUMBER_IS_GREATER_THAN', secondValue: '500' }]] },
      { branchType: 'FALLBACK' },
    ] }, children: [notify('Large invoice'), null],
  } },
  'summary': { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook', input: {} }, nextAction: {
    name: 'summary', type: 'PIECE', settings: { pieceName: 'jarvis-ask', actionName: 'ask', input: { prompt: 'Summarize: {{trigger.text}}' } },
    nextAction: notify('{{summary.text}}'),
  } },
};
/** Abstention tasks the controlled provider answers with report_blocked, and why. */
export const smokeBlocked: Record<string, string> = { 'unsupported-fax': 'Fax capability is not installed.' };
// Reference answers for later development sets, written beside their tasks:
// a graph, or the blocker an abstention task should report. Held-out answers
// are never stored here.
for (const file of ['founder-development-1.reference.json']) {
  const data = JSON.parse(readFileSync(new URL('./tasks/' + file, import.meta.url), 'utf8')) as
    { schemaVersion: 1; answers: Record<string, { graph?: unknown; blocked?: string }> };
  for (const [taskId, answer] of Object.entries(data.answers)) {
    if (answer.blocked) smokeBlocked[taskId] = answer.blocked; else smokeGraphs[taskId] = answer.graph;
  }
}
export type ReferenceAnswers = Record<string, { graph?: unknown; blocked?: string }>;
export class SmokeProvider implements LLMProvider {
  name = 'harness-smoke';
  taskId = 'manual-literal';
  /** Reference answers kept outside the repository (held-out sets), used only to prove their tasks are satisfiable. */
  constructor(private readonly references: ReferenceAnswers = {}) {}
  async chat(_messages: LLMMessage[], _options?: LLMOptions): Promise<LLMResponse> {
    const reference = this.references[this.taskId];
    const blocked = reference ? reference.blocked : smokeBlocked[this.taskId];
    const flow = { displayName: this.taskId, trigger: reference ? reference.graph : smokeGraphs[this.taskId] };
    if (!blocked && !flow.trigger) throw new Error('Smoke provider cannot answer this task');
    if (!_options?.tools?.length && !blocked) return { content: JSON.stringify(flow), tool_calls: [], model: 'controlled-fixture',
      usage: { input_tokens: 0, output_tokens: 0 }, finish_reason: 'stop' };
    return { content: '', model: 'controlled-fixture', usage: { input_tokens: 0, output_tokens: 0 }, finish_reason: 'tool_use',
      tool_calls: [{ id: 'fixture', name: blocked ? 'report_blocked' : 'submit_flow',
        arguments: blocked ? { reason: blocked } : flow }] };
  }
  async *stream(): AsyncIterable<LLMStreamEvent> { throw new Error('Not supported'); }
  async listModels() { return ['controlled-fixture']; }
}
