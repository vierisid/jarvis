import { afterEach, beforeEach, expect, test } from 'bun:test';
import { compileWorkflow } from './workflow-readiness';
import { PieceCatalog } from './piece-catalog';
import { workflowToolRefusal } from './effect-capabilities';
import { formFields } from './human-input-contract';
import { initWorkflowDb, closeWorkflowDb } from '../db';
import { configureWorkflowReadiness, graphReadiness } from '../db/repos/flow-readiness';
import { createFlow } from '../db/repos/flow';
import type { ToolDefinition } from '../../actions/tools/registry';

const catalog = new PieceCatalog([
  { name: '@jarvispieces/piece-jarvis-tool', displayName: '', description: '', actions: { invoke: { name: 'invoke', displayName: '', description: '' } } },
  { name: '@jarvispieces/piece-jarvis-input', displayName: '', description: '', actions: { request_input: { name: 'request_input', displayName: '', description: '' } } },
]);
const tool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition =>
  ({ name, description: '', category: 'x', parameters: {}, execute: async () => null, ...extra }) as ToolDefinition;
const registry = new Map<string, ToolDefinition>([
  ['run_command', tool('run_command')],
  ['read_file', tool('read_file', { parameters: { path: { type: 'string', description: '', required: true } } as any })],
  ['run_skill', tool('run_skill', { authorityGate: (p: Record<string, unknown>) => p.name === 'known'
    ? { actionCategory: 'read_data', intent: 'x' } as any : null })],
]);
const lookup = (name: string) => {
  const t = registry.get(name);
  return t ? { params: [], unsupported: (params: Record<string, unknown> | null) => workflowToolRefusal(t, params) } : null;
};
const invoke = (toolName: string, params: unknown = {}): any => ({ name: 'trigger', type: 'EMPTY', nextAction: {
  name: 's', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-tool', actionName: 'invoke', input: { toolName, params } } } });
const ask = (fields: unknown): any => ({ name: 'trigger', type: 'EMPTY', nextAction: {
  name: 'ask', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-input', actionName: 'request_input',
    input: { title: 't', prompt: 'p', requestKey: 'k', fields } } } });

test('a tool step that can never run is refused with what is supported', () => {
  const result = compileWorkflow(invoke('run_command', { command: 'ls' }), { pieces: catalog, tool: lookup });
  expect(result.ready).toBe(false);
  const issue = result.issues.find(i => i.code === 'TOOL_UNSUPPORTED')!;
  expect(issue.path).toBe('settings.input.toolName');
  expect(issue.message).toContain('run_command');
  expect(issue.message).toContain('read_file');
  expect(issue.message).toContain('run_skill');
  expect(compileWorkflow(invoke('read_file', { path: '/tmp/a' }), { pieces: catalog, tool: lookup }).ready).toBe(true);
});

test('run_skill with an unknown skill is refused, a known one and a run-data one are not', () => {
  const ctx = { pieces: catalog, tool: lookup };
  const unknown = compileWorkflow(invoke('run_skill', { name: 'nope' }), ctx);
  expect(unknown.issues.some(i => i.code === 'TOOL_UNSUPPORTED' && i.message.includes('skill'))).toBe(true);
  expect(compileWorkflow(invoke('run_skill', { name: 'known' }), ctx).ready).toBe(true);
  expect(compileWorkflow(invoke('run_skill', { name: '{{trigger.skill}}' }), ctx).issues.some(i => i.code === 'TOOL_UNSUPPORTED')).toBe(false);
});

test('form fields in the natural shape are checked at readiness in plain words', () => {
  const ctx = { pieces: catalog };
  const missingKey = compileWorkflow(ask([{ label: 'Company', type: 'text', required: true }]), ctx);
  expect(missingKey.ready).toBe(false);
  expect(missingKey.issues[0]!.message).toBe('Form field 1 needs a key, a short name like company_size');
  const bad = compileWorkflow(ask([{ key: 'a b', label: 'A', type: 'text', required: true }]), ctx);
  expect(bad.issues[0]!.message).toContain('not allowed');
  const dup = compileWorkflow(ask([{ key: 'a', label: 'A', type: 'text', required: true }, { key: 'a', label: 'B', type: 'text', required: true }]), ctx);
  expect(dup.issues[0]!.message).toContain('repeats the key');
  expect(compileWorkflow(ask([{ key: 'a', label: 'A', type: 'text', required: true }]), ctx).ready).toBe(true);
  expect(compileWorkflow(ask(JSON.stringify([{ label: 'A', type: 'text', required: true }])), ctx).ready).toBe(false);
  // Text filled in by run data does not trip the check.
  expect(compileWorkflow(ask([{ key: 'a', label: '{{trigger.q}}', type: 'text', required: true }]), ctx).ready).toBe(true);
});

test('name is accepted for key and saved as key', () => {
  expect(formFields([{ name: 'company_size', label: 'Size', type: 'text', required: true }]))
    .toEqual([{ key: 'company_size', label: 'Size', type: 'text', required: true }]);
});

test('a file tool step warns when no computer is online, and stays publishable', () => {
  const online = { value: false };
  const ctx = { pieces: catalog, tool: lookup, computerOnline: () => online.value };
  const result = compileWorkflow(invoke('read_file', { path: '/tmp/a' }), ctx);
  expect(result.ready).toBe(true);
  expect(result.runtimeChecks.find(c => c.guard === 'computer')?.message).toContain('desktop app');
  online.value = true;
  expect(compileWorkflow(invoke('read_file', { path: '/tmp/a' }), ctx).runtimeChecks.some(c => c.guard === 'computer')).toBe(false);
  // Not a computer tool: no warning.
  online.value = false;
  expect(compileWorkflow(invoke('run_skill', { name: 'known' }), ctx).runtimeChecks.some(c => c.guard === 'computer')).toBe(false);
});

beforeEach(() => initWorkflowDb(':memory:'));
afterEach(() => closeWorkflowDb());
test('the live readiness context reports whether an enrolled computer is online', () => {
  const machines: any[] = [{ id: 'a', name: 'Desk', connected: false }];
  configureWorkflowReadiness({ pieces: catalog, tool: lookup, machines: () => machines, localTools: () => true });
  const flow = createFlow({});
  const warns = () => graphReadiness(flow.id, invoke('read_file', { path: '/tmp/a' })).runtimeChecks.some(c => c.guard === 'computer');
  expect(warns()).toBe(true);
  machines[0].connected = true;
  expect(warns()).toBe(false);
});
