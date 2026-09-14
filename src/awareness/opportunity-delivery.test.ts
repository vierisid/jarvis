import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { createCapture, getRecentSuggestions, markSuggestionActedOn, markSuggestionDelivered, markSuggestionDismissed } from '../vault/awareness.ts';
import { getOpportunityMetrics, recordOpportunityFeedback, refreshOpportunity } from './opportunities.ts';
import { OpportunityDelivery, type DeliverOpportunity } from './opportunity-delivery.ts';
import { AwarenessService } from './service.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { LLMManager } from '../llm/manager.ts';

const workers: OpportunityDelivery[] = [];
beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(async () => { await Promise.all(workers.splice(0).map(w => w.stop())); closeDb(); });

function proposal() {
  for (let days = 1; days <= 3; days++) {
    createCapture({ timestamp: Date.now() - days * 86_400_000, pixelChangePct: 0.5,
      appName: 'Accounting', windowTitle: 'Overdue invoices' });
  }
  return refreshOpportunity()!;
}
function worker(deliver: DeliverOpportunity, now = Date.now) {
  const w = new OpportunityDelivery(deliver, now);
  workers.push(w);
  return w;
}

test('proposal and pending delivery commit atomically', () => {
  getDb().run(`CREATE TRIGGER reject_delivery BEFORE INSERT ON opportunity_delivery
    BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END`);
  expect(() => proposal()).toThrow('outbox unavailable');
  expect(getRecentSuggestions()).toHaveLength(0);
  expect(getOpportunityMetrics().proposed).toBe(0);
  getDb().run('DROP TRIGGER reject_delivery');
  const item = refreshOpportunity()!;
  expect(getDb().query('SELECT opportunity_id, delivered_at FROM opportunity_delivery').get())
    .toEqual({ opportunity_id: item.id, delivered_at: null });
});

test('failed notification retries the same ID and records delivery only after acceptance', async () => {
  const item = proposal();
  let now = Date.now();
  const seen: string[] = [];
  const w = worker(async suggestion => {
    seen.push(suggestion.id);
    expect(suggestion.body).toBe(item.body);
    expect(getRecentSuggestions()[0]!.delivered).toBe(0);
    expect(getOpportunityMetrics().delivered).toBe(0);
    return seen.length === 1 ? null : 'websocket';
  }, () => now);
  await w.flush();
  await w.flush(); // retry cooldown
  expect(seen).toEqual([item.id]);
  now += 5 * 60_000;
  await w.flush();
  await w.flush(); // acknowledged transport is never retried
  expect(seen).toEqual([item.id, item.id]);
  expect(getRecentSuggestions()).toHaveLength(1);
  expect(getRecentSuggestions()[0]).toMatchObject({ delivered: 1, delivered_at: now, delivery_channel: 'websocket' });
  expect(getOpportunityMetrics().delivered).toBe(1);
});

test('a thrown transport error leaves the proposal pending for another worker', async () => {
  const item = proposal();
  const now = Date.now();
  const failed = worker(async () => { throw new Error('offline'); }, () => now);
  await failed.flush();
  await failed.stop();
  const seen: string[] = [];
  await worker(async suggestion => { seen.push(suggestion.id); return 'telegram'; }, () => now + 300_000).flush();
  expect(seen).toEqual([item.id]);
  expect(getOpportunityMetrics().delivered).toBe(1);
});

test.each(['dismiss', 'interest', 'validate'])('%s suppresses pending notification recovery', async action => {
  const item = proposal();
  if (action === 'dismiss') markSuggestionDismissed(item.id);
  if (action === 'interest') markSuggestionActedOn(item.id);
  if (action === 'validate') recordOpportunityFeedback(item.id, {
    requestId: 'confirmation', kind: 'validate', job: 'Review invoices', expectedOutcome: 'Checked list',
  });
  let calls = 0;
  await worker(async () => { calls++; return 'websocket'; }).flush();
  expect(calls).toBe(0);
  expect(getOpportunityMetrics().delivered).toBe(0);
});

test('legacy pre-callback flags cannot suppress recovery or inflate delivery metrics', async () => {
  const item = proposal();
  markSuggestionDelivered(item.id, 'websocket');
  expect(getOpportunityMetrics().delivered).toBe(0);
  const seen: string[] = [];
  await worker(async s => { seen.push(s.id); return 'desktop'; }).flush();
  expect(seen).toEqual([item.id]);
  expect(getRecentSuggestions()[0]!.delivery_channel).toBe('desktop');
  expect(getOpportunityMetrics().delivered).toBe(1);
});

