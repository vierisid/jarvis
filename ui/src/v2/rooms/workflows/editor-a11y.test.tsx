import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act, createRoot: typeof import('react-dom/client').createRoot;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
beforeAll(async () => { ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client')); });
afterEach(async () => { if (!root) return; await act(async () => root.unmount()); host.remove(); (root as any) = undefined; });
afterAll(() => GlobalRegistrator.unregister());
const mount = async (node: React.ReactElement) => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); };

test('canvas nodes are named by their title and kind', async () => {
  const { nodeAccessibleName } = await import('./WorkflowEditor');
  const step = (patch: object) => ({ name: 'step_1', type: 'PIECE', ...patch }) as any;
  expect(nodeAccessibleName(step({ displayName: 'Draft the follow-up', settings: { pieceName: 'p', actionName: 'a' } }))).toBe('Draft the follow-up, step');
  expect(nodeAccessibleName(step({ displayName: 'New step', settings: { input: {} } }))).toBe('New step, step, not set up yet');
  expect(nodeAccessibleName(step({ type: 'ROUTER', displayName: 'Check', settings: { routerKind: 'if' } }))).toBe('Check, if');
  expect(nodeAccessibleName(step({ type: 'EMPTY', displayName: 'Manual' }))).toBe('Manual, manual trigger');
  expect(nodeAccessibleName(step({ type: 'LOOP_ON_ITEMS', name: 'step_2' }))).toBe('step_2, loop');
});

test('each branch names its own condition fields, so two branches do not repeat the same labels', async () => {
  const { BranchConditionsEditor } = await import('./WorkflowEditor');
  const condition = [[{ firstValue: '', operator: 'TEXT_EXACTLY_MATCHES', secondValue: '' }]] as any;
  await mount(<><BranchConditionsEditor branchName="Paid" conditions={condition} onChange={() => {}} /><BranchConditionsEditor branchName="Free" conditions={condition} onChange={() => {}} /></>);
  const names = [...host.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'));
  expect(names).toContain('Paid, condition 1: value');
  expect(names).toContain('Free, condition 1: operator');
  expect(names).toContain('Remove Free, condition 1');
  expect(new Set(names).size).toBe(names.length);
});

test('a radio group is not inside a label and carries its own name', async () => {
  const { RadioGroupField } = await import('./WorkflowEditor');
  await mount(<RadioGroupField label="Execution mode"><button type="button" role="radio" aria-checked="true">First match</button></RadioGroupField>);
  const group = host.querySelector('[role="radiogroup"]')!;
  expect(group.getAttribute('aria-label')).toBe('Execution mode');
  expect(group.closest('label')).toBeNull();
  expect(host.querySelector('label')).toBeNull();
});

test('the leave-page notice is a live region that is always mounted', () => {
  const root = readFileSync(new URL('../../../brief/host/DashboardRoot.tsx', import.meta.url), 'utf8');
  expect(root).toMatch(/<p className="brief-host-notice" role="alert">\{message\}<\/p>/);
});

test('at phone width the settings are a bottom sheet and the zoom buttons stack at the edge', () => {
  const css = readFileSync(new URL('../../../brief/workflows/canvas/canvas.css', import.meta.url), 'utf8');
  const phone = css.slice(css.indexOf('@container brief-work (max-width: 650px)'));
  expect(phone).toMatch(/\.wf-popover--inline\s*\{[^}]*position:\s*fixed[^}]*bottom:\s*0/);
  expect(phone).toMatch(/\.react-flow__controls\s*\{[^}]*flex-direction:\s*column/);
});
