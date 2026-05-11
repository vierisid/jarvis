import { test, expect, describe, beforeEach } from 'bun:test';
import { initDatabase } from '../vault/schema.ts';
import { ContextTracker } from './context-tracker.ts';
import { SuggestionEngine } from './suggestion-engine.ts';
import { ContextGraph } from './context-graph.ts';
import type { AwarenessConfig } from '../config/types.ts';
import type { AwarenessEvent, ScreenContext } from './types.ts';
import {
  createCapture,
  getCapture,
  getRecentCaptures,
  getCapturesInRange,
  getAppUsageStats,
  createSession,
  getSession,
  updateSession,
  endSession,
  getRecentSessions,
  incrementSessionCaptureCount,
  createSuggestion,
  getRecentSuggestions,
  markSuggestionDismissed,
  markSuggestionActedOn,
  getSuggestionStats,
  getSuggestionCountSince,
} from '../vault/awareness.ts';

const testConfig: AwarenessConfig = {
  enabled: true,
  capture_interval_ms: 5000,
  min_change_threshold: 0.02,
  cloud_vision_enabled: false,
  cloud_vision_cooldown_ms: 30000,
  stuck_threshold_ms: 5000, // 5s for tests
  suggestion_rate_limit_ms: 100, // fast for tests
  retention: { full_hours: 1, key_moment_hours: 24 },
  struggle_grace_ms: 120000,
  struggle_cooldown_ms: 180000,
  overlay_autolaunch: false,
};

describe('Vault — Screen Captures', () => {
  beforeEach(() => initDatabase(':memory:'));

  test('createCapture + getCapture', () => {
    const row = createCapture({
      timestamp: Date.now(),
      pixelChangePct: 0.15,
      appName: 'VS Code',
      windowTitle: 'index.ts - jarvis - Visual Studio Code',
      ocrText: 'function hello() { return "world"; }',
    });
    expect(row.id).toBeTruthy();
    expect(row.app_name).toBe('VS Code');
    expect(row.pixel_change_pct).toBe(0.15);

    const fetched = getCapture(row.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.ocr_text).toContain('hello');
  });

  test('createCapture persists sidecarId for fetch_capture routing', () => {
    const row = createCapture({
      timestamp: Date.now(),
      pixelChangePct: 0.2,
      sidecarId: 'sidecar-abc-123',
      imagePath: '/home/user/.jarvis/captures/2026-05-11/12-00-00.png',
      appName: 'Terminal',
    });
    expect(row.sidecar_id).toBe('sidecar-abc-123');

    const fetched = getCapture(row.id);
    expect(fetched!.sidecar_id).toBe('sidecar-abc-123');
    expect(fetched!.image_path).toBe('/home/user/.jarvis/captures/2026-05-11/12-00-00.png');
  });

  test('createCapture without sidecarId stores null (legacy rows)', () => {
    const row = createCapture({
      timestamp: Date.now(),
      pixelChangePct: 0.1,
      appName: 'Legacy',
    });
    expect(row.sidecar_id).toBeNull();
    expect(getCapture(row.id)!.sidecar_id).toBeNull();
  });

  test('getRecentCaptures with app filter', () => {
    createCapture({ timestamp: Date.now() - 2000, pixelChangePct: 0.1, appName: 'Chrome' });
    createCapture({ timestamp: Date.now() - 1000, pixelChangePct: 0.2, appName: 'VS Code' });
    createCapture({ timestamp: Date.now(), pixelChangePct: 0.3, appName: 'Chrome' });

    const all = getRecentCaptures(10);
    expect(all.length).toBe(3);

    const chromeOnly = getRecentCaptures(10, 'Chrome');
    expect(chromeOnly.length).toBe(2);
    expect(chromeOnly.every(c => c.app_name === 'Chrome')).toBe(true);
  });

  test('getCapturesInRange', () => {
    const now = Date.now();
    createCapture({ timestamp: now - 60000, pixelChangePct: 0.1, appName: 'A' });
    createCapture({ timestamp: now - 30000, pixelChangePct: 0.2, appName: 'B' });
    createCapture({ timestamp: now, pixelChangePct: 0.3, appName: 'C' });

    const range = getCapturesInRange(now - 40000, now - 10000);
    expect(range.length).toBe(1);
    expect(range[0]!.app_name).toBe('B');
  });

  test('getAppUsageStats', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      createCapture({ timestamp: now - i * 1000, pixelChangePct: 0.1, appName: 'Chrome' });
    }
    for (let i = 0; i < 3; i++) {
      createCapture({ timestamp: now - i * 1000, pixelChangePct: 0.1, appName: 'VS Code' });
    }

    const stats = getAppUsageStats(now - 10000, now + 1000);
    expect(stats.length).toBe(2);
    expect(stats[0]!.app).toBe('Chrome');
    expect(stats[0]!.captureCount).toBe(5);
    expect(stats[1]!.app).toBe('VS Code');
  });
});

