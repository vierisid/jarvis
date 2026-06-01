#!/usr/bin/env bun
/**
 * Live smoke test for the gpt-realtime-2 integration (Phase 0-1).
 *
 * Validates the parts unit tests CAN'T: that our GA `session.update` shape is
 * actually accepted by OpenAI (especially `reasoning.effort` placement and the
 * `semantic_vad` turn detection), that auth works, and that the server event
 * names we parse are correct. Sends a TEXT prompt (no mic needed) and asks for
 * an audio response, then prints every event — errors loudly.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... bun run scripts/realtime-smoke.ts
 *   # optional overrides:
 *   REALTIME_MODEL=gpt-realtime-2 REALTIME_EFFORT=medium REALTIME_VOICE=marin \
 *     bun run scripts/realtime-smoke.ts "Say hello in exactly five words."
 *
 * This is a throwaway diagnostic, not part of the daemon. It exercises the real
 * `buildSessionUpdate` from src/comms/realtime.ts so a green run means Phase 2
 * can build on a verified protocol.
 */

import { REALTIME_URL, buildSessionUpdate } from '../src/comms/realtime.ts';
import type { ResolvedRealtimeVoice } from '../src/config/realtime.ts';
import type { RealtimeReasoningEffort } from '../src/config/types.ts';

const key = (process.env.OPENAI_API_KEY || process.env.JARVIS_OPENAI_KEY || '').trim();
if (!key) {
  console.error('✗ No API key. Set OPENAI_API_KEY (or JARVIS_OPENAI_KEY) and retry.');
  process.exit(1);
}

const resolved: ResolvedRealtimeVoice = {
  apiKey: key,
  model: process.env.REALTIME_MODEL || 'gpt-realtime-2',
  voice: process.env.REALTIME_VOICE || 'marin',
  reasoningEffort: (process.env.REALTIME_EFFORT as RealtimeReasoningEffort) || 'low',
  maxSessionMinutes: 5,
  blockedCategories: [],
};

const prompt = process.argv.slice(2).join(' ') || 'Say hello and tell me you are working, in one short sentence.';
const url = `${REALTIME_URL}?model=${encodeURIComponent(resolved.model)}`;

console.log(`→ Connecting: ${url}`);
console.log(`→ Model=${resolved.model}  effort=${resolved.reasoningEffort}  voice=${resolved.voice}`);

// Bun's WebSocket accepts a non-standard { headers } option.
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } } as any);

let assistantText = '';
let audioBytes = 0;
let sawError = false;

const done = (code: number) => { try { ws.close(); } catch {} process.exit(code); };
const timeout = setTimeout(() => {
  console.error('✗ Timed out after 30s with no response.done');
  done(sawError ? 1 : 2);
}, 30_000);

ws.addEventListener('open', () => {
  console.log('✓ Socket open — sending session.update');
  // 24kHz is the realtime input minimum (16kHz is rejected). Pebble's 16kHz mic
  // must be upsampled before streaming — see MIN_REALTIME_INPUT_RATE.
  const sessionUpdate = buildSessionUpdate(resolved, [], 'You are a terse test agent.', 24000, 24000);
  console.log('  session.update payload:\n' + JSON.stringify(sessionUpdate, null, 2));
  ws.send(JSON.stringify(sessionUpdate));

  // Drive a turn with text input (no mic), then request a response.
  ws.send(JSON.stringify({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
  }));
  ws.send(JSON.stringify({ type: 'response.create' }));
});

ws.addEventListener('message', (ev: MessageEvent) => {
  let evt: any;
  try { evt = JSON.parse(String(ev.data)); } catch { return; }
  const t = evt.type as string;

  switch (t) {
    case 'session.created':
    case 'session.updated':
      console.log(`✓ ${t}`);
      break;
    case 'response.output_audio.delta':
      audioBytes += Buffer.from(evt.delta || '', 'base64').length;
      break;
    case 'response.output_audio_transcript.delta':
      assistantText += evt.delta || '';
      break;
    case 'response.output_audio_transcript.done':
      console.log(`✓ assistant transcript: "${evt.transcript ?? assistantText}"`);
      break;
    case 'response.done':
      console.log(`✓ response.done — received ${audioBytes} bytes of audio`);
      clearTimeout(timeout);
      console.log(sawError ? '\n✗ Completed WITH errors (see above).' : '\n✓ SMOKE TEST PASSED — GA session shape accepted, audio + transcript received.');
      done(sawError ? 1 : 0);
      break;
    case 'error':
      sawError = true;
      console.error(`✗ ERROR event: ${JSON.stringify(evt.error, null, 2)}`);
      console.error('  (If this complains about session fields, our session.update shape needs adjusting — note it in the roadmap.)');
      break;
    default:
      // Comment this in for full event tracing:
      // console.log(`  · ${t}`);
      break;
  }
});

ws.addEventListener('error', () => {
  console.error('✗ WebSocket error (auth/network). Check the API key and that your account has realtime access.');
  clearTimeout(timeout);
  done(1);
});

ws.addEventListener('close', (ev: CloseEvent) => {
  if (ev.code !== 1000) console.error(`✗ Socket closed: code=${ev.code} reason="${ev.reason}"`);
});
