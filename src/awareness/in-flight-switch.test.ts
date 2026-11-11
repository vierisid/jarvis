/**
 * Screen awareness turned off while a capture is still being processed
 * (owner decision 2026-11-11, #1314 follow-up). The switch is read when a
 * capture arrives; the image fetch, the screen analysis and the session
 * topic all await after that. None of them may send screen content to a
 * model, store what it derived, or emit an event once awareness is off.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { AwarenessService } from './service.ts';
import { SuggestionEngine } from './suggestion-engine.ts';
import { AwarenessIntelligence } from './intelligence.ts';
import type { AwarenessEvent } from './types.ts';
import type { AwarenessConfig, JarvisConfig } from '../config/types.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { SidecarEvent } from '../sidecar/protocol.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { getSession } from '../vault/awareness.ts';
import { setScreenCaptureEnabledSource } from '../actions/tools/desktop-guard.ts';

const base: AwarenessConfig = {
  enabled: true, capture_interval_ms: 15000, min_change_threshold: 0.02,
  cloud_vision_enabled: true, cloud_vision_cooldown_ms: 30000,
  cloud_vision_ambient_cooldown_ms: 900000, stuck_threshold_ms: 300000,
  suggestion_rate_limit_ms: 60000, retention: { full_hours: 24, key_moment_hours: 72 },
  struggle_grace_ms: 120000, struggle_cooldown_ms: 180000, overlay_autolaunch: false,
};

let on = true;
let events: AwarenessEvent[];
let sends: string[];
let evaluate: ReturnType<typeof spyOn>;
const services: AwarenessService[] = [];
beforeEach(() => {
  on = true; events = []; sends = [];
  setScreenCaptureEnabledSource(() => on);
  initDatabase(':memory:', { quiet: true });
  evaluate = spyOn(SuggestionEngine.prototype, 'evaluate').mockResolvedValue(null);
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  evaluate.mockRestore();
  closeDb();
  setScreenCaptureEnabledSource(null);
});

/** A model client standing in for LLMManager: `reply` runs as the provider attempt. */
function llm(reply: (options?: { checkDeadline?: () => void }) => string): LLMManager {
  return { async chatTier(_tier: string, subsystem: string, _messages: unknown, options?: { checkDeadline?: () => void }) {
    const content = reply(options);
    sends.push(subsystem);
    return { content };
  } } as unknown as LLMManager;
}

async function service(model: LLMManager, fetch: () => Promise<Buffer | null>, config: Partial<AwarenessConfig> = {}) {
  const value = new AwarenessService({ awareness: { ...base, ...config } } as JarvisConfig, model,
    event => events.push(event), null, fetch);
  services.push(value);
  await value.start();
  return value;
}

