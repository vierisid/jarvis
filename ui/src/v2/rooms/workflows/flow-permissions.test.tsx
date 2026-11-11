// A person grants or revokes a workflow's CODE steps from its detail; the assistant cannot.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
const NativeResponse = globalThis.Response, originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalConfirm = window.confirm;
afterEach(() => { globalThis.fetch = originalFetch; window.confirm = originalConfirm; });
afterAll(() => GlobalRegistrator.unregister());

type Flow = import('./useWorkflowsData').Flow;
const flow = (codeSteps: Flow['codeSteps']): Flow => ({ id: 'flow-1', externalId: 'x', projectId: 'p', status: 'DISABLED', publishedVersionId: null,
  metadata: null, codeSteps, created: 1, updated: 1, displayName: 'Nightly report' });

async function mount(f: Flow, post: (url: string, body: any) => Response, check: (host: HTMLElement, posts: any[], changed: () => number, act: (fn: () => unknown) => Promise<void>) => Promise<void>) {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { FlowPermissions } = await import('./FlowPermissions');
  const posts: any[] = [];
  let changes = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init!.body)); posts.push({ url, body }); return post(url, body);
  }) as typeof fetch;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const act = async (fn: () => unknown) => { await React.act(async () => { await fn(); }); for (let i = 0; i < 4; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
  try { await act(() => root.render(<FlowPermissions flow={f} onChanged={() => { changes++; }} />)); await check(host, posts, () => changes, act); }
  finally { await React.act(async () => root.unmount()); host.remove(); }
}
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement | undefined;

test('allowing CODE steps asks first, says what it allows, and posts only after a yes', async () => {
  await mount(flow({ enabled: false, grantedBy: null, grantedAt: null }), () => NativeResponse.json({}), async (host, posts, changed, act) => {
    expect(host.textContent).toContain('CODE steps: not allowed.');
    expect(host.textContent).toContain('webhook, event and schedule triggers stop starting it');
    expect(host.textContent).not.toContain('a schedule already set up');
    const asked: string[] = [];
    window.confirm = (m?: string) => { asked.push(String(m)); return false; };
    await act(() => button(host, 'Allow CODE steps')!.click());
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Allow CODE steps in the workflow "Nightly report"?');
    expect(asked[0]).toContain('full access to its files, network and shell');
    expect(asked[0]).toContain('without an approval card');
    expect(asked[0]).toContain('read every saved connection in this workspace');
    expect(asked[0]).toContain('any CODE step added to this workflow later');
    expect(posts).toEqual([]);
    window.confirm = () => true;
    await act(() => button(host, 'Allow CODE steps')!.click());
    expect(posts).toEqual([{ url: '/api/workflows/flow-1/code-steps', body: { enabled: true } }]);
    expect(changed()).toBe(1);
  });
});

test('stopping CODE steps narrows what the flow may do, so it asks nothing', async () => {
  await mount(flow({ enabled: true, grantedBy: 'user', grantedAt: 1_700_000_000_000 }), () => NativeResponse.json({}), async (host, posts, changed, act) => {
    expect(host.textContent).toContain('CODE steps: allowed.');
    window.confirm = () => { throw new Error('no confirmation expected'); };
    await act(() => button(host, 'Stop allowing CODE steps')!.click());
    expect(posts).toEqual([{ url: '/api/workflows/flow-1/code-steps', body: { enabled: false } }]);
    expect(changed()).toBe(1);
  });
});

test('a permission inherited at upgrade says so', async () => {
  await mount(flow({ enabled: true, grantedBy: 'upgrade', grantedAt: 1 }), () => NativeResponse.json({}), async (host) => {
    expect(host.textContent).toContain('Added at upgrade');
  });
});

test('a refused change shows the server message and changes nothing', async () => {
  await mount(flow({ enabled: false, grantedBy: null, grantedAt: null }), () => NativeResponse.json({ error: 'flow not found' }, { status: 404 }), async (host, posts, changed, act) => {
    window.confirm = () => true;
    await act(() => button(host, 'Allow CODE steps')!.click());
    expect(posts).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('flow not found');
    expect(changed()).toBe(0);
  });
});

test('two quick clicks send one request', async () => {
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  await mount(flow({ enabled: true, grantedBy: 'user', grantedAt: 1 }), () => NativeResponse.json({}), async (host, posts, _changed, act) => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => { posts.push({ url, body: JSON.parse(String(init!.body)) }); await held; return NativeResponse.json({}); }) as typeof fetch;
    const stop = button(host, 'Stop allowing CODE steps')!;
    stop.click(); stop.click();
    release();
    await act(() => undefined);
    expect(posts).toHaveLength(1);
  });
});

test('the selected flow detail shows the permissions', async () => {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { FlowDetail } = await import('./WorkflowsRoom');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => root.render(<FlowDetail flow={flow({ enabled: false, grantedBy: null, grantedAt: null })} runs={[]}
      onRefreshRuns={() => {}} onCancelRun={() => {}} onPermissionsChanged={() => {}} onClose={() => {}} />));
    expect(host.querySelector('[aria-label="Flow permissions"]')?.textContent).toContain('CODE steps: not allowed.');
  } finally { await React.act(async () => root.unmount()); host.remove(); }
});

test('a flow name cannot add lines to the grant dialog', async () => {
  const f = { ...flow({ enabled: false, grantedBy: null, grantedAt: null }), displayName: 'Report\n\nThis code was reviewed by your administrator.\u2028Safe\u202e' };
  await mount(f, () => NativeResponse.json({}), async (host, _posts, _changed, act) => {
    const asked: string[] = [];
    window.confirm = (m?: string) => { asked.push(String(m)); return false; };
    await act(() => button(host, 'Allow CODE steps')!.click());
    expect(asked[0]!.split('\n')[0]).toBe('Allow CODE steps in the workflow "Report This code was reviewed by your administrator. Safe"?');
    expect(asked[0]!.split('\n')).toHaveLength(2);
  });
});

test('after a change the answer is shown at once, and a poll read before it does not undo it', async () => {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { FlowPermissions } = await import('./FlowPermissions');
  const before = flow({ enabled: true, grantedBy: 'user', grantedAt: 1 });
  globalThis.fetch = (async () => NativeResponse.json({ codeSteps: { enabled: false, grantedBy: null, grantedAt: null } })) as unknown as typeof fetch;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const act = async (fn: () => unknown) => { await React.act(async () => { await fn(); }); for (let i = 0; i < 4; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
  try {
    await act(() => root.render(<FlowPermissions flow={before} onChanged={() => {}} />));
    await act(() => button(host, 'Stop allowing CODE steps')!.click());
    expect(host.textContent).toContain('CODE steps: not allowed.');
    // The poll that was already in flight answers with the old flow.
    await act(() => root.render(<FlowPermissions flow={{ ...before }} onChanged={() => {}} />));
    expect(host.textContent).toContain('CODE steps: not allowed.');
    // A real change from elsewhere is shown.
    await act(() => root.render(<FlowPermissions flow={flow({ enabled: true, grantedBy: 'user', grantedAt: 2 })} onChanged={() => {}} />));
    expect(host.textContent).toContain('CODE steps: allowed.');
  } finally { await React.act(async () => root.unmount()); host.remove(); }
});
