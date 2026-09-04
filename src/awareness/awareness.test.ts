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
  activeMsFrom,
  activeMinutesFrom,
  MAX_CAPTURE_GAP_MS,
} from '../vault/awareness.ts';
import { AwarenessIntelligence } from './intelligence.ts';

const testConfig: AwarenessConfig = {
  enabled: true,
  capture_interval_ms: 5000,
  min_change_threshold: 0.02,
  cloud_vision_enabled: false,
  cloud_vision_cooldown_ms: 30000,
  cloud_vision_ambient_cooldown_ms: 900000,
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

  test('getAppUsageStats attributes elapsed time, not capture count', () => {
    const start = Date.now() - 60 * 60 * 1000;
    // 20 min in Chrome, then 10 min in VS Code, sampled every 30s.
    let t = start;
    for (; t < start + 20 * 60 * 1000; t += 30000) {
      createCapture({ timestamp: t, pixelChangePct: 0.1, appName: 'Chrome' });
    }
    for (; t < start + 30 * 60 * 1000; t += 30000) {
      createCapture({ timestamp: t, pixelChangePct: 0.1, appName: 'VS Code' });
    }

    const stats = getAppUsageStats(start - 1000, t);
    expect(stats.length).toBe(2);
    expect(stats[0]!.app).toBe('Chrome');
    expect(stats[0]!.minutes).toBe(20);
    expect(stats[1]!.app).toBe('VS Code');
    expect(stats[1]!.minutes).toBe(10);
    // The switch-over gap is credited to the app that was on screen when it
    // opened, so Chrome holds 20min of 29.5min measured.
    expect(stats[0]!.percentage).toBe(68);
  });

  test('getAppUsageStats is unmoved by a denser sampling rate', () => {
    const start = Date.now() - 60 * 60 * 1000;
    // Same 10 minutes of Chrome, sampled 3x more often. Counting rows would
    // report 3x the time; counting elapsed gaps reports the same 10 minutes.
    for (let t = start; t <= start + 10 * 60 * 1000; t += 10000) {
      createCapture({ timestamp: t, pixelChangePct: 0.1, appName: 'Chrome' });
    }

    const stats = getAppUsageStats(start - 1000, start + 11 * 60 * 1000);
    expect(stats[0]!.minutes).toBe(10);
  });

  test('activeMsFrom caps away-from-keyboard gaps', () => {
    const t0 = Date.now();
    // Two 30s gaps around a 4h absence: the absence must not count as work.
    const captures = [
      { timestamp: t0 },
      { timestamp: t0 + 30000 },
      { timestamp: t0 + 30000 + 4 * 60 * 60 * 1000 },
      { timestamp: t0 + 60000 + 4 * 60 * 60 * 1000 },
    ];
    expect(activeMsFrom(captures)).toBe(30000 + MAX_CAPTURE_GAP_MS + 30000);
    expect(activeMinutesFrom([{ timestamp: t0 }])).toBe(0);
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
      isAppSwitch: false,
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
      isAppSwitch: false,
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
      isAppSwitch: false,
    };

    graph.linkCaptureToEntities(context);

    const entities = searchEntitiesByName('Visual Studio Code');
    expect(entities.length).toBeGreaterThan(0);
    expect(entities[0].type).toBe('tool');
  });
});

