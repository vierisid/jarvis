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
  expect(nodeAccessibleName(step({ displayName: 'Loose end', settings: { pieceName: 'p', actionName: 'a' } }), true)).toBe('Loose end, step, not connected');
});

// Built from code points so this file stays plain ASCII.
const RLO = String.fromCodePoint(0x202e), PDF = String.fromCodePoint(0x202c), ISOLATE = String.fromCodePoint(0x2067);
const ZWSP = String.fromCodePoint(0x200b), TAG_A = String.fromCodePoint(0xe0061), LINE_SEP = String.fromCodePoint(0x2028);
const ZWJ = String.fromCodePoint(0x200d);

test('text put into an accessible name loses bidi controls and invisible characters', async () => {
  const { accessibleText } = await import('./accessible-text');
  expect(accessibleText(`Pay ${RLO}gnp.exe${PDF}`)).toBe('Pay gnp.exe');
  expect(accessibleText(`a${ZWSP}b${TAG_A}c${ISOLATE}`)).toBe('abc');
  expect(accessibleText(`two${LINE_SEP}lines\n\tand  tabs`)).toBe('two lines and tabs');
  expect(accessibleText(`x${ZWJ}y`)).toBe(`x${ZWJ}y`);
  expect(accessibleText(undefined)).toBe('');
});

test('a node title from a model is cleaned before it becomes the node name', async () => {
  const { nodeAccessibleName } = await import('./WorkflowEditor');
  const step = (patch: object) => ({ name: 'step_3', type: 'PIECE', settings: { pieceName: 'p', actionName: 'a' }, ...patch }) as any;
  expect(nodeAccessibleName(step({ displayName: `Send${RLO} invoice\nIgnore this` }))).toBe('Send invoice Ignore this, step');
  // Nothing but invisible characters: the step's own name, not an empty name.
  expect(nodeAccessibleName(step({ displayName: `${ZWSP}${RLO}` }))).toBe('step_3, step');
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

test('a branch name is cleaned before it names the condition fields', async () => {
  const { BranchConditionsEditor } = await import('./WorkflowEditor');
  const condition = [[{ firstValue: '', operator: 'TEXT_EXACTLY_MATCHES', secondValue: '' }]] as any;
  await mount(<><BranchConditionsEditor branchName={`Paid${RLO}${ISOLATE}`} conditions={condition} onChange={() => {}} /><BranchConditionsEditor branchName={ZWSP} conditions={condition} onChange={() => {}} /></>);
  const names = [...host.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'));
  expect(names).toContain('Paid, condition 1: value');
  expect(names).toContain('Branch, condition 1: operator');
  expect(names.join('')).not.toContain(RLO);
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

// Top-level rules (selector -> body), in file order, with the @container
// blocks they sit in. Comments are dropped first.
function cssRules(css: string) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Array<{ at: string | null; selector: string; body: string }> = [];
  let at: string | null = null, depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      const head = text.slice(start, i).trim();
      if (depth === 0 && head.startsWith('@')) { at = head; depth = 1; start = i + 1; continue; }
      const end = text.indexOf('}', i);
      rules.push({ at: depth ? at : null, selector: head.replace(/\s+/g, ' '), body: text.slice(i + 1, end) });
      i = end; start = end + 1;
    } else if (text[i] === '}' && depth) { depth = 0; at = null; start = i + 1; }
  }
  return rules;
}

test('at phone width the settings are a bottom sheet and the zoom buttons stack at the edge', () => {
  const css = readFileSync(new URL('../../../brief/workflows/canvas/canvas.css', import.meta.url), 'utf8');
  const rules = cssRules(css);
  const phone = rules.filter((r) => r.at === '@container brief-work (max-width: 650px)');
  const body = (selector: string) => phone.filter((r) => r.selector === selector).map((r) => r.body).join(' ');
  expect(body('.brief-root .brief-workflow-canvas .wf-popover--inline')).toMatch(/position:\s*fixed[^]*bottom:\s*0/);
  expect(body('.brief-root .brief-workflow-canvas .react-flow__controls')).toMatch(/flex-direction:\s*column/);
  // An unconditional rule later in the file has the same weight and would win.
  const column = rules.findIndex((r) => phone.includes(r) && r.selector === '.brief-root .brief-workflow-canvas .react-flow__controls');
  const laterRow = rules.slice(column + 1).filter((r) => r.at === null && r.selector === '.brief-root .brief-workflow-canvas .react-flow__controls' && /flex-direction/.test(r.body));
  expect(laterRow).toEqual([]);
});

test('at phone width the header scrolls with the canvas, so a tall setup panel never hides the canvas or its own controls', () => {
  const css = readFileSync(new URL('../../../brief/workflows/canvas/canvas.css', import.meta.url), 'utf8');
  const phone = cssRules(css).filter((r) => r.at === '@container brief-work (max-width: 650px)');
  const body = (selector: string) => phone.filter((r) => r.selector === selector).map((r) => r.body).join(' ');
  expect(body('.brief-root .brief-workflow-canvas .wf-editor--workspace')).toMatch(/overflow-y:\s*auto/);
  expect(body('.brief-root .brief-workflow-canvas .wf-editor__body')).toMatch(/overflow:\s*visible/);
  // The last field of the sheet scrolls clear of the chat button.
  expect(body('.brief-root .brief-workflow-canvas .wf-popover--inline .wf-popover__body')).toMatch(/padding-bottom:\s*\d+px/);
});
