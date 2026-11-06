// The per-flow list of hosts HTTP GET steps may read without an approval card.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
const NativeResponse = globalThis.Response, originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalConfirm = window.confirm;
afterEach(() => { globalThis.fetch = originalFetch; window.confirm = originalConfirm; });
afterAll(() => GlobalRegistrator.unregister());

type Flow = import('./useWorkflowsData').Flow;
const flow = (readHosts?: Flow['readHosts']): Flow => ({ id: 'flow-1', externalId: 'x', projectId: 'p', status: 'DISABLED', publishedVersionId: null,
  metadata: null, codeSteps: { enabled: false, grantedBy: null, grantedAt: null }, ...(readHosts ? { readHosts } : {}), created: 1, updated: 1, displayName: 'Nightly report' });

let get: (url: string) => Response = () => new NativeResponse('', { status: 404 });
afterEach(() => { get = () => new NativeResponse('', { status: 404 }); });
async function mount(f: Flow, post: (body: any) => Response, check: (host: HTMLElement, posts: any[], changed: () => number, act: (fn: () => unknown) => Promise<void>) => Promise<void>) {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { FlowPermissions } = await import('./FlowPermissions');
  const posts: any[] = [];
  let changes = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') return get(url);
    const body = JSON.parse(String(init!.body)); posts.push({ url, method: init?.method, body }); return post(body);
  }) as typeof fetch;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const act = async (fn: () => unknown) => { await React.act(async () => { await fn(); }); for (let i = 0; i < 4; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
  try { await act(() => root.render(<FlowPermissions flow={f} onChanged={() => { changes++; }} />)); await check(host, posts, () => changes, act); }
  finally { await React.act(async () => root.unmount()); host.remove(); }
}
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text || b.getAttribute('aria-label') === text) as HTMLButtonElement | undefined;
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
}
const field = (host: HTMLElement) => host.querySelector('input[id^="wf-read-hosts-"]') as HTMLInputElement;

test('a daemon without the read list shows no editor', async () => {
  await mount(flow(), () => NativeResponse.json({}), async (host) => {
    expect(field(host)).toBeNull();
    expect(host.textContent).not.toContain('read without asking');
  });
});

test('adding a host asks first, then sends the whole list', async () => {
  await mount(flow({ hosts: ['api.example.com'], grantedBy: 'user', grantedAt: 1 }), () => NativeResponse.json({}), async (host, posts, changed, act) => {
    expect(host.textContent).toContain('api.example.com');
    await act(() => type(field(host), '  Data.Example.org '));
    const asked: string[] = [];
    window.confirm = (m?: string) => { asked.push(String(m)); return false; };
    await act(() => button(host, 'Add')!.click());
    expect(asked[0]).toContain('Let the workflow "Nightly report" send HTTP GET requests to data.example.org without asking?');
    expect(asked[0]).toContain('including whatever the workflow puts in their address or headers');
    expect(posts).toEqual([]);
    window.confirm = () => true;
    await act(() => button(host, 'Add')!.click());
    expect(posts).toEqual([{ url: '/api/workflows/flow-1/read-hosts', method: 'POST', body: { hosts: ['api.example.com', 'data.example.org'], expected: ['api.example.com'] } }]);
    expect(changed()).toBe(1);
    expect(field(host).value).toBe('');
  });
});

test('removing a host narrows the list without asking', async () => {
  await mount(flow({ hosts: ['a.example.com', 'b.example.com'], grantedBy: 'user', grantedAt: 1 }), () => NativeResponse.json({}), async (host, posts, changed, act) => {
    window.confirm = () => { throw new Error('no confirmation expected'); };
    await act(() => button(host, 'Remove a.example.com')!.click());
    expect(posts).toEqual([{ url: '/api/workflows/flow-1/read-hosts', method: 'POST', body: { hosts: ['b.example.com'], expected: ['a.example.com', 'b.example.com'] } }]);
    expect(changed()).toBe(1);
  });
});

test("the server's refusal is shown inline and the typed host is kept", async () => {
  await mount(flow({ hosts: [], grantedBy: null, grantedAt: null }), () => NativeResponse.json({ error: 'hosts[0] must be a bare host name, not "https://x.example"' }, { status: 400 }), async (host, posts, changed, act) => {
    expect(host.textContent).toContain('none. Each HTTP GET step asks first.');
    window.confirm = () => true;
    await act(() => type(field(host), 'https://x.example'));
    await act(() => button(host, 'Add')!.click());
    expect(posts).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('hosts[0] must be a bare host name, not "https://x.example"');
    expect(field(host).value).toBe('https://x.example');
    expect(changed()).toBe(0);
  });
});