describe('AwarenessIntelligence — escalation gate', () => {
  const ctx = (over: Partial<ScreenContext> = {}): ScreenContext => ({
    captureId: 'cap-1',
    timestamp: Date.now(),
    appName: 'Chrome',
    windowTitle: 'Some page — Chrome',
    url: null,
    filePath: null,
    ocrText: 'a screen with plenty of text on it',
    sessionId: 'sess-1',
    isSignificantChange: false,
    isAppSwitch: false,
    ...over,
  });

  const ev = (type: AwarenessEvent['type']): AwarenessEvent => ({ type, data: {}, timestamp: Date.now() });

  // No LLM calls happen in claimEscalation, so the manager is never touched.
  const intel = (cooldownMs: number, ambientMs: number) =>
    new AwarenessIntelligence(null as never, cooldownMs, ambientMs);

  test('a quiet capture never escalates', () => {
    const i = intel(0, 0);
    expect(i.claimEscalation(ctx(), [])).toBeNull();
  });

  test('a window title change alone never escalates', () => {
    // isSignificantChange is true for title-only churn (browser tabs, editor
    // files). That used to be enough to bill a vision call every cooldown.
    const i = intel(0, 0);
    expect(i.claimEscalation(ctx({ isSignificantChange: true }), [])).toBeNull();
  });

  test('short OCR alone never escalates', () => {
    const i = intel(0, 0);
    expect(i.claimEscalation(ctx({ ocrText: '' }), [])).toBeNull();
  });

  test('local signals escalate and pick the matching analysis', () => {
    expect(intel(0, 0).claimEscalation(ctx(), [ev('struggle_detected')])?.kind).toBe('struggle');
    expect(intel(0, 0).claimEscalation(ctx(), [ev('error_detected')])?.kind).toBe('general');
    expect(intel(0, 0).claimEscalation(ctx(), [ev('stuck_detected')])?.kind).toBe('general');
    expect(
      intel(0, 0).claimEscalation(ctx({ isAppSwitch: true }), [ev('error_detected')])?.kind
    ).toBe('delta');
  });

  test('an app switch escalates ambiently, then is silenced by its own cooldown', () => {
    const i = intel(0, 60_000);
    expect(i.claimEscalation(ctx({ isAppSwitch: true }), [])?.kind).toBe('delta');
    expect(i.claimEscalation(ctx({ isAppSwitch: true }), [])).toBeNull();
  });

  test('a claim stamps the cooldown immediately, before any analysis runs', () => {
    // The service awaits an image fetch between claiming and calling. Two
    // captures racing through that gap must not both bill.
    const i = intel(60_000, 60_000);
    expect(i.claimEscalation(ctx(), [ev('error_detected')])?.kind).toBe('general');
    expect(i.claimEscalation(ctx(), [ev('error_detected')])).toBeNull();
  });

  test('an ambient claim also holds off signal escalations', () => {
    const i = intel(60_000, 900_000);
    expect(i.claimEscalation(ctx({ isAppSwitch: true }), [])?.kind).toBe('delta');
    expect(i.claimEscalation(ctx(), [ev('struggle_detected')])).toBeNull();
  });

  test('cloud vision disabled (Infinity cooldown) never escalates', () => {
    const i = intel(Infinity, Infinity);
    expect(i.claimEscalation(ctx({ isAppSwitch: true }), [ev('struggle_detected')])).toBeNull();
  });

  test('releasing an unused claim frees the cooldown again', () => {
    // The screenshot fetch can fail after the claim (sidecar gone, file
    // pruned). Nothing was billed, so the next real signal must not be eaten.
    const i = intel(60_000, 900_000);
    const first = i.claimEscalation(ctx(), [ev('error_detected')]);
    expect(first?.kind).toBe('general');
    i.releaseEscalation(first!.token);
    expect(i.claimEscalation(ctx(), [ev('error_detected')])?.kind).toBe('general');
  });

  test('releasing restores the ambient cooldown too, and only once', () => {
    const i = intel(0, 900_000);
    const first = i.claimEscalation(ctx({ isAppSwitch: true }), []);
    expect(first?.kind).toBe('delta');
    i.releaseEscalation(first!.token);
    i.releaseEscalation(first!.token); // second release is a no-op, not a second rollback
    expect(i.claimEscalation(ctx({ isAppSwitch: true }), [])?.kind).toBe('delta');
    expect(i.claimEscalation(ctx({ isAppSwitch: true }), [])).toBeNull();
  });

  test('a stale release cannot reopen a newer claim', () => {
    // Captures are processed concurrently: a slow fetch can fail long after a
    // later capture has claimed and is mid-call. Rolling the cooldown back
    // there would let a third capture bill inside the same window.
    const i = intel(60_000, 900_000);
    const stale = i.claimEscalation(ctx(), [ev('error_detected')]);
    expect(stale?.kind).toBe('general');
    i.releaseEscalation(stale!.token); // its fetch failed, cooldown handed back
    const current = i.claimEscalation(ctx(), [ev('error_detected')]);
    expect(current?.kind).toBe('general');

    // The stale token must no longer own anything.
    i.releaseEscalation(stale!.token);
    expect(i.claimEscalation(ctx(), [ev('error_detected')])).toBeNull();
  });

  test('a low tier that cannot see falls back to medium, then stays there', async () => {
    const calls: string[] = [];
    const llm = {
      chatTier: async (tier: string) => {
        calls.push(tier);
        if (tier === 'low') throw new Error('400 model does not support image input');
        return { content: 'a description of the screen' };
      },
    };
    const i = new AwarenessIntelligence(llm as never, 0, 0);

    expect(await i.analyzeGeneral('aGk=', ctx())).toBe('a description of the screen');
    expect(calls).toEqual(['low', 'medium']);

    // The tier is sticky — no second doomed low-tier attempt.
    expect(await i.analyzeGeneral('aGk=', ctx())).toBe('a description of the screen');
    expect(calls).toEqual(['low', 'medium', 'medium']);
  });

  test('a vision failure on both tiers degrades to an empty analysis', async () => {
    const llm = { chatTier: async () => { throw new Error('upstream down'); } };
    const i = new AwarenessIntelligence(llm as never, 0, 0);
    expect(await i.analyzeGeneral('aGk=', ctx())).toBe('');
  });
});

