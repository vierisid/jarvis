import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { runStepTest } from './step-test';
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

const json = (body: unknown, status = 200) => Response.json(body, { status });
function fakeApi(run: Record<string, unknown>, calls: string[], start: Response = json({ id: 'run_1' }, 202)) {
  let polls = 0;
  return async (input: string) => {
    calls.push(input);
    if (input.endsWith('/run')) return start;
    polls++;
    return json(polls < 2 ? { id: 'run_1', status: 'RUNNING' } : run);
  };
}

test('a passing test saves unsaved edits first, then returns what the step returned', async () => {
  const calls: string[] = [];
  const result = await runStepTest({
    request: fakeApi({ id: 'run_1', status: 'SUCCEEDED', steps: { step_1: { output: { type: 'PIECE', status: 'SUCCEEDED', output: { echo: 'hello acme' } } } } }, calls) as any,
    flowId: 'f1', stepName: 'step_1', pollMs: 1,
    saveFirst: async () => { calls.push('save'); return { ok: true, message: 'Saved' }; },
  });
  expect(calls[0]).toBe('save');
  expect(calls[1]).toBe('/api/workflows/f1/run');
  expect(result).toMatchObject({ ok: true, message: 'Test passed.', test: { passed: true, output: { echo: 'hello acme' }, savedFirst: true } });
});

test('a failing step says why in words, and a failed save stops the test before it runs', async () => {
  const calls: string[] = [];
  const failed = await runStepTest({
    request: fakeApi({ id: 'run_1', status: 'FAILED', failedStep: { name: 'step_1', displayName: 'Echo', errorMessage: 'raw' },
      failure: { headline: 'The step could not finish.', outcome: 'Nothing was sent.' }, steps: {} }, calls) as any,
    flowId: 'f1', stepName: 'step_1', pollMs: 1, saveFirst: null,
  });
  expect(failed).toMatchObject({ ok: false, message: 'Test failed.', test: { passed: false, detail: 'The step could not finish. Nothing was sent.', savedFirst: false } });
  const notSaved = await runStepTest({ request: fakeApi({}, calls) as any, flowId: 'f1', stepName: 'step_1', saveFirst: async () => ({ ok: false, message: 'Reload first.' }) });
  expect(notSaved.message).toBe('Not tested: your changes could not be saved. Reload first.');
  expect(calls.filter(c => c.endsWith('/run'))).toHaveLength(1);
});

test('a refused test lists the readiness issues instead of a status code', async () => {
  const result = await runStepTest({
    request: (async () => json({ error: 'workflow_not_ready', issues: [{ message: 'Reference "step_1" is missing.' }, { message: 'Text: fill in this required input.' }] }, 422)) as any,
    flowId: 'f1', stepName: 'step_2', saveFirst: null,
  });
  expect(result).toEqual({ ok: false, message: 'Reference "step_1" is missing. Text: fill in this required input.' });
});

test('going offline says so and that the edits are still there', async () => {
  const result = await runStepTest({ request: (async () => { throw new TypeError('Failed to fetch'); }) as any, flowId: 'f1', stepName: 'step_1', saveFirst: null });
  expect(result.message).toBe('You are offline, so the test could not run. Your edits are still here.');
});

test('the Output panel keeps the pass or fail answer on screen next to the button', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const answers = [
    { ok: true, message: 'Test passed.', test: { passed: true, output: { echo: 'hello acme' }, savedFirst: true } },
    { ok: false, message: 'Test failed.', test: { passed: false, detail: 'The address was not found.', savedFirst: false } },
  ];
  await React.act(async () => root.render(<Environment.Provider value={{ request: fetch, portalHost: null, workspace: true, sampleDrafts: new Map() }}>
    <Sample stepName="step_1" sampleData={undefined} declaredSample={undefined} isLocked={false} isTriggerStep={false}
      onSetSampleData={async () => ({ ok: true, message: 'Sample data saved' })}
      onTestFromHere={async () => answers.shift()!} />
  </Environment.Provider>));
  try {
    const test = () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Test this step')!;
    await React.act(async () => test().click());
    await new Promise(r => setTimeout(r, 3500));
    expect(host.textContent).toContain('Test passed.');
    expect(host.textContent).toContain('Your changes were saved first.');
    expect(host.textContent).toContain('"echo": "hello acme"');
    await React.act(async () => test().click());
    expect(host.textContent).toContain('Test failed.');
    expect(host.textContent).toContain('The address was not found.');
    expect(host.textContent).not.toContain('hello acme');
  } finally { await React.act(async () => root.unmount()); host.remove(); }
});

test('a sample output filled in by a test shows in an untouched box, but never replaces typing', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const view = (sampleData: unknown) => (
    <Environment.Provider value={{ request: fetch, portalHost: null, workspace: true, sampleDrafts: new Map() }}>
      <Sample stepName="step_1" sampleData={sampleData} declaredSample={undefined} isLocked={false} isTriggerStep={false}
        onSetSampleData={async () => ({ ok: true, message: 'Sample data saved' })} onTestFromHere={async () => ({ ok: true, message: 'Test passed.' })} />
    </Environment.Provider>);
  await React.act(async () => root.render(view(undefined)));
  try {
    const box = () => host.querySelector('textarea')!;
    await React.act(async () => root.render(view({ echo: 'hi' })));
    expect(box().value).toContain('"echo": "hi"');
    expect(host.textContent).not.toContain('Unsaved edits');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await React.act(async () => { setter.call(box(), '{"mine": 1}'); box().dispatchEvent(new Event('input', { bubbles: true })); });
    await React.act(async () => root.render(view({ echo: 'newer' })));
    expect(box().value).toBe('{"mine": 1}');
  } finally { await React.act(async () => root.unmount()); host.remove(); }
});
