import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act, createRoot: typeof import('react-dom/client').createRoot;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
beforeAll(async () => { ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client')); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());

test('a workflow row is not a button holding buttons: its name is the one button that selects it', async () => {
  const { FlowRow } = await import('./WorkflowsRoom');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const selected: string[] = [], noop = () => undefined;
  const flow = { id: 'f1', externalId: 'f1', projectId: 'p', status: 'ENABLED', publishedVersionId: null, metadata: null, displayName: 'Weekly report', updated: Date.now() } as any;
  await act(async () => root.render(<ul><FlowRow flow={flow} selected={false} onSelect={() => selected.push('f1')} onEdit={noop} onRun={noop} onToggle={noop} onPublish={noop} onDelete={noop} /></ul>));
  const row = host.querySelector('li')!;
  expect(row.getAttribute('role')).toBeNull();
  expect(row.querySelectorAll('[role="button"] button, button button').length).toBe(0);
  const name = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Weekly report')!;
  await act(async () => name.click());
  expect(selected).toEqual(['f1']);
  expect([...host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Edit').length).toBe(1);
});

test('the sample-input hint names this step\'s own fields, not a tool from another step', async () => {
  const { sampleInputPlaceholder } = await import('./WorkflowEditor');
  expect(sampleInputPlaceholder({ text: 'x', method: 'sha256', auth: '{{connections.a}}' })).toBe('{"text": "...", "method": "..."}');
  expect(sampleInputPlaceholder(undefined)).toBe('{"field": "value"}');
  expect(sampleInputPlaceholder({})).not.toContain('get_clipboard');
  // A field name is quoted as JSON, so the hint stays valid JSON for any name.
  const odd = sampleInputPlaceholder({ 'say "hi"': 1 });
  expect(odd).toBe('{"say \\"hi\\"": "..."}');
  expect(() => JSON.parse(odd)).not.toThrow();
});

test('a long step name wraps inside the confirm dialog', () => {
  const css = readFileSync(new URL('../../ui/ConfirmDialog.css', import.meta.url), 'utf8');
  expect(css).toMatch(/\.jconfirm__title\s*\{[^}]*overflow-wrap:\s*anywhere/);
  expect(css).toMatch(/\.jconfirm__body\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test('the manual trigger help does not expose the API path or template syntax', () => {
  const kinds = readFileSync(new URL('./trigger-kinds.ts', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('./WorkflowEditor.tsx', import.meta.url), 'utf8');
  expect(kinds).not.toContain('/api/workflows/:id/run');
  expect(editor).not.toContain('/api/workflows/:id/run');
  expect(editor).not.toContain('{`{{step_1.field}}`}');
  expect(editor).not.toContain('skip_missing_first_repeated skips');
  // Run sends no values and the variable picker never lists a manual trigger's
  // inputs, so the help must not promise that a field added there can be used.
  expect(editor).not.toContain('Add a field below for each value');
  expect(editor).toContain('isManual && inputEntries.length === 0 ? null');
});
