import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
const NativeResponse = globalThis.Response, originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act, createRoot: typeof import('react-dom/client').createRoot;
let useMemoryData: typeof import('./useMemoryData').useMemoryData;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
let hidden = false, calls: string[], fail = false, signal: AbortSignal | undefined;
let latest: ReturnType<typeof useMemoryData>;
beforeAll(async () => {
  ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client')); ({ useMemoryData } = await import('./useMemoryData'));
});
beforeEach(() => {
  hidden = false; calls = []; fail = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  globalThis.fetch = (async (input, options) => {
    const url = new URL(String(input), 'http://localhost'); calls.push(url.href); signal = options?.signal as AbortSignal;
    if (fail) return NativeResponse.json({ error: 'fixture' }, { status: 503 });
    const entities = url.searchParams.get('kind') === 'entities', next = url.searchParams.get('cursor');
    return NativeResponse.json({ items: entities ? next ? [{ id: 'z', name: 'Last' }] : Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, name: `Fixture ${i}` })) : [], nextCursor: entities && !next ? 'e99' : null });
  }) as typeof fetch;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; delete (document as unknown as { hidden?: boolean }).hidden; });
afterAll(() => GlobalRegistrator.unregister());
function Probe() { latest = useMemoryData(); return <div>{latest.entities.length} {latest.error}</div>; }
async function settle() { await act(async () => { await new Promise(r => setTimeout(r, 15)); }); }

test('hidden mount and hidden change events send nothing; visibility resumes a complete paginated snapshot', async () => {
  hidden = true; await act(async () => root.render(<Probe />)); expect(calls).toHaveLength(0);
  window.dispatchEvent(new Event('vault-facts-updated')); expect(calls).toHaveLength(0);
  hidden = false; await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await settle();
  expect(latest.entities).toHaveLength(101); expect(calls).toHaveLength(4);
  hidden = true; await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => window.dispatchEvent(new Event('vault-facts-updated'))); expect(calls).toHaveLength(4);
});

test('a failed page keeps the last complete snapshot and reports stale data', async () => {
  await act(async () => root.render(<Probe />)); await settle(); expect(latest.entities).toHaveLength(101);
  fail = true; await act(async () => latest.refresh());
  expect(latest.entities).toHaveLength(101); expect(latest.error).toContain('503');
});

test('overlapping refreshes share admission and hiding aborts pending page reads', async () => {
  let release!: () => void; const pending = new Promise<void>(r => { release = r; });
  globalThis.fetch = (async (_input, options) => { calls.push('held'); signal = options?.signal as AbortSignal; await pending; return NativeResponse.json({ items: [], nextCursor: null }); }) as typeof fetch;
  await act(async () => root.render(<Probe />));
  void latest.refresh(); void latest.refresh(); expect(calls).toHaveLength(3);
  hidden = true; await act(async () => document.dispatchEvent(new Event('visibilitychange'))); expect(signal?.aborted).toBe(true);
  release(); await settle(); expect(latest.entities).toHaveLength(0);
});
