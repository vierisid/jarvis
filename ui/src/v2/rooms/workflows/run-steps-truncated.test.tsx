// A run whose steps the API outlined (#1366) says so in the Runs tab instead of looking like its whole output.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
const originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(() => GlobalRegistrator.unregister());

type Flow = import('./useWorkflowsData').Flow;
type FlowRun = import('./useWorkflowsData').FlowRun;
const flow: Flow = { id: 'flow-1', externalId: 'x', projectId: 'p', status: 'DISABLED', publishedVersionId: null,
  metadata: null, codeSteps: { enabled: false, grantedBy: null, grantedAt: null }, created: 1, updated: 1, displayName: 'Big loop' };
const run = (stepsTruncated?: boolean): FlowRun => ({ id: 'run-1', flowId: 'flow-1', flowVersionId: 'v1', status: 'SUCCEEDED', environment: 'PRODUCTION',
  startTime: 1, finishTime: 2, stepsCount: 2, steps: { loop: { type: 'LOOP_ON_ITEMS', status: 'SUCCEEDED' } }, failedStep: null,
  triggeredBy: null, created: 1, updated: 2, ...(stepsTruncated ? { stepsTruncated } : {}) });

async function render(r: FlowRun): Promise<string> {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { FlowDetail } = await import('./WorkflowsRoom');
  globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => root.render(<FlowDetail flow={flow} runs={[r]} focusRunId="run-1" onRefreshRuns={() => {}}
      onCancelRun={() => {}} onPermissionsChanged={() => {}} onClose={() => {}} />));
    return host.querySelector('.wf-runs__steps')?.textContent ?? '';
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}

test('an outlined run says its steps were shortened to their type and status', async () => {
  const text = await render(run(true));
  expect(text).toContain('Step status JSON (shortened)');
  expect(text).toContain('so each step lists only its type and status');
});

test('a run with its full step data reads as before', async () => {
  const text = await render(run());
  expect(text).toContain('Step output JSON');
  expect(text).not.toContain('shortened');
});
