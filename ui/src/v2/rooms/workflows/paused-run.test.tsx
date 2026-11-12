import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act, createRoot: typeof import('react-dom/client').createRoot;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
beforeAll(async () => { ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client')); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());

test('the list Run of a turned-off workflow says it will run once', async () => {
  const { FlowRow } = await import('./WorkflowsRoom');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const noop = () => undefined;
  const row = (status: string) => <ul><FlowRow flow={{ id: 'f', externalId: 'f', projectId: 'p', status, publishedVersionId: 'v', metadata: null, displayName: 'Report', updated: Date.now() } as any}
    selected={false} onSelect={noop} onEdit={noop} onRun={noop} onToggle={noop} onPublish={noop} onDelete={noop} /></ul>;
  await act(async () => root.render(row('DISABLED')));
  const run = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Run once')!;
  expect(run.getAttribute('title')).toContain('off');
  await act(async () => root.render(row('ENABLED')));
  expect([...host.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Run')).toBe(true);
  expect([...host.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Run once')).toBe(false);
});