describe('Vault — Awareness Sessions', () => {
  beforeEach(() => initDatabase(':memory:'));

  test('create + get + update + end session', () => {
    const session = createSession({ startedAt: Date.now(), apps: ['Chrome', 'VS Code'] });
    expect(session.id).toBeTruthy();
    expect(session.ended_at).toBeNull();

    const fetched = getSession(session.id);
    expect(fetched).not.toBeNull();
    expect(JSON.parse(fetched!.apps)).toEqual(['Chrome', 'VS Code']);

    updateSession(session.id, { topic: 'Coding session', capture_count: 10 });
    const updated = getSession(session.id);
    expect(updated!.topic).toBe('Coding session');
    expect(updated!.capture_count).toBe(10);

    endSession(session.id, 'Productive coding');
    const ended = getSession(session.id);
    expect(ended!.ended_at).not.toBeNull();
    expect(ended!.summary).toBe('Productive coding');
  });

  test('incrementSessionCaptureCount', () => {
    const session = createSession({ startedAt: Date.now() });
    incrementSessionCaptureCount(session.id);
    incrementSessionCaptureCount(session.id);
    incrementSessionCaptureCount(session.id);

    const updated = getSession(session.id);
    expect(updated!.capture_count).toBe(3);
  });

  test('getRecentSessions', () => {
    createSession({ startedAt: Date.now() - 3000 });
    createSession({ startedAt: Date.now() - 2000 });
    createSession({ startedAt: Date.now() - 1000 });

    const sessions = getRecentSessions(2);
    expect(sessions.length).toBe(2);
  });
});

describe('Vault — Awareness Suggestions', () => {
  beforeEach(() => initDatabase(':memory:'));

  test('create + dismiss + act on suggestions', () => {
    const s = createSuggestion({
      type: 'error',
      title: 'Error in VS Code',
      body: 'TypeScript compilation error detected',
      context: { appName: 'VS Code' },
    });
    expect(s.id).toBeTruthy();
    expect(s.dismissed).toBe(0);
    expect(s.acted_on).toBe(0);

    markSuggestionDismissed(s.id);
    const recent = getRecentSuggestions(1);
    expect(recent[0]!.dismissed).toBe(1);

    const s2 = createSuggestion({ type: 'stuck', title: 'Stuck', body: 'You seem stuck' });
    markSuggestionActedOn(s2.id);
    const all = getRecentSuggestions(10);
    expect(all.find(x => x.id === s2.id)!.acted_on).toBe(1);
  });

  test('getSuggestionStats', () => {
    const now = Date.now();
    createSuggestion({ type: 'error', title: 'E1', body: 'b' });
    const s2 = createSuggestion({ type: 'stuck', title: 'E2', body: 'b' });
    markSuggestionActedOn(s2.id);

    const stats = getSuggestionStats(now - 10000, now + 10000);
    expect(stats.total).toBe(2);
    expect(stats.actedOn).toBe(1);
  });

  test('getSuggestionCountSince', () => {
    const before = Date.now() - 1000;
    createSuggestion({ type: 'general', title: 'T', body: 'B' });
    createSuggestion({ type: 'general', title: 'T2', body: 'B2' });

    expect(getSuggestionCountSince(before)).toBe(2);
    expect(getSuggestionCountSince(Date.now() + 10000)).toBe(0);
  });
});

