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
test('production default stays on the legacy gate and never calls the onboarding-next routes', async () => {
  const { productionConfiguration } = await import('./Entry.tsx');
  expect(productionConfiguration.enabled).toBe(false);
  expect(productionConfiguration.candidate).toBeUndefined();
  expect(Object.keys(productionConfiguration.adapters)).toEqual([]);
  const original = globalThis.fetch, urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => { urls.push(String(input)); throw new Error('unexpected fetch'); }) as unknown as typeof fetch;
  try {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await React.act(async () => root!.render(<Entry legacy={<div>Complete legacy flow</div>}><div>Dashboard shell</div></Entry>));
    await React.act(async () => { await new Promise(r => setTimeout(r, 5)); });
    expect(host.textContent).toBe('Complete legacy flow');
    expect(urls).toEqual([]);
  } finally { globalThis.fetch = original; }
});
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
for (const moveFocus of [false, true]) test(`background refresh restores draft focus and selection unless focus moved (${moveFocus})`, async () => {
  const assembly = fixture({ start: 'activation' }); await mount(assembly);
  await click('Meeting follow-up');
  const input = host.querySelector('textarea')!;
  input.focus(); input.setSelectionRange(6, 13, 'backward');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const status = assembly.config.transport.status;
  assembly.config.transport.status = async signal => { await pending; return status(signal); };
  const elsewhere = document.createElement('button'); document.body.append(elsewhere);
  try {
    await React.act(async () => assembly.advance());
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    // Happy DOM does not implement inert's native focus loss; emulate the
    // browser effect while the request is pending, before asserting recovery.
    input.blur();
    if (moveFocus) elsewhere.focus();
    await React.act(async () => { release(); });
    await wait(() => host.querySelector('[aria-busy]')?.getAttribute('aria-busy') === 'false');
    expect(document.activeElement === (moveFocus ? elsewhere : input)).toBe(true);
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([6, 13, 'backward']);
  } finally { release(); elsewhere.remove(); }
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

test('tutorial replay preserves the mounted workspace selection and unsent draft', async () => {
  const { fixture: sessionFixture } = await import('./test-fixture.ts');
  const { createSession } = await import('./session.ts'); const { ViewHost } = await import('./ViewHost.tsx');
  const f = sessionFixture(); f.setJourney({ stepId: 'exited', completion: 'completed', setupState: 'completed', interviewState: 'done' });
  const session = createSession(f.config); await session.start();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  let mounts = 0;
  function Workspace() { React.useEffect(() => { mounts++; }, []); return <main data-real-room="workflows" data-selection="saved-version"><textarea defaultValue="unsent work" /></main>; }
  try {
    await React.act(async () => root!.render(<ViewHost session={session} legacy={null}><Workspace /></ViewHost>));
    const room = host.querySelector('[data-real-room]')!, draft = room.querySelector('textarea')!; draft.value = 'Keep my edited draft';
    f.setJourney({ stepId: 'tour', replayReturnStepId: 'exited', tourState: 'pending', revision: 1 });
    await React.act(async () => session.refresh());
    expect(room.isConnected).toBe(true); expect(room.closest('[hidden][inert]')).not.toBeNull(); expect(mounts).toBe(1);
    f.setJourney({ stepId: 'exited', replayReturnStepId: null, tourState: 'done', revision: 2 });
    await React.act(async () => session.refresh());
    expect(host.querySelector('[data-real-room]')).toBe(room); expect(host.querySelector('textarea')).toBe(draft);
    expect(draft.value).toBe('Keep my edited draft'); expect(mounts).toBe(1); expect(room.closest('[hidden]')).toBeNull();
  } finally { session.dispose(); }
});
test('fresh onboarding does not mount the live workspace before setup', async () => {
  const { fixture: sessionFixture } = await import('./test-fixture.ts');
  const { createSession } = await import('./session.ts'); const { ViewHost } = await import('./ViewHost.tsx');
  const f = sessionFixture(), session = createSession(f.config); await session.start();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); let mounts = 0;
  function Workspace() { React.useEffect(() => { mounts++; }, []); return <main>Live workspace</main>; }
  try { await React.act(async () => root!.render(<ViewHost session={session} legacy={null}><Workspace /></ViewHost>)); expect(mounts).toBe(0); }
  finally { session.dispose(); }
});
