import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { observerPause, pebbleBlinded, pushObserverPause, pushPebbleBlinded } from './pebble-blind.ts';

// #1157: the blind glyph reached only the pressed pebble, and never followed a
// settings change, so another machine's pebble showed the old state.
test('the state is pushed to every connected pebble, and a failing one does not stop the rest', async () => {
  const sent: Array<[string, unknown]> = [];
  await pushPebbleBlinded({
    connected: () => [{ id: 'a', capabilities: ['pebble'] }, { id: 'b', capabilities: ['windows'] }, { id: 'c', capabilities: ['pebble', 'windows'] }, { id: 'd', capabilities: ['pebble'] }],
    dispatchRPC: async (id, method, params) => { sent.push([id, { method, ...params }]); if (id === 'a') throw new Error('detached'); return {}; },
  }, true);
  expect(sent).toEqual([['a', { method: 'pebble.set_blinded', blinded: true }], ['c', { method: 'pebble.set_blinded', blinded: true }], ['d', { method: 'pebble.set_blinded', blinded: true }]]);
});

test('the pressed pebble is awaited, and a wedged other machine does not delay it', async () => {
  const sent: string[] = [];
  let finished = false;
  const done = pushPebbleBlinded({
    connected: () => [{ id: 'pressed', capabilities: ['pebble'] }, { id: 'wedged', capabilities: ['pebble'] }],
    dispatchRPC: async (id) => { sent.push(id); if (id === 'wedged') await new Promise(() => {}); return {}; },
  }, false, 'pressed').then(() => { finished = true; });
  await done;
  expect(finished).toBe(true);
  expect(sent).toEqual(['pressed', 'wedged']);
});

test('blinded unless awareness and desktop control are both on', () => {
  expect([pebbleBlinded(true, true), pebbleBlinded(true, false), pebbleBlinded(false, true), pebbleBlinded(false, false)]).toEqual([false, true, true, true]);
});

test('the long-press and the awareness settings applier both push to every pebble', () => {
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const marks = [index.indexOf("event.event_type !== 'pebble.blind_toggle'"), index.indexOf("console.log(`[ambient-ui] blind toggle"),
    index.indexOf("settingsReload.registerApplier('awareness'"), index.indexOf("settingsReload.registerApplier('desktop'")];
  for (const at of marks) expect(at).toBeGreaterThan(-1);
  const toggle = index.slice(marks[0], marks[1]);
  expect(toggle).toContain('pushPebbleBlinded(pebbleBlindDeps, pebbleBlinded(nextEnabled, isDesktopEnabled()), sidecarId)');
  expect(toggle).not.toContain("dispatchRPC(sidecarId, 'pebble.set_blinded'");
  const applier = index.slice(marks[2], marks[3]);
  expect(applier).toContain('void pushPebbleBlinded(pebbleBlindDeps,');
});

// #1159: the sidecar's screen and clipboard observers kept running while
// awareness or desktop control was off; the brain now pauses them at the source.
test('the observer pause: screen follows awareness and desktop, clipboard follows desktop only', () => {
  expect(observerPause(true, true)).toEqual({ screen: false, clipboard: false });
  expect(observerPause(false, true)).toEqual({ screen: true, clipboard: false });
  expect(observerPause(true, false)).toEqual({ screen: true, clipboard: true });
  expect(observerPause(false, false)).toEqual({ screen: true, clipboard: true });
});

