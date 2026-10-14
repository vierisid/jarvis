import { describe, expect, it } from 'bun:test';
import { createGoogleController } from './controller.ts';
import type { GoogleConnection, GoogleSnapshot, GoogleStart } from './types.ts';

function snapshot(connection: GoogleConnection): GoogleSnapshot {
  return { schemaVersion: 1, provider: 'google', installMode: 'self', supported: true, ready: connection.state === 'connected', streamId: 'fixture', revision: 1, reason: 'fixture', connection };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture() {
  const rendered: GoogleSnapshot[] = [], timers = new Map<number, { ms: number; callback: () => void }>();
  let next = 0, reads = 0, begins = 0, opens = 0, cancels = 0, failures = 0, externalFailures = 0;
  let listener: (() => void) | undefined, state = snapshot({ state: 'idle' }), opened = true;
  let beginWait: Promise<GoogleStart> | undefined, readWait: Promise<GoogleSnapshot> | undefined;
  let signal: AbortSignal | undefined;
  const controller = createGoogleController({
    read: async s => { reads++; signal = s; return readWait ?? state; },
    begin: async s => { begins++; signal = s; return beginWait ?? { snapshot: state = snapshot({ state: 'pending', attemptId: 'a' }), launch: { attemptId: 'a', url: 'https://accounts.google.com/fixture' } }; },
    cancel: async id => { cancels++; return state = snapshot({ state: 'cancelled', attemptId: id }); },
    externalFailed: async id => { externalFailures++; return state = snapshot({ state: 'error', attemptId: id, message: 'Window failed' }); },
    open: () => { opens++; return opened; }, onReturn: cb => { listener = cb; return () => { listener = undefined; }; },
    render: s => { rendered.push(s); }, failure: () => { failures++; },
    timer: (callback, ms) => { const id = ++next; timers.set(id, { callback, ms }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: id => { timers.delete(id as unknown as number); },
  });
  return { controller, rendered, timers, stats: () => ({ reads, begins, opens, cancels, failures, externalFailures }),
    listening: () => !!listener, returned: () => listener?.(), blocked: () => { opened = false; },
    state: (s: GoogleConnection) => { state = snapshot(s); }, signal: () => signal,
    beginWait: (p: Promise<GoogleStart>) => { beginWait = p; }, readWait: (p: Promise<GoogleSnapshot>) => { readWait = p; },
    fire(ms: number) { const entry = [...timers.entries()].find(([, t]) => t.ms === ms); if (entry) { timers.delete(entry[0]); entry[1].callback(); } },
  };
}
describe('Google headless browser lifecycle', () => {
  it('has no startup effects; entry reads current status and return verifies it again', async () => {
    const f = fixture(); expect(f.stats().reads).toBe(0); expect(f.listening()).toBe(false);
    await f.controller.enter(); await f.controller.connect(); expect(f.rendered.at(-1)?.connection.state).toBe('pending');
    f.state({ state: 'connected', attemptId: null, accountLabel: 'alice@example.test', grantedAccessSummary: 'read', scopes: [] });
    f.returned(); await tick(); expect(f.rendered.at(-1)?.connection.state).toBe('connected');
    expect(f.stats().reads).toBe(2); expect(f.timers.size).toBe(0);
    f.controller.leave(); expect(f.listening()).toBe(false);
  });
  it('reports a blocked popup/WebView handoff and stops polling', async () => {
    const f = fixture(); await f.controller.enter(); f.blocked(); await f.controller.connect();
    expect(f.rendered.at(-1)?.connection.state).toBe('error'); expect(f.stats().externalFailures).toBe(1); expect(f.timers.size).toBe(0);
  });
  it('prevents overlapping connect clicks and cancels a late launch after leaving', async () => {
    const f = fixture(), waiting = deferred<GoogleStart>(); await f.controller.enter(); f.beginWait(waiting.promise);
    const begin = f.controller.connect(); await f.controller.connect();
    f.controller.leave(); expect(f.signal()?.aborted).toBe(true);
    waiting.resolve({ snapshot: snapshot({ state: 'pending', attemptId: 'late' }), launch: { attemptId: 'late', url: 'https://accounts.google.com/fixture' } }); await begin;
    expect(f.stats()).toMatchObject({ begins: 1, opens: 0, cancels: 1 }); expect(f.timers.size).toBe(0); expect(f.listening()).toBe(false);
  });
  it('cancel stops polling; a later return can discover a genuine grant', async () => {
    const f = fixture(); await f.controller.enter(); await f.controller.connect(); await f.controller.cancel();
    expect(f.rendered.at(-1)?.connection.state).toBe('cancelled'); expect(f.timers.size).toBe(0);
    f.state({ state: 'connected', attemptId: null, accountLabel: 'alice@example.test', grantedAccessSummary: 'read', scopes: [] });
    f.returned(); await tick(); expect(f.rendered.at(-1)?.connection).toMatchObject({ state: 'connected', attemptId: null });
  });
  it('skip never starts a connection and removes every listener/timer', async () => {
    const f = fixture(); await f.controller.enter(); await f.controller.skip();
    expect(f.stats()).toMatchObject({ opens: 0, begins: 0, cancels: 0 }); expect(f.listening()).toBe(false);
    await f.controller.enter(); await f.controller.connect(); await f.controller.skip();
    expect(f.stats().cancels).toBe(1); expect(f.timers.size).toBe(0); expect(f.listening()).toBe(false);
  });
  it('leaving discards outstanding reads and reentering does not reopen OAuth', async () => {
    const f = fixture(), waiting = deferred<GoogleSnapshot>(); await f.controller.enter(); f.readWait(waiting.promise);
    const read = f.controller.refresh(); f.controller.leave(); const before = f.rendered.length;
    waiting.resolve(snapshot({ state: 'pending', attemptId: 'old' })); await read;
    expect(f.rendered).toHaveLength(before); expect(f.timers.size).toBe(0);
    await f.controller.enter(); expect(f.stats().opens).toBe(0); f.controller.leave(); expect(f.timers.size).toBe(0);
  });
  it('bounds hung requests and ignores their later result', async () => {
    const f = fixture(), waiting = deferred<GoogleSnapshot>(); f.readWait(waiting.promise);
    const entry = f.controller.enter(); f.fire(15000); expect(f.signal()?.aborted).toBe(true); expect(f.stats().failures).toBe(1);
    waiting.resolve(snapshot({ state: 'connected', attemptId: null, accountLabel: 'old', grantedAccessSummary: 'read', scopes: [] })); await entry;
    expect(f.rendered).toHaveLength(0); expect(f.timers.size).toBe(0); f.controller.leave();
  });
  it('polls without overlap and stops on expiry', async () => {
    const f = fixture(); await f.controller.enter(); await f.controller.connect();
    f.state({ state: 'expired', attemptId: 'a' }); f.fire(2000); await tick();
    expect(f.rendered.at(-1)?.connection.state).toBe('expired'); expect(f.timers.size).toBe(0);
  });
});
