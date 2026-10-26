import React from 'react';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { artifactKey, nodeIds, savedResult } from './model';
import type { ResultModel } from './model';
import type { ResultAction, ResultCanvasProps, ResultViewProps } from './index';
import { EXAMPLES, example, modelFor } from './preview/fixtures';

test.each(EXAMPLES.map((_, i) => i))('accepts exact saved result for example %i', i => {
  const model = modelFor(example(i)); expect(savedResult(model)?.title).toBe(EXAMPLES[i]);
});
test('rejects foreign scope/job/request, replaced and enabled versions, and broken graph identities', () => {
  for (const patch of [{ scopeId: 'other' }, { journeyId: 'other' }, { jobId: 'other' }, { requestId: 'other' }, { flowId: 'other' }, { versionId: 'other' },
    { compositionRecordId: 'other' }, { activation: 'enabled' }, { versionState: 'LOCKED' }, { selectedNodeId: 'deleted' }, { graph: { name: 'trigger', type: 'EMPTY', nextAction: { name: 'trigger', type: 'EMPTY' } } }]) {
    const m = modelFor(); m.result = { ...example(), ...patch }; expect(savedResult(m)).toBeNull();
  }
});
test('retains exact long identities, missing inputs and runtime checks without claiming run readiness', () => {
  const r = example(), name = 'ai_' + 'x'.repeat(300);
  r.graph.name = name; r.selectedNodeId = name; r.readiness.ready = false; r.reference.readiness = 'needs_input';
  r.readiness.issues = [{ node: name, path: 'input.' + 'y'.repeat(300), code: 'INPUT_REQUIRED', message: 'Choose a recipient.' }];
  expect(savedResult(modelFor(r))?.readiness.issues).toEqual(r.readiness.issues);
  expect(nodeIds(r.graph)?.has(name)).toBe(true);
  expect(artifactKey(r)).not.toContain('content-1');
});
test('withholds malformed or unsynchronized completion descriptors', () => {
  for (const patch of [{ operation: 'run' }, { input: { journeyId: 'wrong' } }]) {
    const r = example(); r.continuation = { ...r.continuation!, ...patch } as never; expect(savedResult(modelFor(r))).toBeNull();
  }
  const r = example(); r.journey.sync = 'pending'; expect(savedResult(modelFor(r))).toBeNull();
  r.continuation = null; expect(savedResult(modelFor(r))).not.toBeNull();
});
let act: typeof React.act, createRoot: typeof import('react-dom/client').createRoot, View: typeof import('./index').ResultView;
let host: HTMLElement, root: ReturnType<typeof createRoot> | undefined, props: ResultViewProps, calls: ResultAction[], mounts = 0, canvasProps: ResultCanvasProps;
const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket;
const originalAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
beforeAll(async () => {
  GlobalRegistrator.register(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client')); ({ ResultView: View } = await import('./index'));
  globalThis.fetch = Object.assign(async () => { throw new Error('Unexpected network'); }, { preconnect: originalFetch.preconnect });
  globalThis.WebSocket = class { constructor() { throw new Error('Unexpected socket'); } } as never;
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); });
afterAll(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = originalAct; GlobalRegistrator.unregister(); });
function Canvas(p: ResultCanvasProps) {
  canvasProps = p; const [selected, select] = React.useState<string | null>(null);
  React.useEffect(() => { mounts++; p.onDirtyChange(false); }, []);
  return <div data-canvas-flow={p.draft.flowId}><button onClick={() => select('draft')}>Draft the follow-up</button>{selected && <label>Draft inspector<input defaultValue="Unfinished edit" /></label>}</div>;
}
async function mount(overrides: Partial<ResultViewProps> = {}) {
  calls = []; mounts = 0;
  const callback = (a: ResultAction) => { calls.push(a); };
  props = { model: modelFor(), Canvas, onContinue: callback, onRefresh: callback, onOpenWorkflow: callback, onBack: callback, ...overrides };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); await render();
}
async function render(patch: Partial<ResultModel> = {}) { props.model = { ...props.model, ...patch }; await act(async () => root!.render(<View {...props} />)); }
function button(text: string) { const b = [...host.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent === text); if (!b) throw new Error('Missing '+text); return b; }
async function click(text: string) { await act(async () => button(text).click()); }

