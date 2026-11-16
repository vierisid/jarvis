import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act, createRoot: typeof import('react-dom/client').createRoot;
let ProviderSetup: typeof import('./renderers.tsx').ProviderSetup;
const realFetch = globalThis.fetch;
let root: ReturnType<typeof createRoot> | null = null, host: HTMLElement | null = null;
beforeAll(async () => { ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client')); ({ ProviderSetup } = await import('./renderers.tsx')); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; });
afterAll(() => { globalThis.fetch = realFetch; GlobalRegistrator.unregister(); });

async function mount(ready: boolean) {
  globalThis.fetch = (async () => Response.json({ setup_completed: true, setup_completed_at: 1, setup_skipped_profile: false,
    profile_completed: false, tutorial_completed: false, tutorial_completed_at: null, tutorial_dismissed: false,
    tutorial_progress_step: null, last_reset_at: null })) as never;
  const calls: string[] = [];
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<ProviderSetup model={{ setup: { ready } }} onComplete={async () => { calls.push('complete'); }}
    onLeave={async (o: { setupSaved: boolean }) => { calls.push(o.setupSaved ? 'leave:saved' : 'leave'); }} />); });
  await act(async () => { await new Promise(r => setTimeout(r, 10)); });
  await act(async () => host!.querySelector('button')!.click());
  return calls;
}

test('saved setup without a provider opens the workspace instead of a step that cannot finish', async () => {
  expect(await mount(false)).toEqual(['leave:saved']);
});
test('saved setup that is ready continues the journey as before', async () => {
  expect(await mount(true)).toEqual(['complete']);
});
