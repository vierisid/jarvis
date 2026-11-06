import { describe, expect, test } from 'bun:test';
import { createSidecarOfflineNotifier, OFFLINE_NOTIFY_COOLDOWN_MS, OFFLINE_NOTIFY_GRACE_MS } from './sidecar-offline-notice.ts';

function harness(connectedOthers: () => boolean) {
  let clock = 1_000_000;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const sent: Array<Record<string, unknown>> = [];
  const n = createSidecarOfflineNotifier({
    notify: (p) => { const ok = connectedOthers(); if (ok) sent.push(p); return ok; },
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
  });
  const fire = () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); };
  return { n, sent, timers, fire, advance: (ms: number) => { clock += ms; } };
}

describe('sidecar offline notice', () => {
  test('a drop is told to the other machines after the grace period, naming the machine', () => {
    const h = harness(() => true);
    h.n.connected('a', 'Office Mac');
    h.n.disconnected('a');
    expect(h.timers[0]?.ms).toBe(OFFLINE_NOTIFY_GRACE_MS);
    h.fire();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ id: 'sidecar:a', kind: 'sidecar', title: 'Sidecar disconnected' });
    expect(String(h.sent[0]!.body)).toStartWith('Office Mac went offline.');
  });

  test('a quick reconnect cancels the notice', () => {
    const h = harness(() => true);
    h.n.connected('a', 'Office Mac');
    h.n.disconnected('a');
    h.n.connected('a', 'Office Mac');
    h.fire();
    expect(h.sent).toHaveLength(0);
  });

  test('a flapping machine is told about once per cooldown', () => {
    const h = harness(() => true);
    h.n.connected('a', 'Office Mac');
    h.n.disconnected('a');
    h.fire();
    h.advance(OFFLINE_NOTIFY_GRACE_MS + 1000);
    h.n.connected('a', 'Office Mac');
    h.n.disconnected('a');
    h.fire();
    expect(h.sent).toHaveLength(1);
    h.advance(OFFLINE_NOTIFY_COOLDOWN_MS);
    h.n.connected('a', 'Office Mac');
    h.n.disconnected('a');
    h.fire();
    expect(h.sent).toHaveLength(2);
  });

  // #1160: with no other machine connected the notice reached nobody, yet it
  // armed the cooldown, so the next drop (now with someone to tell) was silent.
  test('a notice nobody received does not arm the cooldown', () => {
    let others = false;
    const h = harness(() => others);
    h.n.connected('a', 'Office Mac');
    h.n.disconnected('a');
    h.fire();
    expect(h.sent).toHaveLength(0);

    h.advance(60_000);
    others = true; // a second machine is connected now
    h.n.connected('a', 'Office Mac');
    h.n.disconnected('a');
    expect(h.timers).toHaveLength(1);
    h.fire();
    expect(h.sent).toHaveLength(1);
  });
});
