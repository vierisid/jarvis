import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { pebbleBlinded, pushPebbleBlinded } from './pebble-blind.ts';

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
