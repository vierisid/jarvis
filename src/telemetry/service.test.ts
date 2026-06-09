import { describe, expect, test } from 'bun:test';
import { TelemetryService, type Sender } from './service.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { SendOutcome } from './client.ts';

// Minimal config stand-in; the service only reads `telemetry`.
const cfg = (enabled: boolean): JarvisConfig => ({ telemetry: { enabled } }) as unknown as JarvisConfig;

// A sender that records calls; never touches the network.
function recordingSender() {
  const calls: unknown[] = [];
  const fn: Sender = async (p) => {
    calls.push(p);
    return { ok: true, status: 201 } as SendOutcome;
  };
  return { fn, calls };
}

describe('TelemetryService lifecycle', () => {
  test('disabled config: start() resolves running, sends nothing', async () => {
    const { fn, calls } = recordingSender();
    const svc = new TelemetryService({ config: cfg(false), packageRoot: process.cwd(), sender: fn });
    await svc.start();
    expect(svc.status()).toBe('running');
    expect(calls.length).toBe(0);
    await svc.stop();
    expect(svc.status()).toBe('stopped');
  });

  test('enabled: start() fires exactly one startup ping', async () => {
    const { fn, calls } = recordingSender();
    const svc = new TelemetryService({ config: cfg(true), packageRoot: process.cwd(), sender: fn, debug: false });
    await svc.start();
    // Let the fire-and-forget startup ping settle.
    await Bun.sleep(10);
    expect(svc.status()).toBe('running');
    expect(calls.length).toBe(1);
    await svc.stop();
  });

  test('start() never throws even when the sender throws', async () => {
    const throwing: Sender = async () => {
      throw new Error('sender exploded');
    };
    const svc = new TelemetryService({ config: cfg(true), packageRoot: process.cwd(), sender: throwing });
    // The whole point: a broken send path must not propagate out of start().
    await expect(svc.start()).resolves.toBeUndefined();
    await Bun.sleep(10);
    expect(svc.status()).toBe('running');
    await svc.stop();
  });

  test('stop() is safe to call when never started', async () => {
    const svc = new TelemetryService({ config: cfg(true), packageRoot: process.cwd(), sender: async () => ({ ok: true }) });
    await expect(svc.stop()).resolves.toBeUndefined();
  });
});