test('the observer pause reaches every connected sidecar, or just the one that connected; an old sidecar refusing it is harmless', async () => {
  const sent: Array<[string, unknown]> = [];
  const deps = {
    connected: () => [{ id: 'old', capabilities: ['awareness'] }, { id: 'b', capabilities: ['clipboard'] }, { id: 'c', capabilities: [] }],
    dispatchRPC: async (id: string, method: string, params: Record<string, unknown>) => {
      sent.push([id, { method, ...params }]);
      if (id === 'old') throw new Error('Unknown method: observers.set_paused');
      return {};
    },
  };
  await pushObserverPause(deps, { screen: true, clipboard: false });
  expect(sent).toEqual([
    ['old', { method: 'observers.set_paused', screen: true, clipboard: false }],
    ['b', { method: 'observers.set_paused', screen: true, clipboard: false }],
    ['c', { method: 'observers.set_paused', screen: true, clipboard: false }],
  ]);
  sent.length = 0;
  await pushObserverPause(deps, { screen: false, clipboard: true }, 'b');
  expect(sent).toEqual([['b', { method: 'observers.set_paused', screen: false, clipboard: true }]]);
});

test('the daemon pushes the observer pause on connect, on the long-press, and from both settings appliers', () => {
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const connect = index.slice(index.indexOf('const pebbleBlindDeps = '), index.indexOf('// The bench harness backdoor'));
  expect(connect).toMatch(/onSidecarConnected\(\(sc\) => \{[\s\S]*pushObserverPause\(pebbleBlindDeps, observerPause\(awarenessOn, isDesktopEnabled\(\)\), sc\.id\)/);
  const toggle = index.slice(index.indexOf("event.event_type !== 'pebble.blind_toggle'"), index.indexOf("console.log(`[ambient-ui] blind toggle"));
  expect(toggle).toContain('pushObserverPause(pebbleBlindDeps, observerPause(nextEnabled, isDesktopEnabled()))');
  const awareness = index.slice(index.indexOf("settingsReload.registerApplier('awareness'"), index.indexOf("settingsReload.registerApplier('desktop'"));
  expect(awareness).toContain("pushObserverPause(pebbleBlindDeps, observerPause(cfg.awareness?.enabled !== false, isDesktopEnabled()))");
  const desktopAt = index.indexOf("settingsReload.registerApplier('desktop'");
  const desktop = index.slice(desktopAt, index.indexOf('});', desktopAt));
  expect(desktop).toContain("pushObserverPause(pebbleBlindDeps, observerPause(cfg.awareness?.enabled !== false, isDesktopEnabled()))");
});

// Owner decision 2026-11-11: with awareness off at boot the service was never
// built, and the long-press and the settings applier only toggled a service
// that existed, so turning it on saved the choice and nothing ran until a
// restart. Both now start it when there is none (post-setup-services.test.ts
// covers when the start is allowed).
test('the long-press and the awareness applier start the service when awareness was off at boot', () => {
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const toggle = index.slice(index.indexOf("event.event_type !== 'pebble.blind_toggle'"), index.indexOf("console.log(`[ambient-ui] blind toggle"));
  expect(toggle).toContain('if (awarenessService) awarenessService.toggle(nextEnabled);\n          else if (nextEnabled) await startAwarenessIfNeeded();');
  // Started before the observer pause is pushed, so the unpause meets a running service.
  expect(toggle.indexOf('await startAwarenessIfNeeded()')).toBeLessThan(toggle.indexOf('pushObserverPause('));
  const awareness = index.slice(index.indexOf("settingsReload.registerApplier('awareness'"), index.indexOf("settingsReload.registerApplier('desktop'"));
  expect(awareness).toContain("if (awarenessService) awarenessService.toggle(cfg.awareness?.enabled !== false);\n      else if (cfg.awareness?.enabled !== false) await startAwarenessIfNeeded();");
  expect(awareness.indexOf('await startAwarenessIfNeeded()')).toBeLessThan(awareness.indexOf('pushObserverPause('));
  expect(index).toContain('startAwarenessIfNeeded = postSetupServices.startAwarenessIfNeeded;');
  // One start at a time, and a switch turned off while it started is applied to it.
  expect(index).toContain('awarenessStarting ??= startAwarenessServiceNow()');
  expect(index).toMatch(/awarenessService = svc;\n\s+apiContext\.awarenessService = svc;\n[^\n]*\n\s+if \(jarvisConfig\.awareness\?\.enabled === false\) svc\.toggle\(false\);/);
});