test('mounting reveals only supplied graph, never creates/runs/enables/completes; review focuses canvas', async () => {
  await mount(); expect(calls).toEqual([]); expect(host.textContent).toContain('Draft · Not enabled');
  expect(host.querySelector('[data-canvas-flow]')?.getAttribute('data-canvas-flow')).toBe('flow-0');
  await click('Review the steps'); expect(host.textContent).toContain('Select a step');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Workflow canvas');
});
test('selected inspector and unfinished fields survive theme, read revision and layout rerenders', async () => {
  await mount(); await click('Draft the follow-up'); const input = host.querySelector('input')!; input.value = 'Unsaved notes'; input.focus();
  await render({ theme: 'dark' }); await render({ revision: 2 });
  expect(mounts).toBe(1); expect(host.querySelector('input')).toBe(input); expect(input.value).toBe('Unsaved notes'); expect(document.activeElement).toBe(input);
});
test('missing canvas is truthful and still supports exact draft navigation', async () => {
  await mount({ Canvas: undefined }); expect(host.textContent).toContain('Canvas unavailable'); expect(button('Review steps').disabled).toBe(true);
  await click('Open in Workflows'); expect(calls[0]?.draft?.workflow.selection).toEqual({ flowId: 'flow-0', versionId: 'version-0' });
});
test.each(['pending', 'no_draft', 'unavailable', 'deleted', 'stale'])('handles %s without showing a cached canvas', async state => {
  const m = modelFor(); m.result = state === 'unavailable' || state === 'deleted' ? { availability: 'unavailable', reason: 'artifact_unavailable' }
    : state === 'stale' ? { ...example(), versionId: 'different' } : { availability: 'ready', state };
  await mount({ model: m }); expect(host.querySelector('[data-canvas-flow]')).toBeNull(); expect(host.textContent).not.toContain('Continue to dashboard');
  await click('Check again'); expect(calls[0]?.action).toBe('refresh'); expect(calls[0]?.draft).toBeNull();
});
test('withdrawal cannot be undone by an older result; fresh same-version content is accepted', async () => {
  await mount(); await render({ revision: 3, result: { availability: 'unavailable' } });
  await render({ revision: 2, result: example() }); expect(host.querySelector('[data-canvas-flow]')).toBeNull();
  const r = example(); r.contentRevision = 'content-2'; await render({ revision: 4, result: r }); expect(canvasProps.draft.contentRevision).toBe('content-2');
});
test('renderer invalidation removes canvas and disables continuation until a fresh read', async () => {
  await mount(); await act(async () => canvasProps.onUnavailable()); expect(host.querySelector('[data-canvas-flow]')).toBeNull();
  expect(host.textContent).not.toContain('Continue to dashboard'); await render({ theme: 'dark' }); expect(host.querySelector('[data-canvas-flow]')).toBeNull();
  await render({ revision: 2 }); expect(host.querySelector('[data-canvas-flow]')).not.toBeNull();
});
test('recovered canvas retains selection, unsaved input, focus and dirty guards across later reads', async () => {
  await mount(); await act(async () => canvasProps.onUnavailable()); await render({ revision: 2 });
  await click('Draft the follow-up'); const input = host.querySelector('input')!; input.value = 'Unsaved after recovery'; input.focus();
  await act(async () => canvasProps.onDirtyChange(true));
  await render({ revision: 3 }); await render({ revision: 4, theme: 'dark' });
  expect(mounts).toBe(2); expect(host.querySelector('input')).toBe(input); expect(input.value).toBe('Unsaved after recovery'); expect(document.activeElement).toBe(input);
  for (const name of ['Continue to dashboard', 'Open in Workflows', 'Back to your request', 'Check again']) {
    expect(button(name).disabled).toBe(true); await click(name);
  }
  expect(calls).toEqual([]);
});
test('a late renderer invalidation cannot undo a newer revocation', async () => {
  await mount(); const oldUnavailable = canvasProps.onUnavailable;
  await render({ revision: 2 }); await act(async () => canvasProps.onUnavailable());
  expect(host.querySelector('[data-canvas-flow]')).toBeNull();
  await act(async () => oldUnavailable());
  expect(host.querySelector('[data-canvas-flow]')).toBeNull(); expect(host.textContent).not.toContain('Continue to dashboard');
  expect(mounts).toBe(1); expect(calls).toEqual([]);
  await render({ revision: 3 }); expect(host.querySelector('[data-canvas-flow]')).not.toBeNull(); expect(mounts).toBe(2);
});
test('stale renderer invalidations leave fresh edits and focus intact before and after recovery', async () => {
  await mount(); const oldUnavailable = canvasProps.onUnavailable;
  for (const revision of [2, 3]) {
    await render({ revision }); await click('Draft the follow-up');
    const input = host.querySelector('input')!; input.value = 'Still editing'; input.focus();
    await act(async () => canvasProps.onDirtyChange(true)); await act(async () => oldUnavailable());
    expect(host.querySelector('input')).toBe(input); expect(input.value).toBe('Still editing'); expect(document.activeElement).toBe(input);
    expect(button('Continue to dashboard').disabled).toBe(true);
    // The current renderer must still be able to withdraw the draft.
    await act(async () => canvasProps.onUnavailable()); expect(host.querySelector('[data-canvas-flow]')).toBeNull();
    expect(host.textContent).not.toContain('Continue to dashboard');
  }
  expect(mounts).toBe(2); expect(calls).toEqual([]);
});
test('a batched invalidation and fresh read reset the editor once', async () => {
  await mount(); await click('Draft the follow-up'); const input = host.querySelector('input')!;
  await act(async () => {
    canvasProps.onUnavailable(); props.model = { ...props.model, revision: 2 }; root!.render(<View {...props} />);
  });
  expect(mounts).toBe(2); expect(input.isConnected).toBe(false); expect(host.querySelector('[data-canvas-flow]')).not.toBeNull();
  await render({ revision: 3 }); expect(mounts).toBe(2);
});
test('dirty canvas guards all leaving/refresh actions until saved or discarded', async () => {
  await mount(); await act(async () => canvasProps.onDirtyChange(true));
  for (const name of ['Continue to dashboard', 'Open in Workflows', 'Back to your request', 'Check again']) { expect(button(name).disabled).toBe(true); await click(name); }
  expect(calls).toEqual([]); await act(async () => canvasProps.onDirtyChange(false)); await click('Continue to dashboard'); expect(calls.length).toBe(1);
});
test('finish carries exact server descriptor once and does not mark completion on delivery', async () => {
  await mount(); await act(async () => { button('Continue to dashboard').click(); button('Continue to dashboard').click(); });
  expect(calls.length).toBe(1); expect(calls[0]?.draft?.continuation).toEqual(example().continuation);
  expect(host.textContent).toContain('Preparing your goal plan'); await render({ theme: 'dark' }); expect(button('Continue to dashboard').disabled).toBe(true);
});
test('missing completion guard allows review but disables Continue', async () => {
  const r = example(); r.continuation = null; await mount({ model: modelFor(r) });
  expect(button('Continue to dashboard').disabled).toBe(true); await click('Review the steps'); expect(host.textContent).toContain('Select a step');
});
test('uncertain finish must reconcile; a late failure cannot poison a new read', async () => {
  let reject!: (e: Error) => void;
  await mount({ onContinue: a => { calls.push(a); return new Promise((_, r) => { reject = r; }); } });
  await click('Continue to dashboard'); await click('Check again'); expect(calls.map(x=>x.action)).toEqual(['finish','refresh']);
  await render({ revision: 2 }); await act(async () => reject(new Error('old account internals')));
  expect(host.textContent).not.toContain('could not confirm'); expect(button('Continue to dashboard').disabled).toBe(false);
});
test('rejected continuation does not expose raw errors or permit blind retry', async () => {
  await mount({ onContinue: () => Promise.reject(new Error('private detail')) }); await click('Continue to dashboard');
  expect(host.textContent).toContain('could not confirm'); expect(host.textContent).not.toContain('private detail');
  expect(button('Continue to dashboard').disabled).toBe(true); await click('Check again'); expect(calls[0]?.action).toBe('refresh');
});
test('scope change retires canvas and ignores stale callbacks', async () => {
  let reject!: (e: Error) => void;
  await mount({ onContinue: () => new Promise((_, r) => { reject = r; }) }); await click('Continue to dashboard');
  const r = example(); r.scopeId = 'new-scope'; await render({ ...modelFor(r), revision: 1 }); await act(async () => reject(new Error('old error')));
  expect(mounts).toBe(2); expect(host.textContent).not.toContain('could not confirm');
});
test('readiness details retain long labels and missing connections in the reveal', async () => {
  const r = example(); r.title = 'A long workflow title '.repeat(20); r.readiness.ready = false; r.reference.readiness = 'needs_input';
  r.missingBindings = [{ node: 'draft', path: 'settings.input.recipient', code: 'INPUT_REQUIRED', message: 'Choose a recipient.' }];
  await mount({ model: modelFor(r) }); expect(host.textContent).toContain('Needs your input'); expect(host.textContent).toContain('Choose a recipient.'); expect(host.querySelector('h1')?.textContent).toBe(r.title);
});
test('review opens even when the host acknowledges before its callback settles', async () => {
  let resolve!: () => void;
  await mount({ onReview: () => new Promise<void>(r => { resolve = r; }) });
  await click('Review the steps'); await render({ revision: 2 }); await act(async () => resolve());
  expect(host.textContent).toContain('Select a step'); expect(host.querySelector('aside')).toBeNull();
  await click('View draft summary'); expect(host.querySelector('aside')).not.toBeNull(); expect(mounts).toBe(1);
});
