import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { BRIEF_CONTRACT_VERSION } from '../../../../src/brief/contracts';

const NativeResponse = globalThis.Response;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());

const scopeId = 'scope';
const capabilities = () => ({ contractVersion: BRIEF_CONTRACT_VERSION, capabilities: {
  workflowContext: { supported: true, ready: true, enabled: true, state: 'ready', reason: null } } });

async function render(brokenInspection: boolean) {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { createWorkflowRooms } = await import('./workflow-rooms');
  const { createHostTransport } = await import('./http');
  const seen: string[] = [];
  const transport = createHostTransport((async (path: string, init: RequestInit = {}) => {
    seen.push(`${init.method ?? 'GET'} ${path}`);
    if (path.endsWith('/discard')) return NativeResponse.json({ discarded: true });
    if (path === '/api/workflows/f1') return NativeResponse.json({ flow: { id: 'f1' }, latestDraft: { id: 'd1', flowId: 'f1', state: 'DRAFT', displayName: 'Broken', trigger: 'just a string' } });
    if (path.includes('/inspection')) return brokenInspection ? new NativeResponse('', { status: 500 }) : NativeResponse.json({});
    return new NativeResponse('', { status: 404 });
  }) as unknown as typeof fetch);
  const rooms = createWorkflowRooms({ scopeId, transport, capabilities, storage: { getItem: () => null, setItem: () => {} }, dirty: () => {}, runInput: async () => ({}) });
  const navigated: unknown[] = [];
  const shell = { route: { room: 'workflow-draft', selection: { flowId: 'f1', versionId: undefined } }, navigate: (to: unknown) => { navigated.push(to); } } as any;
  const Body = (rooms.rooms as any)['workflow-draft'].Body as React.ComponentType<{ shell: unknown }>;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await React.act(async () => root.render(<Body shell={shell} />));
  for (let i = 0; i < 8; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 5)); });
  const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(label));
  return { React, host, seen, navigated, button, done: async () => { await React.act(async () => root.unmount()); host.remove(); rooms.retire(); transport.stop(); } };
}

test('a draft that cannot be opened says so and offers to discard it, after asking once', async () => {
  const r = await render(true);
  try {
    expect(r.host.textContent).toContain('This workflow version is unavailable');
    expect(r.host.textContent).toContain('you can throw it away');
    await r.React.act(async () => r.button('Discard this draft')!.click());
    expect(r.host.textContent).toContain('Discard this draft for good?');
    // Nothing is deleted until it is confirmed.
    expect(r.seen.some(s => s.startsWith('POST'))).toBe(false);
    await r.React.act(async () => { r.button('Yes, discard it')!.click(); await new Promise(res => setTimeout(res, 10)); });
    expect(r.seen).toContain('POST /api/workflows/f1/versions/d1/discard');
    expect(r.navigated).toEqual([{ room: 'all-workflows', selection: {} }]);
  } finally { await r.done(); }
});

test('"Keep it" leaves the draft alone', async () => {
  const r = await render(true);
  try {
    await r.React.act(async () => r.button('Discard this draft')!.click());
    await r.React.act(async () => r.button('Keep it')!.click());
    expect(r.button('Discard this draft')).toBeDefined();
    expect(r.seen.some(s => s.startsWith('POST'))).toBe(false);
  } finally { await r.done(); }
});