function capture(value: AwarenessService, timestamp: number, app = 'Editor', ocr = 'Reviewing the project draft and its delivery notes.') {
  const event: SidecarEvent = JSON.parse(JSON.stringify({ type: 'sidecar_event', event_type: 'screen_capture', timestamp,
    priority: 'normal', payload: { capture_id: timestamp, image_path: '/fixture/screen.png', pixel_change_pct: 0.5,
      ocr_text: ocr, app_name: app, window_title: `Draft - ${app}` } }));
  return value.handleSidecarEvent('desktop', event);
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('on: a capture is fetched, analysed and evaluated (the fixture reaches every step)', async () => {
  const value = await service(llm(() => 'analysis'), async () => Buffer.from('png'));
  await capture(value, Date.now());
  expect(sends).toHaveLength(1);
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(events.length).toBeGreaterThan(0);
});

test('turned off while the image is being fetched: no analysis, no evaluation, no event', async () => {
  let release!: (buffer: Buffer) => void;
  const fetched = new Promise<Buffer>(resolve => { release = resolve; });
  const value = await service(llm(() => 'analysis'), () => fetched);
  const running = capture(value, Date.now());
  await settle();
  on = false;
  release(Buffer.from('png'));
  await running;
  expect(sends).toEqual([]);
  expect(evaluate).not.toHaveBeenCalled();
  expect(events).toEqual([]);
});

test('turned off while the analysis is in flight: its result is not evaluated or emitted', async () => {
  // The provider answers after the switch went off (the request was already sent).
  const value = await service(llm(() => { on = false; return 'analysis'; }), async () => Buffer.from('png'));
  await capture(value, Date.now());
  expect(sends).toHaveLength(1);
  expect(evaluate).not.toHaveBeenCalled();
  expect(events).toEqual([]);
});

test('turned off during evaluation: nothing it produced is emitted', async () => {
  evaluate.mockImplementation(async () => { on = false; return null; });
  const value = await service(llm(() => 'analysis'), async () => Buffer.from('png'));
  await capture(value, Date.now());
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(events).toEqual([]);
});

test('screen analysis is held at the provider retry boundary once awareness is off', async () => {
  // LLMManager asks options.checkDeadline before each provider attempt; the
  // switch went off before this one, so it must not be sent.
  const value = await service(llm(options => { on = false; options?.checkDeadline?.(); return 'analysis'; }), async () => Buffer.from('png'));
  await capture(value, Date.now());
  expect(sends).toEqual([]);
});

test('a session topic is neither sent nor stored once awareness is off', async () => {
  const start = Date.now() - 180000;
  // No cloud vision: the only model call is the ended session's topic.
  const value = await service(llm(options => { on = false; options?.checkDeadline?.(); return '{"topic":"Leaked","summary":"Leaked."}'; }),
    async () => null, { cloud_vision_enabled: false });
  await capture(value, start, 'Editor');
  const sessionId = value.getCurrentSession()!.id;
  await capture(value, start + 150000, 'Browser');
  for (let i = 0; i < 5; i++) await settle();
  expect(sends).toEqual([]);
  expect(getSession(sessionId)!.summary).toBeNull();
});

test('a session topic that returns after awareness went off is not stored', async () => {
  const start = Date.now() - 180000;
  const value = await service(llm(() => { on = false; return '{"topic":"Leaked","summary":"Leaked."}'; }),
    async () => null, { cloud_vision_enabled: false });
  await capture(value, start, 'Editor');
  const sessionId = value.getCurrentSession()!.id;
  await capture(value, start + 150000, 'Browser');
  for (let i = 0; i < 5; i++) await settle();
  expect(sends).toEqual(['awareness_session_summary']);
  expect(getSession(sessionId)!.summary).toBeNull();
});

test('on: a session topic is stored (the session fixture is live)', async () => {
  const start = Date.now() - 180000;
  const value = await service(llm(() => '{"topic":"Draft review","summary":"Reviewed."}'), async () => null, { cloud_vision_enabled: false });
  await capture(value, start, 'Editor');
  const sessionId = value.getCurrentSession()!.id;
  await capture(value, start + 150000, 'Browser');
  for (let i = 0; i < 5; i++) await settle();
  expect(getSession(sessionId)!.summary).toBe('Reviewed.');
});

test('a capture that arrives while the switch is off is dropped even if the service still runs', async () => {
  const value = await service(llm(() => 'analysis'), async () => Buffer.from('png'));
  on = false;
  await capture(value, Date.now());
  expect(sends).toEqual([]);
  expect(evaluate).not.toHaveBeenCalled();
  expect(events).toEqual([]);
  on = true;
  expect(value.getCurrentSession()).toBeNull();
});

test('a session topic is not even attempted when awareness went off as the session ended', async () => {
  const start = Date.now() - 180000;
  const summarize = spyOn(AwarenessIntelligence.prototype, 'summarizeSession');
  try {
    const value = await service(llm(() => '{"topic":"Leaked","summary":"Leaked."}'), async () => null, { cloud_vision_enabled: false });
    // The session-end listener runs before the topic is inferred: the switch goes off there.
    const listen = (event: AwarenessEvent) => { events.push(event); if (event.type === 'session_ended') on = false; };
    (value as unknown as { eventCallback: (event: AwarenessEvent) => void }).eventCallback = listen;
    await capture(value, start, 'Editor');
    await capture(value, start + 150000, 'Browser');
    for (let i = 0; i < 5; i++) await settle();
    expect(events.map(event => event.type)).toContain('session_ended');
    expect(summarize).not.toHaveBeenCalled();
  } finally { summarize.mockRestore(); }
});

function workday(value: AwarenessService) {
  const start = Date.now() - 20 * 60000;
  return (async () => { for (let i = 0; i <= 20; i++) await capture(value, start + i * 60000, 'Editor', `Reviewing the project draft, part ${i}.`); })();
}

test('on: the daily report asks the model for takeaways (the report fixture is live)', async () => {
  const value = await service(llm(() => '["ok"]'), async () => null, { cloud_vision_enabled: false });
  await workday(value);
  const report = await value.generateReport();
  expect(sends).toContain('awareness_daily_takeaways');
  expect(report.aiTakeaways).toEqual(['ok']);
});

test('a report is held at the provider retry boundary once awareness is off', async () => {
  const value = await service(llm(options => { on = false; options?.checkDeadline?.(); return '["leaked"]'; }), async () => null, { cloud_vision_enabled: false });
  await workday(value);
  await expect(value.generateReport()).rejects.toThrow('Screen awareness is off');
  expect(sends).toEqual([]);
});

test('a report finished after awareness went off is not handed out', async () => {
  const value = await service(llm(() => { on = false; return '["leaked"]'; }), async () => null, { cloud_vision_enabled: false });
  await workday(value);
  await expect(value.generateReport()).rejects.toThrow('Screen awareness is off');
  on = true;
  sends.length = 0;
  const weekly = llm(() => { on = false; return '["leaked"]'; });
  const second = await service(weekly, async () => null, { cloud_vision_enabled: false });
  await workday(second);
  await expect(second.generateWeeklyReport()).rejects.toThrow('Screen awareness is off');
});
