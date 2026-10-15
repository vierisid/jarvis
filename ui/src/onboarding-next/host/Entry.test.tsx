import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let Entry: typeof import('./Entry.tsx').OptionalOnboardingEntry;
let fixture: typeof import('./preview/fixture.tsx').previewConfiguration;
let host: HTMLDivElement, root: ReturnType<typeof createRoot> | undefined;
beforeAll(async () => { React = await import('react'); ({ createRoot } = await import('react-dom/client')); ({ OptionalOnboardingEntry: Entry } = await import('./Entry.tsx')); ({ previewConfiguration: fixture } = await import('./preview/fixture.tsx')); });
afterEach(async () => { if (root) await React.act(async () => root!.unmount()); host?.remove(); root = undefined; });
afterAll(() => GlobalRegistrator.unregister());
async function wait(done: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!done()) { if (Date.now() > deadline) throw new Error('Host did not settle'); await React.act(async () => { await new Promise(r => setTimeout(r, 1)); }); }
}
async function mount(assembly: ReturnType<typeof fixture>) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await render(assembly);
  await wait(() => !host.textContent?.includes('Restoring onboarding'));
}
async function render(assembly: ReturnType<typeof fixture>) {
  await React.act(async () => root!.render(<React.StrictMode><Entry configuration={assembly.config} legacy={<div>Complete legacy flow</div>}><div>Dashboard shell</div></Entry></React.StrictMode>));
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  expect(button).toBeDefined(); await React.act(async () => button!.click());
}
for (const mode of ['disabled', 'empty', 'partial'] as const) test(`${mode} registry retains the complete legacy branch`, async () => {
  const assembly = fixture({ mode }); await mount(assembly);
  expect(host.textContent).toBe('Complete legacy flow'); expect(assembly.calls).not.toContain('journey.read');
});
test('revoking an enable flag cannot replace an active journey with legacy', async () => {
  const assembly = fixture(); await mount(assembly);
  assembly.config.enabled = false; await render(assembly);
  expect(host.textContent).not.toContain('Complete legacy flow');
  await click('Set up Jarvis'); await wait(() => !!host.querySelector('.on-host__recovery'));
  expect(host.textContent).not.toContain('Complete legacy flow');
  expect(assembly.calls).not.toContain('journey.transition');
});
test('real view navigation, focus, Google skip and interview completion retain activation', async () => {
  const assembly = fixture(); await mount(assembly);
  await click('Set up Jarvis'); await wait(() => !!host.querySelector('.on-explainer'));
  expect(document.activeElement?.tagName).toBe('H1');
  await click('Continue'); await wait(() => !!host.querySelector('.on-google'));
  await click('Skip for now'); await wait(() => !!host.querySelector('.on-interview'));
  await click('Skip'); expect(host.textContent).toContain('0 facts in Memory');
  await click('Continue'); await wait(() => !!host.querySelector('.on-tour'));
  await click('Skip tour'); await wait(() => !!host.querySelector('.on-activation'));
  expect(host.textContent).not.toContain('Dashboard shell');
  await click('Explore Jarvis first'); await wait(() => host.textContent === 'Dashboard shell');
});
test('disconnection masks the view and restores the persisted activation draft without mounting legacy', async () => {
  const assembly = fixture({ start: 'activation' }); await mount(assembly);
  await click('Meeting follow-up');
  const before = host.querySelector('textarea')!.value; expect(before).toContain('meeting');
  await React.act(async () => assembly.disconnect()); await wait(() => !!host.querySelector('.on-host__recovery'));
  expect(host.textContent).not.toContain('Complete legacy flow');
  assembly.reconnect(); await click('Reconnect'); await wait(() => !!host.querySelector('textarea'));
  expect(host.querySelector('textarea')!.value).toBe(before);
});
test('real build view opens the exact fixture result once its terminal event is newer', async () => {
  const assembly = fixture({ start: 'activation' }); await mount(assembly);
  await click('Meeting follow-up'); await click('Create my workflow'); await wait(() => !!host.querySelector('.on-build'));
  expect(host.textContent).not.toContain('Saved draft fixture');
  for (let i = 0; i < 4; i++) {
    await React.act(async () => assembly.advance());
    await wait(() => host.querySelector('[aria-busy]')?.getAttribute('aria-busy') !== 'true');
  }
  await wait(() => !!host.textContent?.includes('Saved draft fixture'));
  expect(host.textContent).toContain('fixture-flow'); expect(host.textContent).toContain('fixture-version');
  await click('Continue to dashboard'); await wait(() => host.textContent === 'Dashboard shell');
});
