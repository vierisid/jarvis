import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { makeCanvasFixture } from '../../../brief/workflows/canvas/fixtures';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let Editor: typeof import('./WorkflowEditor').WorkflowEditor, Environment: typeof import('./WorkflowEditorEnvironment').WorkflowEditorEnvironment;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
beforeAll(async () => {
  GlobalRegistrator.register({ url: 'https://jarvis.test/' }); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react'); ({ createRoot } = await import('react-dom/client'));
  ({ WorkflowEditor: Editor } = await import('./WorkflowEditor')); ({ WorkflowEditorEnvironment: Environment } = await import('./WorkflowEditorEnvironment'));
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
const settle = (ms = 40) => React.act(async () => { await new Promise(r => setTimeout(r, ms)); });

async function openEditor() {
  const fixture = makeCanvasFixture(false); let closed = 0;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await React.act(async () => root.render(<Environment.Provider value={{ request: fixture.request, portalHost: null, workspace: false }}>
    <Editor flowId="meeting" onClose={() => { closed++; }} />
  </Environment.Provider>));
  await settle(100);
  return { closed: () => closed };
}
async function makeDirty() {
  await React.act(async () => (host.querySelector('.react-flow__node[data-id="notes"]') as HTMLElement).click());
  const field = document.querySelector('[aria-label="Step settings"] [contenteditable]') as HTMLElement;
  await React.act(async () => { field.textContent = 'unsaved words'; field.dispatchEvent(new Event('input', { bubbles: true })); });
}
const closeButton = () => host.querySelector('button[aria-label="Close editor"]') as HTMLButtonElement;

test('the X button asks before discarding unsaved edits, like Escape does', async () => {
  const asked: string[] = []; let answer = false;
  (window as any).confirm = (message: string) => { asked.push(message); return answer; };
  const editor = await openEditor();
  // Nothing unsaved: closes at once.
  await React.act(async () => closeButton().click()); await settle();
  expect(editor.closed()).toBe(1); expect(asked).toEqual([]);
  await makeDirty();
  await React.act(async () => closeButton().click()); await settle();
  expect(asked).toEqual(['Discard unsaved changes?']);
  expect(editor.closed()).toBe(1);
  answer = true;
  await React.act(async () => closeButton().click()); await settle();
  expect(editor.closed()).toBe(2);
});

test('closing or reloading the tab with unsaved edits asks the browser to confirm', async () => {
  await openEditor();
  const clean = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
  await makeDirty();
  const dirty = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(dirty);
  expect(dirty.defaultPrevented).toBe(true);
});