test('concurrent workers and flush calls share a claim until its lease expires', async () => {
  const item = proposal();
  let resolve!: (channel: string) => void;
  let sends = 0;
  const now = Date.now();
  const first = worker(() => { sends++; return new Promise(r => { resolve = r; }); }, () => now);
  const flush = first.flush();
  expect(first.flush()).toBe(flush);
  await worker(async () => { sends++; return 'second'; }, () => now + 1).flush();
  expect(sends).toBe(1);
  // Simulate an abandoned claim after a crash. A stale completion must not
  // overwrite the receipt recorded by the recovery worker.
  await worker(async s => { expect(s.id).toBe(item.id); sends++; return 'recovered'; }, () => now + 120_001).flush();
  resolve('stale');
  await flush;
  expect(sends).toBe(2);
  expect(getRecentSuggestions()[0]!.delivery_channel).toBe('recovered');
});

function service(deliver: DeliverOpportunity) {
  return new AwarenessService({ awareness: {
    enabled: true, capture_interval_ms: 15000, min_change_threshold: 0.02,
    cloud_vision_enabled: false, cloud_vision_cooldown_ms: 30000,
    cloud_vision_ambient_cooldown_ms: 900000, stuck_threshold_ms: 300000,
    suggestion_rate_limit_ms: 60000, retention: { full_hours: 24, key_moment_hours: 72 },
    struggle_grace_ms: 120000, struggle_cooldown_ms: 180000, overlay_autolaunch: false,
  } } as JarvisConfig, {} as LLMManager, undefined, null, undefined, undefined, deliver);
}

test.each(['enable', 'disable', 'shutdown'])('pending delivery honors the last lifecycle request: %s', async lastRequest => {
  proposal();
  let finish!: (channel: string) => void;
  let sends = 0;
  const svc = service(() => { sends++; return new Promise(resolve => { finish = resolve; }); });
  await svc.start();
  try {
    expect(sends).toBe(1);
    svc.toggle(false);
    await Bun.sleep(0);
    expect(svc.status()).toBe('stopping');
    svc.toggle(true);
    if (lastRequest === 'disable') svc.toggle(false);
    const shutdown = lastRequest === 'shutdown' ? svc.stop() : undefined;
    finish('websocket');
    await shutdown;
    await Bun.sleep(0);
    expect(svc.isEnabled()).toBe(lastRequest !== 'disable');
    expect(svc.status()).toBe(lastRequest === 'enable' ? 'running' : 'stopped');
    // Exercise the public ingestion path, not just the status field. A resumed
    // service accepts captures; the latest disable or shutdown still blocks them.
    await svc.handleSidecarEvent('fixture-sidecar', {
      type: 'sidecar_event', event_type: 'screen_capture', timestamp: Date.now(),
      payload: { capture_id: 'after-toggle', image_path: '/fixture/capture.png',
        pixel_change_pct: 0.9, app_name: 'Editor', window_title: 'Notes', ocr_text: 'Notes' },
    });
    expect(getDb().query('SELECT COUNT(*) AS n FROM screen_captures').get())
      .toEqual({ n: lastRequest === 'enable' ? 4 : 3 });
    expect(sends).toBe(1);
  } finally { finish('websocket'); await svc.stop(); }
});

test('rapid toggles before queued work settles honor the final setting', async () => {
  const svc = service(async () => 'websocket');
  try {
    const starting = svc.start();
    svc.toggle(false);
    svc.toggle(true);
    await starting;
    await Bun.sleep(0);
    expect(svc.status()).toBe('running');
    svc.toggle(false);
    svc.toggle(true);
    svc.toggle(false);
    await Bun.sleep(0);
    expect(svc.isEnabled()).toBe(false);
    expect(svc.status()).toBe('stopped');
  } finally { await svc.stop(); }
});

test('a stop request blocks new capture events before queued shutdown begins', async () => {
  const svc = service(async () => 'websocket');
  await svc.start();
  try {
    const stopping = svc.stop();
    await svc.handleSidecarEvent('fixture-sidecar', {
      type: 'sidecar_event', event_type: 'screen_capture', timestamp: Date.now(),
      payload: { capture_id: 'during-stop', image_path: '/fixture/capture.png',
        pixel_change_pct: 0.9, app_name: 'Editor', window_title: 'Notes', ocr_text: 'Notes' },
    });
    await stopping;
    expect(getDb().query('SELECT COUNT(*) AS n FROM screen_captures').get()).toEqual({ n: 0 });
    expect(svc.status()).toBe('stopped');
  } finally { await svc.stop(); }
});
