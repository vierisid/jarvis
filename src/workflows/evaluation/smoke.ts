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
export class SmokeProvider implements LLMProvider {
  name = 'harness-smoke';
  taskId = 'manual-literal';
  async chat(_messages: LLMMessage[], _options?: LLMOptions): Promise<LLMResponse> {
    const blocked = this.taskId === 'unsupported-fax';
    const flow = { displayName: this.taskId, trigger: smokeGraphs[this.taskId] };
    if (!blocked && !flow.trigger) throw new Error('Smoke provider cannot answer this task');
    if (!_options?.tools?.length && !blocked) return { content: JSON.stringify(flow), tool_calls: [], model: 'controlled-fixture',
      usage: { input_tokens: 0, output_tokens: 0 }, finish_reason: 'stop' };
    return { content: '', model: 'controlled-fixture', usage: { input_tokens: 0, output_tokens: 0 }, finish_reason: 'tool_use',
      tool_calls: [{ id: 'fixture', name: blocked ? 'report_blocked' : 'submit_flow',
        arguments: blocked ? { reason: 'Fax capability is not installed.' } : flow }] };
  }
  async *stream(): AsyncIterable<LLMStreamEvent> { throw new Error('Not supported'); }
  async listModels() { return ['controlled-fixture']; }
}