describe('ContextTracker', () => {
  beforeEach(() => initDatabase(':memory:'));

  test('detects context changes', () => {
    const tracker = new ContextTracker(testConfig);

    // First capture
    const r1 = tracker.processCapture('cap-1', 'some text', 'index.ts - VS Code');
    expect(r1.context.appName).toBe('VS Code');
    expect(r1.events.some(e => e.type === 'session_started')).toBe(true);

    // Same app — no context change
    const r2 = tracker.processCapture('cap-2', 'more text', 'utils.ts - VS Code');
    expect(r2.context.appName).toBe('VS Code');

    // Different app — context change
    const r3 = tracker.processCapture('cap-3', 'google.com', 'Google - Chrome');
    expect(r3.context.appName).toBe('Chrome');
    expect(r3.events.some(e => e.type === 'context_changed')).toBe(true);
  });

  test('detects errors in OCR text', () => {
    const tracker = new ContextTracker(testConfig);

    const r = tracker.processCapture('cap-1', 'Compilation error: module not found. Build failed at line 42', 'app.js - VS Code');
    expect(r.events.some(e => e.type === 'error_detected')).toBe(true);
  });

  test('detects stuck state', () => {
    const tracker = new ContextTracker(testConfig);

    // First capture
    tracker.processCapture('cap-1', 'same text here', 'Page - Browser');

    // Simulate time passing (>5s with same text)
    const originalNow = Date.now;
    Date.now = () => originalNow() + 6000;

    const r2 = tracker.processCapture('cap-2', 'same text here', 'Page - Browser');
    expect(r2.events.some(e => e.type === 'stuck_detected')).toBe(true);

    Date.now = originalNow;
  });

  test('extracts app name from window title', () => {
    const tracker = new ContextTracker(testConfig);

    const r1 = tracker.processCapture('1', '', 'index.ts - Visual Studio Code');
    expect(r1.context.appName).toBe('Visual Studio Code');

    const r2 = tracker.processCapture('2', '', 'Google - Mozilla Firefox');
    expect(r2.context.appName).toBe('Mozilla Firefox');
  });

  test('uses sidecar capturedAt timestamp when provided', () => {
    const tracker = new ContextTracker(testConfig);

    const sidecarTimestamp = 1700000000000; // arbitrary past timestamp
    const r = tracker.processCapture('1', 'hello', 'win - App', sidecarTimestamp);

    expect(r.context.timestamp).toBe(sidecarTimestamp);
    // Session start should also reflect sidecar time, not Date.now().
    const sessionStart = r.events.find(e => e.type === 'session_started');
    expect(sessionStart?.timestamp).toBe(sidecarTimestamp);
  });

  test('falls back to Date.now() when capturedAt omitted', () => {
    const tracker = new ContextTracker(testConfig);

    const before = Date.now();
    const r = tracker.processCapture('1', 'hello', 'win - App');
    const after = Date.now();

    expect(r.context.timestamp).toBeGreaterThanOrEqual(before);
    expect(r.context.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('SuggestionEngine', () => {
  beforeEach(() => initDatabase(':memory:'));

  test('generates error suggestion', async () => {
    const engine = new SuggestionEngine(0); // no rate limit for test

    const context: ScreenContext = {
      captureId: 'cap-1',
      timestamp: Date.now(),
      appName: 'VS Code',
      windowTitle: 'test.ts - VS Code',
      url: null,
      filePath: null,
      ocrText: 'TypeError: undefined',
      sessionId: 'sess-1',
      isSignificantChange: false,
    };

    const events: AwarenessEvent[] = [{
      type: 'error_detected',
      data: { errorText: 'TypeError', errorContext: 'undefined is not a function', appName: 'VS Code' },
      timestamp: Date.now(),
    }];

    const suggestion = await engine.evaluate(context, events);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.type).toBe('error');
    expect(suggestion!.title).toContain('VS Code');
  });

  test('deduplicates suggestions', async () => {
    const engine = new SuggestionEngine(0);

    const context: ScreenContext = {
      captureId: 'cap-1',
      timestamp: Date.now(),
      appName: 'VS Code',
      windowTitle: 'test.ts - VS Code',
      url: null,
      filePath: null,
      ocrText: 'error',
      sessionId: 'sess-1',
      isSignificantChange: false,
    };

    const events: AwarenessEvent[] = [{
      type: 'error_detected',
      data: { errorText: 'error', errorContext: 'some error', appName: 'VS Code' },
      timestamp: Date.now(),
    }];

    const s1 = await engine.evaluate(context, events);
    expect(s1).not.toBeNull();

    // Same suggestion should be deduped
    const s2 = await engine.evaluate(context, events);
    expect(s2).toBeNull();
  });
});

describe('ContextGraph', () => {
  beforeEach(() => initDatabase(':memory:'));

  test('creates app entity for new apps', () => {
    const graph = new ContextGraph();
    const { searchEntitiesByName } = require('../vault/entities.ts');

    const context: ScreenContext = {
      captureId: 'cap-1',
      timestamp: Date.now(),
      appName: 'Visual Studio Code',
      windowTitle: 'test.ts - Visual Studio Code',
      url: null,
      filePath: null,
      ocrText: 'some code here',
      sessionId: 'sess-1',
      isSignificantChange: false,
    };

    graph.linkCaptureToEntities(context);

    const entities = searchEntitiesByName('Visual Studio Code');
    expect(entities.length).toBeGreaterThan(0);
    expect(entities[0].type).toBe('tool');
  });
});
