import { describe, expect, test } from 'bun:test';
import type { JarvisConfig } from '../config/types.ts';
import type { HostedUsageMeter } from './hosted-usage.ts';
import { UsageAlertsService, USAGE_NOTIFY_KIND } from './usage-alerts-service.ts';
import { alertKey, FLAG_PREFIX } from './usage-alerts.ts';

const SESSION_RESET = '2026-08-26T12:00:00.000Z';

const meter = (over: Partial<HostedUsageMeter> = {}): HostedUsageMeter => ({
  entitled: true,
  blocked: false,
  sessionPct: 10,
  weekPct: 10,
  sessionResetsAt: SESSION_RESET,
  weekResetsAt: '2026-08-31T00:00:00.000Z',
  ...over,
});

function harness(
  reading: HostedUsageMeter | null,
  opts: { canNotify?: boolean; seeded?: Record<string, string> } = {},
) {
  const rows = new Map<string, string>(Object.entries(opts.seeded ?? {}));
  const sent: Record<string, unknown>[] = [];
  let reads = 0;
  const svc = new UsageAlertsService({
    getConfig: () => ({}) as JarvisConfig,
    notify: (p) => sent.push(p),
    canNotify: () => opts.canNotify !== false,
    readMeter: async () => {
      reads += 1;
      return reading;
    },
    store: {
      get: (k) => rows.get(k) ?? null,
      set: (k, v) => void rows.set(k, v),
      keys: () => [...rows.keys()],
      delete: (k) => void rows.delete(k),
    },
    now: () => 1_000,
  });
  return { svc, sent, rows, reads: () => reads };
}

describe('the threshold check', () => {
  test('notifies once and does not repeat on the next pass', async () => {
    const h = harness(meter({ sessionPct: 80 }));
    expect(await h.svc.check()).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    expect(await h.svc.check()).toEqual([]);
    expect(h.sent).toHaveLength(1);
  });

  test('sends the fifth notification kind, with somewhere to look and nothing to decide', async () => {
    const h = harness(meter({ weekPct: 100 }));
    await h.svc.check();
    const [payload] = h.sent as Array<{ kind: string; destructive: boolean; actions: { id: string }[]; body: string }>;
    expect(payload!.kind).toBe(USAGE_NOTIFY_KIND);
    expect(payload!.destructive).toBe(false);
    // No Approve/Deny: there is no decision here, only a place to look.
    expect(payload!.actions.map((a) => a.id)).toEqual(['review', 'dismiss']);
    expect(payload!.body).toContain('this week');
  });

  test('the flag is written BEFORE the notify, so a throwing sidecar cannot loop', async () => {
    // A notify that throws with the flag unset would re-send the same toast
    // every 15 minutes for the life of the window.
    const rows = new Map<string, string>();
    const svc = new UsageAlertsService({
      getConfig: () => ({}) as JarvisConfig,
      notify: () => { throw new Error('sidecar went away mid-dispatch'); },
      canNotify: () => true,
      readMeter: async () => meter({ sessionPct: 80 }),
      store: {
        get: (k) => rows.get(k) ?? null,
        set: (k, v) => void rows.set(k, v),
        keys: () => [...rows.keys()],
        delete: (k) => void rows.delete(k),
      },
    });
    await expect(svc.check()).rejects.toThrow('sidecar went away');
    expect(rows.has(alertKey('session', 75, SESSION_RESET))).toBe(true);
  });

  test('with NO sidecar connected the flag is left unset, so the warning still lands later', async () => {
    // Consuming the once-per-window flag against a closed door would mean a
    // user who opens their laptop at 90% is never told.
    const h = harness(meter({ sessionPct: 80 }), { canNotify: false });
    expect(await h.svc.check()).toEqual([]);
    expect(h.rows.size).toBe(0);
    expect(h.sent).toEqual([]);
  });

  test('a self-hosted install reads null and does nothing at all', async () => {
    const h = harness(null);
    expect(await h.svc.check()).toEqual([]);
    expect(h.rows.size).toBe(0);
  });

  test('overlapping passes cannot double-notify', async () => {
    // The read is a network round trip; two passes deciding before either
    // records would send the same toast twice.
    const h = harness(meter({ sessionPct: 80 }));
    const [a, b] = await Promise.all([h.svc.check(), h.svc.check()]);
    expect([a.length, b.length].sort()).toEqual([0, 1]);
    expect(h.sent).toHaveLength(1);
  });

  test('prunes flags from windows that have rolled, and leaves other settings alone', async () => {
    const h = harness(meter({ sessionPct: 80 }), {
      seeded: {
        [alertKey('session', 75, '2026-08-26T06:00:00.000Z')]: '1',
        [`${FLAG_PREFIX}blocked.2026-01-01T00:00:00.000Z`]: '1',
      },
    });
    await h.svc.check();
    expect([...h.rows.keys()]).toEqual([alertKey('session', 75, SESSION_RESET)]);
  });
});
