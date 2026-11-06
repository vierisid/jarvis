import { afterEach, describe, expect, test } from 'bun:test';
import { scheduleAutostartRestart } from '../cli/autostart.ts';
import { anyRealtimeVoicing } from './realtime-voice.ts';
import {
  keepaliveRestart,
  keepaliveRestartDeps,
  resetRestartAfterSpeech,
  restartHeldForSpeech,
  RESTART_SPEECH_POLL_MS,
  RESTART_SPEECH_WAIT_CAP_MS,
  type KeepaliveRestartDeps,
} from './restart-after-speech.ts';

/** A clock and timer queue the test drives by hand. */
function harness(platform: NodeJS.Platform = 'linux') {
  let t = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  let voicing = false;
  const calls = { request: 0, schedule: 0, unitState: 0 };
  const deps: KeepaliveRestartDeps = {
    platform,
    isInstalled: () => true,
    serviceName: () => 'systemd',
    requestSystemdRestart: () => { calls.request++; return 'scheduled'; },
    keepaliveUnitState: () => { calls.unitState++; return 'runs'; },
    scheduleRestart: () => { calls.schedule++; return true; },
    isVoicing: () => voicing,
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ at: t + ms, fn }); },
  };
  const advance = (ms: number) => {
    const until = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      t = next.at;
      next.fn();
    }
    t = until;
  };
  return { deps, calls, advance, setVoicing: (v: boolean) => { voicing = v; } };
}

afterEach(() => resetRestartAfterSpeech());

describe('keepalive restart and live voice (#1156)', () => {
  test('nothing voicing: schedules inside the request, as before', () => {
    const h = harness();
    expect(keepaliveRestart(h.deps)).toEqual({ ok: true, message: 'Restarting the JARVIS 24/7 systemd service.' });
    expect(h.calls).toEqual({ request: 1, schedule: 0, unitState: 0 });
    expect(restartHeldForSpeech()).toBe(false);
  });

  test('nothing voicing: a refused schedule is still reported', () => {
    const h = harness('darwin');
    h.deps.scheduleRestart = () => false;
    expect(keepaliveRestart(h.deps)).toEqual({ ok: false, error: 'Failed to schedule keepalive service restart.', status: 400 });
  });

  test('nothing voicing: Linux refusals keep their status', () => {
    const h = harness();
    h.deps.requestSystemdRestart = () => 'not_this_daemon';
    expect(keepaliveRestart(h.deps)).toMatchObject({ ok: false, status: 409 });
    for (const outcome of ['unknown', 'failed'] as const) {
      h.deps.requestSystemdRestart = () => outcome;
      expect(keepaliveRestart(h.deps)).toEqual({ ok: false, error: 'Failed to schedule keepalive service restart.', status: 400 });
    }
    expect(h.calls.unitState).toBe(0);
  });

  test('a held schedule that is refused is logged; the request said yes', () => {
    const h = harness('darwin');
    h.setVoicing(true);
    let refused = 0;
    h.deps.scheduleRestart = () => { refused++; return false; };
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args[0]); };
    try {
      expect(keepaliveRestart(h.deps).ok).toBe(true);
      h.setVoicing(false);
      h.advance(RESTART_SPEECH_POLL_MS);
    } finally {
      console.error = original;
    }
    expect(refused).toBe(1);
    expect(errors).toEqual(['[restart] the held keepalive restart was refused']);
    expect(restartHeldForSpeech()).toBe(false);
  });

  test('a voiced answer still to come holds the restart until the session is quiet', () => {
    const h = harness();
    h.setVoicing(true);
    expect(keepaliveRestart(h.deps).ok).toBe(true);
    expect(h.calls.schedule).toBe(0);
    expect(h.calls.request).toBe(0);
    h.advance(5_000);
    expect(h.calls.schedule).toBe(0);
    h.setVoicing(false);
    h.advance(RESTART_SPEECH_POLL_MS);
    expect(h.calls.schedule).toBe(1);
    expect(restartHeldForSpeech()).toBe(false);
  });

  test('a session that never goes quiet holds it no longer than the cap', () => {
    const h = harness();
    h.setVoicing(true);
    keepaliveRestart(h.deps);
    h.advance(RESTART_SPEECH_WAIT_CAP_MS - 1);
    expect(h.calls.schedule).toBe(0);
    h.advance(RESTART_SPEECH_POLL_MS);
    expect(h.calls.schedule).toBe(1);
  });

  test('a second request while one is held is a yes and schedules once', () => {
    const h = harness();
    h.setVoicing(true);
    keepaliveRestart(h.deps);
    h.setVoicing(false);
    // Held, so not scheduled again inside this request either.
    expect(keepaliveRestart(h.deps).ok).toBe(true);
    expect(h.calls.request).toBe(0);
    h.advance(RESTART_SPEECH_POLL_MS);
    expect(h.calls.schedule).toBe(1);
  });

  test('a restart that cannot happen is a no at once, never held (Linux)', () => {
    const h = harness();
    h.setVoicing(true);
    h.deps.keepaliveUnitState = () => 'other';
    expect(keepaliveRestart(h.deps)).toMatchObject({ ok: false, status: 409 });
    expect(restartHeldForSpeech()).toBe(false);
    h.deps.keepaliveUnitState = () => 'unknown';
    expect(keepaliveRestart(h.deps)).toMatchObject({ ok: false, status: 400 });
    expect(restartHeldForSpeech()).toBe(false);
  });

  test('not installed and unsupported platforms are refused before anything else', () => {
    const h = harness();
    h.setVoicing(true);
    h.deps.isInstalled = () => false;
    expect(keepaliveRestart(h.deps)).toMatchObject({ ok: false, status: 400 });
    expect(keepaliveRestart({ ...harness('win32').deps })).toMatchObject({ ok: false, status: 400 });
    expect(restartHeldForSpeech()).toBe(false);
  });

  test('a held schedule that throws is logged and frees the hold', () => {
    const h = harness();
    h.setVoicing(true);
    h.deps.scheduleRestart = () => { throw new Error('boom'); };
    keepaliveRestart(h.deps);
    h.setVoicing(false);
    h.advance(RESTART_SPEECH_POLL_MS);
    expect(restartHeldForSpeech()).toBe(false);
  });
});

describe('the route wiring', () => {
  test('waits on every live realtime session and schedules for this platform', () => {
    const deps = keepaliveRestartDeps();
    expect(deps.isVoicing).toBe(anyRealtimeVoicing);
    expect(deps.scheduleRestart).toBe(scheduleAutostartRestart);
    expect(deps.platform).toBe(process.platform);
  });
});