describe('ContextTracker — redundant captures', () => {
  beforeEach(() => initDatabase(':memory:'));

  test('flags a repeat capture with identical OCR text as redundant', () => {
    const tracker = new ContextTracker(testConfig);
    const t0 = Date.now();

    const first = tracker.processCapture('c1', 'the same screen text', 'Notes — Bear', t0);
    expect(first.isRedundant).toBe(false); // first capture in a window

    const second = tracker.processCapture('c2', 'the same screen text', 'Notes — Bear', t0 + 1000);
    expect(second.isRedundant).toBe(true);

    const changed = tracker.processCapture('c3', 'now it says something else', 'Notes — Bear', t0 + 2000);
    expect(changed.isRedundant).toBe(false);
  });

  test('a window change is never redundant', () => {
    const tracker = new ContextTracker(testConfig);
    const t0 = Date.now();

    tracker.processCapture('c1', 'identical text', 'Notes — Bear', t0);
    const switched = tracker.processCapture('c2', 'identical text', 'index.ts — Visual Studio Code', t0 + 1000);
    expect(switched.isRedundant).toBe(false);
    expect(switched.context.isAppSwitch).toBe(true);
  });

  test('isAppSwitch ignores title-only churn', () => {
    const tracker = new ContextTracker(testConfig);
    const t0 = Date.now();

    tracker.processCapture('c1', 'first tab', 'Docs — Google Chrome', t0);
    const retitled = tracker.processCapture('c2', 'second tab', 'Mail — Google Chrome', t0 + 1000);
    expect(retitled.context.isSignificantChange).toBe(true);
    expect(retitled.context.isAppSwitch).toBe(false);
  });
});

describe('SuggestionEngine — break nudge', () => {
  beforeEach(() => initDatabase(':memory:'));

  const quietContext = (): ScreenContext => ({
    captureId: 'cap-break',
    timestamp: Date.now(),
    appName: 'Figma',
    windowTitle: 'Untitled — Figma',
    url: null,
    filePath: null,
    ocrText: 'a canvas with some shapes on it',
    sessionId: 'sess-break',
    isSignificantChange: false,
    isAppSwitch: false,
  });

  test('fires after 90 minutes of activity regardless of capture rate', async () => {
    const now = Date.now();
    // 90 minutes sampled every 30s — far fewer rows than the old count
    // threshold (700) expected, but the same 90 minutes of elapsed work.
    for (let t = now - 90 * 60 * 1000; t <= now; t += 30000) {
      createCapture({ timestamp: t, pixelChangePct: 0.1, appName: 'Figma' });
    }

    const engine = new SuggestionEngine(0);
    const suggestion = await engine.evaluate(quietContext(), []);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.type).toBe('break');
    expect(suggestion!.context!.minutesActive).toBeGreaterThanOrEqual(70);
  });

  test('does not fire for a short stretch of work', async () => {
    const now = Date.now();
    for (let t = now - 20 * 60 * 1000; t <= now; t += 30000) {
      createCapture({ timestamp: t, pixelChangePct: 0.1, appName: 'Figma' });
    }

    const engine = new SuggestionEngine(0);
    expect(await engine.evaluate(quietContext(), [])).toBeNull();
  });

  test('still fires for a reader whose screen goes static in stretches', async () => {
    const now = Date.now();
    // 90 minutes at the desk, but three 5-minute stretches of a static screen
    // send no captures at all. Each is credited only MAX_CAPTURE_GAP_MS, so
    // ~12 minutes of real desk time is uncountable — the threshold has to
    // leave room for that or the nudge never reaches anyone who reads.
    const start = now - 90 * 60 * 1000;
    const staticFrom = [20, 45, 70].map(m => start + m * 60 * 1000);
    const isStatic = (t: number) => staticFrom.some(s => t > s && t < s + 5 * 60 * 1000);
    for (let t = start; t <= now; t += 30000) {
      if (isStatic(t)) continue;
      createCapture({ timestamp: t, pixelChangePct: 0.1, appName: 'Preview' });
    }

    const engine = new SuggestionEngine(0);
    const suggestion = await engine.evaluate(quietContext(), []);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.type).toBe('break');
    // Pins the scenario: countable time really is short of the 90 it spans.
    expect(suggestion!.context!.minutesActive as number).toBeLessThan(80);
  });

  test('does not count an idle stretch as work', async () => {
    const now = Date.now();
    // Two brief bursts three hours apart: elapsed wall-clock is long, actual
    // time at the machine is not.
    for (let t = now - 3 * 60 * 60 * 1000; t <= now - 3 * 60 * 60 * 1000 + 60000; t += 30000) {
      createCapture({ timestamp: t, pixelChangePct: 0.1, appName: 'Figma' });
    }
    for (let t = now - 60000; t <= now; t += 30000) {
      createCapture({ timestamp: t, pixelChangePct: 0.1, appName: 'Figma' });
    }

    const engine = new SuggestionEngine(0);
    expect(await engine.evaluate(quietContext(), [])).toBeNull();
  });
});