test('hosts seeded at upgrade say so, and a full list cannot grow', async () => {
  const hosts = Array.from({ length: 64 }, (_, i) => `h${i}.example.com`);
  await mount(flow({ hosts, grantedBy: 'upgrade', grantedAt: 1 }), () => NativeResponse.json({}), async (host) => {
    expect(host.textContent).toContain('Added at upgrade');
    expect(field(host).disabled).toBe(true);
    expect(button(host, 'Add')!.disabled).toBe(true);
    expect(host.textContent).toContain('most hosts it can list (64)');
  });
});

test('each change starts from the list the last one left, not the one first shown (stale list)', async () => {
  const lists = [['b.example.com', 'c.example.com'], ['c.example.com'], ['c.example.com', 'd.example.com']];
  let n = 0;
  await mount(flow({ hosts: ['a.example.com', 'b.example.com', 'c.example.com'], grantedBy: 'user', grantedAt: 1 }),
    () => NativeResponse.json({ readHosts: { hosts: lists[n++], grantedBy: 'user', grantedAt: 2 } }), async (host, posts, _changed, act) => {
    // The list prop never refreshes here, as when the poll that answers is already in flight.
    await act(() => button(host, 'Remove a.example.com')!.click());
    await act(() => button(host, 'Remove b.example.com')!.click());
    window.confirm = () => true;
    await act(() => type(field(host), 'd.example.com'));
    await act(() => button(host, 'Add')!.click());
    expect(posts.map(p => p.body.hosts)).toEqual([['b.example.com', 'c.example.com'], ['c.example.com'], ['c.example.com', 'd.example.com']]);
    // Each write says which list it started from.
    expect(posts.map(p => p.body.expected)).toEqual([['a.example.com', 'b.example.com', 'c.example.com'], ['b.example.com', 'c.example.com'], ['c.example.com']]);
    expect(button(host, 'Remove a.example.com')).toBeUndefined();
  });
});

test('two quick removals send one request', async () => {
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  await mount(flow({ hosts: ['a.example.com', 'b.example.com'], grantedBy: 'user', grantedAt: 1 }), () => NativeResponse.json({}), async (host, posts, _changed, act) => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => { posts.push({ url, body: JSON.parse(String(init!.body)) }); await held; return NativeResponse.json({}); }) as typeof fetch;
    button(host, 'Remove a.example.com')!.click();
    button(host, 'Remove b.example.com')!.click();
    release();
    await act(() => undefined);
    expect(posts).toHaveLength(1);
  });
});

test('a lookalike host is shown and granted as its punycode', async () => {
  await mount(flow({ hosts: [], grantedBy: null, grantedAt: null }), () => NativeResponse.json({}), async (host, posts, _changed, act) => {
    const asked: string[] = [];
    window.confirm = (m?: string) => { asked.push(String(m)); return true; };
    await act(() => type(field(host), 'ex\u0430mple.com'));
    await act(() => button(host, 'Add')!.click());
    expect(asked[0]).toContain('xn--exmple-4nf.com (typed as ex\u0430mple.com)');
    expect(posts[0].body.hosts).toEqual(['xn--exmple-4nf.com']);
  });
});

test('picking another flow does not carry a typed host or an error over to it', async () => {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { FlowDetail } = await import('./WorkflowsRoom');
  const a = flow({ hosts: [], grantedBy: null, grantedAt: null });
  const b = { ...a, id: 'flow-2', displayName: 'Other' };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const detail = (f: Flow) => <FlowDetail flow={f} runs={[]} onRefreshRuns={() => {}} onCancelRun={() => {}} onPermissionsChanged={() => {}} onClose={() => {}} />;
  try {
    await React.act(async () => root.render(detail(a)));
    await React.act(async () => { await type(field(host), 'typed-for-a.example.com'); });
    expect(field(host).value).toBe('typed-for-a.example.com');
    await React.act(async () => root.render(detail(b)));
    expect(field(host).value).toBe('');
  } finally { await React.act(async () => root.unmount()); host.remove(); }
});

test('a list changed elsewhere refuses the write (409): the message shows and the stored list replaces the stale one', async () => {
  const message = 'the read list changed since this edit started; reload it and try again';
  get = (url) => {
    expect(url).toBe('/api/workflows/flow-1');
    return NativeResponse.json({ flow: { readHosts: { hosts: ['b.example.com'], grantedBy: 'user', grantedAt: 3 } } });
  };
  await mount(flow({ hosts: ['a.example.com', 'b.example.com'], grantedBy: 'user', grantedAt: 1 }), () => NativeResponse.json({ error: message }, { status: 409 }), async (host, posts, changed, act) => {
    await act(() => button(host, 'Remove b.example.com')!.click());
    expect(posts).toEqual([{ url: '/api/workflows/flow-1/read-hosts', method: 'POST', body: { hosts: ['a.example.com'], expected: ['a.example.com', 'b.example.com'] } }]);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
    // Reloaded: a.example.com was removed elsewhere, so it is no longer offered.
    expect(button(host, 'Remove a.example.com')).toBeUndefined();
    expect(button(host, 'Remove b.example.com')).toBeDefined();
    expect(changed()).toBe(1);
  });
});
