import { describe, expect, test } from 'bun:test';
import { NOTCH_CAPABILITY, attachNotch, type NotchSidecar, type NotchSidecarPort } from './attach.ts';

/** A sidecar manager that records what it is asked to do. */
function fakePort(answer: () => Promise<unknown> = async () => ({ configured: true, enabled: true, surface: 'none' })) {
  const listeners: Array<(sidecar: NotchSidecar) => void> = [];
  const calls: Array<{ sidecarId: string; method: string; params?: Record<string, unknown> }> = [];
  const port: NotchSidecarPort = {
    onSidecarConnected(listener) { listeners.push(listener); },
    dispatchRPC(sidecarId, method, params) { calls.push({ sidecarId, method, params }); return answer(); },
  };
  return {
    port, calls, listeners,
    connect(sidecar: NotchSidecar) { for (const listener of listeners) listener(sidecar); },
  };
}

const capable: NotchSidecar = { id: 's1', name: 'desk', capabilities: ['pebble', NOTCH_CAPABILITY] };
const older: NotchSidecar = { id: 's2', name: 'old-desk', capabilities: ['pebble', 'windows'] };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('attachNotch', () => {
  // The invariant in docs/notch/README.md: off means the brain never mentions
  // the notch. This fails if the early return is removed, because the capable
  // sidecar below would then be sent notch.configure.
  test('with the switch off, registers nothing and sends nothing', async () => {
    const fake = fakePort();
    const lines: string[] = [];
    attachNotch(fake.port, { enabled: false, log: (line) => lines.push(line) });
    expect(fake.listeners).toHaveLength(0);
    fake.connect(capable);
    await settle();
    expect(fake.calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  test('with the switch on, tells a capable desktop app to host it, once per connect', async () => {
    const fake = fakePort();
    const lines: string[] = [];
    attachNotch(fake.port, { enabled: true, log: (line) => lines.push(line) });
    fake.connect(capable);
    await settle();
    expect(fake.calls).toEqual([{ sidecarId: 's1', method: 'notch.configure', params: { enabled: true } }]);
    expect(lines).toEqual(['[notch] switch on', '[notch] "desk" ready, surface: none']);
  });

  test('opens the window on a desktop app that says it has one, on the given page', async () => {
    const fake = fakePort(async () => ({ configured: true, enabled: true, surface: 'window' }));
    const lines: string[] = [];
    attachNotch(fake.port, { enabled: true, pageUrl: 'http://localhost:3143/api/notch/spike', log: (line) => lines.push(line) });
    fake.connect(capable);
    await settle();
    expect(fake.calls).toEqual([
      { sidecarId: 's1', method: 'notch.configure', params: { enabled: true } },
      { sidecarId: 's1', method: 'notch.spawn', params: { url: 'http://localhost:3143/api/notch/spike' } },
    ]);
    expect(lines.at(-1)).toBe('[notch] "desk" is showing the notch');
  });

  // A desktop app that only understands the switch must not be asked for a
  // window it cannot open: notch.spawn would come back METHOD_NOT_FOUND.
  test('does not ask for a window when the desktop app has no surface', async () => {
    const fake = fakePort(async () => ({ configured: true, enabled: true, surface: 'none' }));
    attachNotch(fake.port, { enabled: true, pageUrl: 'http://localhost:3143/api/notch/spike', log: () => {} });
    fake.connect(capable);
    await settle();
    expect(fake.calls.map((call) => call.method)).toEqual(['notch.configure']);
  });

  test('never sends notch.* to a desktop app that does not advertise the capability', async () => {
    const fake = fakePort();
    const lines: string[] = [];
    attachNotch(fake.port, { enabled: true, log: (line) => lines.push(line) });
    fake.connect(older);
    await settle();
    expect(fake.calls).toEqual([]);
    expect(lines[1]).toContain('"old-desk" cannot host the notch');
  });

  test('a refused notch.configure is reported, not thrown', async () => {
    const fake = fakePort(async () => { throw new Error('METHOD_NOT_FOUND'); });
    const lines: string[] = [];
    attachNotch(fake.port, { enabled: true, log: (line) => lines.push(line) });
    fake.connect(capable);
    await settle();
    expect(lines[1]).toBe('[notch] "desk" did not accept notch.configure: METHOD_NOT_FOUND');
  });
});