describe('Vision tier downgrade is only for a real refusal', () => {
  const ctx = (): ScreenContext => ({
    captureId: 'c', timestamp: Date.now(), appName: 'Chrome', windowTitle: 'w',
    url: null, filePath: null, ocrText: 'text', sessionId: 's',
    isSignificantChange: false, isAppSwitch: false,
  });

  test('a transient failure does not abandon the low tier', async () => {
    const { LLMProviderError } = require('../llm/provider.ts');
    const calls: string[] = [];
    let failNext = true;
    const llm = {
      chatTier: async (tier: string) => {
        calls.push(tier);
        if (failNext) {
          failNext = false;
          throw new LLMProviderError('429 rate limit exceeded', 'rate_limit');
        }
        return { content: 'ok' };
      },
    };
    const i = new AwarenessIntelligence(llm as never, 0, 0);

    // The blip degrades this one call...
    expect(await i.analyzeGeneral('aGk=', ctx())).toBe('');
    // ...but must not hand every future call to the expensive tier.
    expect(await i.analyzeGeneral('aGk=', ctx())).toBe('ok');
    expect(calls).toEqual(['low', 'low']);
  });

  test('a 500 does not abandon the low tier either', async () => {
    const { LLMProviderError } = require('../llm/provider.ts');
    const calls: string[] = [];
    const llm = {
      chatTier: async (tier: string) => {
        calls.push(tier);
        throw new LLMProviderError('500 internal error', 'server');
      },
    };
    const i = new AwarenessIntelligence(llm as never, 0, 0);
    await i.analyzeGeneral('aGk=', ctx());
    await i.analyzeGeneral('aGk=', ctx());
    expect(calls).toEqual(['low', 'low']);
  });
});

describe('ContextTracker — stuck fires once per episode', () => {
  beforeEach(() => initDatabase(':memory:'));

  const stuckConfig = { ...testConfig, stuck_threshold_ms: 1000 };

  test('a motionless window does not re-fire stuck on every capture', () => {
    const tracker = new ContextTracker(stuckConfig);
    const t0 = Date.now();
    tracker.processCapture('c1', 'frozen text', 'Player — VLC', t0);

    const stuckCounts: number[] = [];
    for (let n = 1; n <= 6; n++) {
      const { events } = tracker.processCapture(`c${n + 1}`, 'frozen text', 'Player — VLC', t0 + n * 2000);
      stuckCounts.push(events.filter(e => e.type === 'stuck_detected').length);
    }

    // Exactly one stuck event across the whole stall. Re-firing would mean a
    // billed vision call every cooldown for as long as the window is up.
    expect(stuckCounts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  test('a new stall after activity is a new episode', () => {
    const tracker = new ContextTracker(stuckConfig);
    const t0 = Date.now();
    tracker.processCapture('c1', 'frozen text', 'Player — VLC', t0);
    tracker.processCapture('c2', 'frozen text', 'Player — VLC', t0 + 2000); // fires

    // The user does something.
    tracker.processCapture('c3', 'the user typed something', 'Player — VLC', t0 + 4000);

    // Then stalls again — that is a fresh episode and must be reported.
    const { events } = tracker.processCapture('c4', 'the user typed something', 'Player — VLC', t0 + 6000);
    expect(events.some(e => e.type === 'stuck_detected')).toBe(true);
  });
});

describe('ContextTracker — redundancy uses the full OCR text', () => {
  beforeEach(() => initDatabase(':memory:'));

  test('content changing under a long static header is not redundant', () => {
    const tracker = new ContextTracker(testConfig);
    const t0 = Date.now();
    // 2500 characters of unchanging chrome — a file tree, a nav bar, a header.
    const chrome = 'sidebar item '.repeat(200);
    expect(chrome.length).toBeGreaterThan(2000);

    tracker.processCapture('c1', chrome + 'first page of the document', 'Docs — Editor', t0);
    const next = tracker.processCapture('c2', chrome + 'a completely different page', 'Docs — Editor', t0 + 1000);

    // Hashing only the first 2000 chars would call this redundant and drop the
    // body out of the entity graph and observation log.
    expect(next.isRedundant).toBe(false);
  });
});
