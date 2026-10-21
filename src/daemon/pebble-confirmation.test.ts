/**
 * #964: a fast-path confirmation for a turn that was cancelled must leave the
 * pebble to whoever cancelled it. It used to set `speaking` before looking at
 * the flag and then return without going back to idle, so a reply arriving
 * after a dismissal stranded the pebble in `speaking` with a stale bubble.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { confirmationHoldMs, makeSpeakConfirmation, type SpeakConfirmationDeps } from './pebble-confirmation.ts';

type Event = string;

function harness(opts: { tts?: boolean } = {}) {
  const events: Event[] = [];
  const ctrl = { cancelled: false };
  // Hooks a test can use to cancel the turn at a precise await.
  const at: { synth?: () => void; hold?: () => void; speaking?: () => void } = {};
  const deps: SpeakConfirmationDeps = {
    setState: async (_id, state, text) => {
      events.push(`state:${state}${text ? `:${text}` : ''}`);
      if (state === 'speaking') at.speaking?.();
    },
    heartbeat: (text) => { events.push(`heartbeat:${text}`); },
    synthesizer: () => opts.tts === false ? null : async (text) => {
      events.push(`synth:${text}`);
      at.synth?.();
      return Buffer.from('clip');
    },
    play: async () => { events.push('play'); },
    hold: async (ms) => { events.push(`hold:${ms}`); at.hold?.(); },
  };
  return { events, ctrl, at, speak: makeSpeakConfirmation(deps) };
}

/** What the pebble shows last: the state a stranded turn leaves behind. */
const lastState = (events: Event[]) => [...events].reverse().find((e) => e.startsWith('state:')) ?? null;

describe('speakConfirmation', () => {
  test('an uncancelled confirmation speaks, plays, holds and returns to idle', async () => {
    const { events, ctrl, speak } = harness();
    await speak('s1', 'Done.', ctrl);
    expect(events).toEqual([
      'state:speaking:Done.', 'heartbeat:Done.', 'synth:Done.', 'play', `hold:${confirmationHoldMs('Done.')}`, 'state:idle',
    ]);
  });

  test('a turn cancelled before the confirmation touches nothing', async () => {
    for (const tts of [true, false]) {
      const { events, ctrl, speak } = harness({ tts });
      ctrl.cancelled = true;
      await speak('s1', 'Hid the amber background agent.', ctrl);
      // The bug: ['state:speaking:Hid the amber...', 'heartbeat:...'] and no
      // idle, so the pebble stayed in speaking over the canceller's idle.
      expect(events).toEqual([]);
    }
  });

  test('cancelled while the speech is synthesized: the clip is not played and the canceller keeps the pebble', async () => {
    const { events, ctrl, at, speak } = harness();
    // A canceller like the summon dismiss: flag, then its own idle.
    at.synth = () => { ctrl.cancelled = true; events.push('state:idle:by-canceller'); };
    await speak('s1', 'Switched Settings to voice.', ctrl);
    expect(events).not.toContain('play');
    expect(lastState(events)).toBe('state:idle:by-canceller');
    expect(events.filter((e) => e.startsWith('hold'))).toEqual([]);
  });

  test('with TTS off an uncancelled confirmation still shows, holds and returns to idle', async () => {
    const { events, ctrl, speak } = harness({ tts: false });
    await speak('s1', 'Done.', ctrl);
    expect(events).toEqual(['state:speaking:Done.', 'heartbeat:Done.', `hold:${confirmationHoldMs('Done.')}`, 'state:idle']);
  });

  test('a failing playback is warned about and still returns to idle', async () => {
    const events: Event[] = [];
    const warned: unknown[] = [];
    const speak = makeSpeakConfirmation({
      setState: async (_id, state) => { events.push(`state:${state}`); },
      heartbeat: () => {},
      synthesizer: () => async () => Buffer.from('clip'),
      play: async () => { throw new Error('sidecar gone'); },
      hold: async () => {},
      warn: (_m, err) => { warned.push(err); },
    });
    await speak('s1', 'Done.', { cancelled: false });
    expect(events).toEqual(['state:speaking', 'state:idle']);
    expect(warned).toHaveLength(1);
  });

  test('cancelled while speaking was being set: no heartbeat goes out', async () => {
    const { events, ctrl, at, speak } = harness();
    at.speaking = () => { ctrl.cancelled = true; };
    await speak('s1', 'Done.', ctrl);
    expect(events).toEqual(['state:speaking:Done.']);
  });

  test('cancelled during the hold: no idle over the canceller\'s state', async () => {
    const { events, ctrl, at, speak } = harness();
    at.hold = () => { ctrl.cancelled = true; };
    await speak('s1', 'Done.', ctrl);
    expect(events.at(-1)).toMatch(/^hold:/);
  });

  test('heartbeat: false keeps the confirmation off the dashboard, nothing else changes', async () => {
    const { events, ctrl, speak } = harness();
    await speak('s1', 'Opening Settings.', ctrl, { heartbeat: false });
    expect(events.some((e) => e.startsWith('heartbeat'))).toBe(false);
    expect(events.at(-1)).toBe('state:idle');
  });

  test('a failing synthesizer still returns to idle', async () => {
    const events: Event[] = [];
    const ctrl = { cancelled: false };
    const broken = makeSpeakConfirmation({
      setState: async (_id, state) => { events.push(`state:${state}`); },
      heartbeat: () => {},
      synthesizer: () => async () => { throw new Error('tts down'); },
      play: async () => { events.push('play'); },
      hold: async () => {},
    });
    await broken('s1', 'Done.', ctrl);
    expect(events).toEqual(['state:speaking', 'state:idle']);
  });
});

describe('the daemon speaks every fast-path confirmation through it', () => {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  test('speakConfirmation is the shared helper, not an inline copy', () => {
    expect(src).toContain('const speakConfirmation = makeSpeakConfirmation({');
  });

  test('no other fast path sets speaking after synthesizing a confirmation', () => {
    // The room open/close fast path had its own copy with the same bug.
    expect(src).not.toContain("await setState(sidecarId, 'speaking', confirm);");
    // It now lives in pebble-room-panel.ts (#1026), which speaks only through
    // the helper it is handed, and the daemon hands it this one.
    const roomPanel = readFileSync(new URL('./pebble-room-panel.ts', import.meta.url), 'utf8');
    expect(roomPanel).not.toContain("'speaking'");
    expect(roomPanel).not.toContain('synthesize');
    expect(roomPanel).toContain('await deps.speak(sidecarId, roomPanelReply(intent, outcome), ctrl);');
    expect(src).toContain('speak: speakConfirmation,');
    expect(src).toContain('await runRoomPanelIntent(roomPanelDeps, sidecarId,');
    // The only other synthesis is the streamed answer's queue; a new inline
    // confirmation copy would add one.
    expect(src.match(/\.synthesize\(/g)?.length).toBe(2);
  });
});
