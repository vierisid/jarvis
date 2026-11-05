// #1261: an unknown customer onboarding branch can be resolved from the run on the dashboard.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
const NativeResponse = globalThis.Response, originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalConfirm = window.confirm;
afterEach(() => { globalThis.fetch = originalFetch; window.confirm = originalConfirm; });
afterAll(() => GlobalRegistrator.unregister());

const EFFECT = 'wfe_' + 'a'.repeat(64);
const unknownDrive = (over: Record<string, unknown> = {}) => ({ effectId: EFFECT, customer: { id: 'customer-1', name: 'Example Customer' }, running: false,
  branches: { clickup: { status: 'succeeded', url: 'https://app.clickup.com/t/t1' }, drive: { status: 'unknown', detail: 'Unconfirmed write requires review; creation will not be repeated.' } }, ...over });

let gets = 0;
async function mount(responses: { get: () => unknown; post?: (body: any) => Response }, check: (host: HTMLElement, posts: any[], act: (f: () => unknown) => Promise<void>) => Promise<void>) {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { OnboardingOutcomes } = await import('./OnboardingOutcomes');
  const posts: any[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); posts.push({ url, body }); return responses.post?.(body) ?? NativeResponse.json({ ok: true }); }
    expect(url).toBe('/api/workflow-runs/run-1/onboarding');
    gets++;
    const listed = responses.get();
    if (listed === 'error') return new NativeResponse('', { status: 500 });
    return NativeResponse.json({ runId: 'run-1', onboardings: listed });
  }) as typeof fetch;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const act = async (f: () => unknown) => { await React.act(async () => { await f(); }); for (let i = 0; i < 4; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
  try { await act(() => root.render(<OnboardingOutcomes runId="run-1" />)); await check(host, posts, act); }
  finally { await React.act(async () => root.unmount()); host.remove(); }
}
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text)! as HTMLButtonElement;
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
}

test('nothing is shown for a run with no unresolved onboarding branch', async () => {
  await mount({ get: () => [unknownDrive({ branches: { clickup: { status: 'succeeded' }, drive: { status: 'failed' } } })] }, async host => {
    expect(host.textContent).toBe('');
  });
  gets = 0;
  await mount({ get: () => [] }, async host => { expect(host.textContent).toBe(''); });
  expect(gets).toBe(1);
});

test('"It was not created" asks first, then records release and reloads', async () => {
  let resolved = false;
  await mount({ get: () => [resolved ? unknownDrive({ branches: { drive: { status: 'failed' } } }) : unknownDrive()],
    post: () => { resolved = true; return NativeResponse.json({ ok: true }); } }, async (host, posts, act) => {
    expect(host.textContent).toContain('Drive folder for Example Customer (customer-1): outcome unknown.');
    expect(host.textContent).not.toContain('ClickUp task for');
    const asked: string[] = [];
    window.confirm = (m?: string) => { asked.push(String(m)); return false; };
    await act(() => button(host, 'It was not created').click());
    expect(asked[0]).toContain('was not created?');
    expect(posts).toEqual([]);
    window.confirm = () => true;
    await act(() => type(host.querySelector('input[id$="-note"]') as HTMLInputElement, 'Not in Drive'));
    await act(() => button(host, 'It was not created').click());
    expect(posts).toEqual([{ url: `/api/workflow-runs/run-1/effects/${EFFECT}/onboarding`, body: { branch: 'drive', resolution: 'release', note: 'Not in Drive' } }]);
    expect(host.textContent).toBe('');
  });
});

test('"It was created" validates the link like the route does before asking, and sends what was typed', async () => {
  await mount({ get: () => [unknownDrive()] }, async (host, posts, act) => {
    const asked: string[] = [];
    window.confirm = (m?: string) => { asked.push(String(m)); return true; };
    const input = host.querySelector('input[id$="-resource"]') as HTMLInputElement;
    expect(button(host, 'It was created').disabled).toBe(true);
    await act(() => type(input, 'https://evil.example/drive/folders/x'));
    await act(() => button(host, 'It was created').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Give the Drive folder ID or its https://drive.google.com/drive/folders/ link');
    expect(asked).toEqual([]); expect(posts).toEqual([]);
    await act(() => type(input, 'https://drive.google.com/drive/u/1/folders/folder-x?usp=sharing'));
    await act(() => button(host, 'It was created').click());
    expect(asked[0]).toContain('https://drive.google.com/drive/folders/folder-x');
    expect(posts.map(p => p.body)).toEqual([{ branch: 'drive', resolution: 'mark_done', resource: 'https://drive.google.com/drive/u/1/folders/folder-x?usp=sharing' }]);
  });
});

test('a refusal from the daemon is shown, and a customer held by a run offers no choice', async () => {
  await mount({ get: () => [unknownDrive()], post: () => NativeResponse.json({ error: 'Customer onboarding is running for this customer; wait for both outcomes before resolving' }, { status: 409 }) }, async (host, _posts, act) => {
    window.confirm = () => true;
    await act(() => button(host, 'It was not created').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Customer onboarding is running');
    expect(host.textContent).toContain('outcome unknown');
  });
  await mount({ get: () => [unknownDrive({ running: true })] }, async host => {
    expect(host.textContent).toContain('A run is onboarding this customer now');
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });
});

test('a failed reload keeps the branches, says so as an alert, and can be retried', async () => {
  let fail = false, resolved = false;
  await mount({ get: () => (fail ? 'error' : resolved ? [] : [unknownDrive()]), post: () => { fail = true; return NativeResponse.json({ ok: true }); } }, async (host, posts, act) => {
    window.confirm = () => true;
    await act(() => button(host, 'It was not created').click());
    expect(posts).toHaveLength(1);
    // The reload after the decision failed: the last answer stays, with the error beside it.
    expect(host.textContent).toContain('outcome unknown');
    const alert = [...host.querySelectorAll('[role="alert"]')].find(a => a.textContent?.includes("Couldn't check"));
    expect(alert).toBeTruthy();
    fail = false; resolved = true;
    await act(() => button(host, 'Try again').click());
    expect(host.textContent).toBe('');
  });
});

test('a branch a live run is creating is "being created", not interrupted', async () => {
  await mount({ get: () => [unknownDrive({ running: true, branches: { drive: { status: 'dispatching' } } })] }, async host => {
    expect(host.textContent).toContain('Drive folder for Example Customer (customer-1): being created.');
    expect(host.textContent).not.toContain('interrupted');
  });
  await mount({ get: () => [unknownDrive({ branches: { drive: { status: 'dispatching' } } })] }, async host => {
    expect(host.textContent).toContain('creation was interrupted');
  });
});

test('a second choice made while the first is being confirmed sends nothing', async () => {
  await mount({ get: () => [unknownDrive()] }, async (host, posts, act) => {
    window.confirm = () => true;
    await act(() => type(host.querySelector('input[id$="-resource"]') as HTMLInputElement, 'folder-x'));
    // Both clicks in one task, before the first confirmation settles.
    await act(() => { button(host, 'It was created').click(); button(host, 'It was not created').click(); });
    expect(posts.map(p => p.body.resolution)).toEqual(['mark_done']);
  });
});
