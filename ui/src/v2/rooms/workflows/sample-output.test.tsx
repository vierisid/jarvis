import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let Sample: typeof import('./WorkflowEditor').SampleDataSection;
let Environment: typeof import('./WorkflowEditorEnvironment').WorkflowEditorEnvironment;
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react'); ({ createRoot } = await import('react-dom/client'));
  ({ SampleDataSection: Sample } = await import('./WorkflowEditor'));
  ({ WorkflowEditorEnvironment: Environment } = await import('./WorkflowEditorEnvironment'));
});
afterAll(() => GlobalRegistrator.unregister());
test('published rich text fields are readable but cannot type, paste, drop or open a variable picker', async () => {
  const { VariableChipField, WorkflowReadOnlyContext } = await import('./WorkflowEditor');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host), changes: string[] = [];
  await React.act(async () => root.render(<WorkflowReadOnlyContext.Provider value={true}>
    <VariableChipField value="Keep {{trigger.text}}" onChange={value => changes.push(value)} />
  </WorkflowReadOnlyContext.Provider>));
  try {
    const field = host.querySelector<HTMLElement>('[role="textbox"]')!;
    expect(field.contentEditable).toBe('false'); expect(field.getAttribute('aria-readonly')).toBe('true');
    expect(field.textContent).toContain('Keep');
    await React.act(async () => {
      field.focus();
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('paste', { bubbles: true }));
      field.dispatchEvent(new Event('drop', { bubbles: true }));
    });
    expect(changes).toHaveLength(0);
  } finally { await React.act(async () => root.unmount()); host.remove(); }
});
test('first invalid JSON save does not clear the previous sample or acknowledge it', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host), writes: unknown[] = [];
  await React.act(async () => root.render(<Environment.Provider value={{ request: fetch, portalHost: null, workspace: true, sampleDrafts: new Map([['output:step_1','not json']]) }}>
    <Sample stepName="step_1" sampleData={{ preserved: true }} declaredSample={undefined} isLocked={false} isTriggerStep={false}
      onSetSampleData={async value => { writes.push(value); return { ok: true, message: 'Sample data saved' }; }}
      onTestFromHere={async () => ({ ok: true, message: 'queued' })} />
  </Environment.Provider>));
  try {
    expect(host.querySelector('textarea')?.value).toBe('not json');
    await React.act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Save sample')!.click());
    expect(writes).toHaveLength(0);
    expect(host.textContent).not.toContain('Sample data saved');
    expect(host.textContent).toContain('Unsaved edits');
  } finally { await React.act(async () => root.unmount()); host.remove(); }
});
