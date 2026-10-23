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
 * Spoken mode (#1007): REALTIME_AUDIO=<file> streams a recording of speech
 * (24 kHz mono s16le raw PCM, or a WAV of that format) as the user turn instead
 * of the text prompt, then checks what only real audio exercises: the server
 * VAD's `input_audio_buffer.speech_started` carries an `item_id`, the input
 * transcription (turned on in `session.update`) completes for that SAME
 * `item_id` with non-empty text, and its `usage` is reported (the transcription
 * is metered from it). Exits 0 only when all of that holds.
 *
 * Hosted proxy: REALTIME_URL=wss://<proxy>/v1/realtime REALTIME_MODEL=uj-realtime
 * with the tenant's proxy key in OPENAI_API_KEY.
 *
 * This is a throwaway diagnostic, not part of the daemon. It exercises the real
 * `buildSessionUpdate` from src/comms/realtime.ts so a green run means Phase 2
 * can build on a verified protocol.
 */

import { buildSessionUpdate } from '../src/comms/realtime.ts';
import type { ResolvedRealtimeVoice } from '../src/config/realtime.ts';
import type { RealtimeReasoningEffort } from '../src/config/types.ts';

const key = (process.env.OPENAI_API_KEY || process.env.JARVIS_OPENAI_KEY || '').trim();
if (!key) {
  console.error('✗ No API key. Set OPENAI_API_KEY (or JARVIS_OPENAI_KEY) and retry.');
  process.exit(1);
}

// The URL now rides ON the resolved config (the hosted path repoints it to
// the platform proxy), so this script states the OpenAI one explicitly rather
// than importing a constant that no longer exists.
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const realtimeUrl = (process.env.REALTIME_URL || OPENAI_REALTIME_URL).trim();

const resolved: ResolvedRealtimeVoice = {
  provider: realtimeUrl === OPENAI_REALTIME_URL ? 'openai' : 'usejarvis_ai',
  url: realtimeUrl,
  apiKey: key,
  model: process.env.REALTIME_MODEL || 'gpt-realtime-2',
  voice: process.env.REALTIME_VOICE || 'marin',
  reasoningEffort: (process.env.REALTIME_EFFORT as RealtimeReasoningEffort) || 'low',
  maxSessionMinutes: 5,
  blockedCategories: [],
};

const prompt = process.argv.slice(2).join(' ') || 'Say hello and tell me you are working, in one short sentence.';

/**
 * The PCM samples of a WAV file, which must be 24 kHz mono 16-bit PCM (what the
 * session declares), read from its `fmt ` and `data` chunks rather than an
 * assumed 44-byte header. Exits with the reason when it is anything else.
 */
function wavPcm(raw: Buffer): Buffer {
  const fail = (why: string): never => {
    console.error(`FAIL: REALTIME_AUDIO ${why}. Convert it: ffmpeg -y -i in.wav -ar 24000 -ac 1 -c:a pcm_s16le out.wav`);
    process.exit(1);
  };
  if (raw.length < 12 || raw.subarray(8, 12).toString('ascii') !== 'WAVE') fail('is a RIFF file but not WAVE');
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  for (let at = 12; at + 8 <= raw.length;) {
    const id = raw.subarray(at, at + 4).toString('ascii');
    const size = raw.readUInt32LE(at + 4);
    const body = raw.subarray(at + 8, Math.min(raw.length, at + 8 + size));
    if (id === 'fmt ' && body.length >= 16) {
      fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === 'data') {
      data = body;
    }
    at += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt) return fail('has no fmt chunk');
  if (!data) return fail('has no data chunk');
  // 1 is PCM; 0xFFFE (extensible) is accepted when the rest matches.
  if (fmt.format !== 1 && fmt.format !== 0xfffe) fail(`is not PCM (format ${fmt.format})`);
  if (fmt.rate !== 24000) fail(`is ${fmt.rate} Hz, not 24000 Hz`);
  if (fmt.channels !== 1) fail(`has ${fmt.channels} channels, not 1`);
  if (fmt.bits !== 16) fail(`is ${fmt.bits}-bit, not 16-bit`);
  return data;
}

// Spoken mode: a 24 kHz mono 16-bit WAV, or raw s16le PCM in that format.
const audioPath = (process.env.REALTIME_AUDIO || '').trim();
let speech: Buffer | null = null;
if (audioPath) {
  const raw = Buffer.from(await Bun.file(audioPath).arrayBuffer());
  speech = raw.subarray(0, 4).toString('ascii') === 'RIFF' ? wavPcm(raw) : raw;
  if (speech.length < 24000 * 2) {
    console.error('FAIL: REALTIME_AUDIO is under one second of 24 kHz s16le audio; record a short sentence.');
    process.exit(1);
  }
}
const spoken = { startedItems: [] as string[], transcriptItem: '', transcript: '', usage: null as unknown, responseDone: false };
const url = `${resolved.url}?model=${encodeURIComponent(resolved.model)}`;

console.log(`→ Connecting: ${url}`);
console.log(`→ Model=${resolved.model}  effort=${resolved.reasoningEffort}  voice=${resolved.voice}`);

// Bun's WebSocket accepts a non-standard { headers } option.
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } } as any);

let assistantText = '';
let audioBytes = 0;
let sawError = false;

const done = (code: number) => { try { ws.close(); } catch {} process.exit(code); };
const timeout = setTimeout(() => {
  console.error(speech
    ? `FAIL: timed out after 30s. speech_started items=${spoken.startedItems.join(',') || '(none)'} transcription item=${spoken.transcriptItem || '(none)'} response.done=${spoken.responseDone}`
    : '✗ Timed out after 30s with no response.done');
  done(sawError ? 1 : 2);
}, 30_000);

/** Spoken mode: pass once the reply is done and the transcription checked out. */
function finishSpoken(): void {
  if (!spoken.responseDone || !spoken.transcriptItem) return;
  clearTimeout(timeout);
  const failures: string[] = [];
  // The VAD may split a recording into several utterances; the transcript
  // must belong to one of them.
  if (!spoken.startedItems.length || spoken.startedItems.includes('')) failures.push('an input_audio_buffer.speech_started had no item_id');
  if (!spoken.startedItems.includes(spoken.transcriptItem)) {
    failures.push(`transcription item_id ${spoken.transcriptItem} is none of the speech_started item_ids (${spoken.startedItems.join(', ') || 'none'})`);
  }
  if (!spoken.transcript.trim()) failures.push('the transcript was empty');
  if (!spoken.usage) failures.push('the transcription event carried no usage');
  if (sawError) failures.push('an error event arrived (see above)');
  if (failures.length) {
    for (const f of failures) console.error(`FAIL: ${f}`);
    done(1);
  }
  console.log('\nSPOKEN SMOKE TEST PASSED - speech_started and the transcription share an item_id, the transcript has words, and usage is reported.');
  done(0);
}

ws.addEventListener('open', () => {
  console.log('✓ Socket open — sending session.update');
  // 24kHz is the realtime input minimum (16kHz is rejected). Pebble's 16kHz mic
  // must be upsampled before streaming — see MIN_REALTIME_INPUT_RATE.
  const sessionUpdate = buildSessionUpdate(resolved, [], 'You are a terse test agent.', 24000, 24000);
  console.log('  session.update payload:\n' + JSON.stringify(sessionUpdate, null, 2));
  ws.send(JSON.stringify(sessionUpdate));

  if (speech) {
    // Stream the recording in 100 ms frames, then a second and a half of
    // silence so the server VAD closes the turn and answers it on its own.
    const frame = 24000 * 2 / 10;
    const pcm = Buffer.concat([speech, Buffer.alloc(24000 * 2 * 1.5)]);
    for (let i = 0; i < pcm.length; i += frame) {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.subarray(i, i + frame).toString('base64') }));
    }
    console.log(`-> Streamed ${(speech.length / 48000).toFixed(1)}s of speech + 1.5s of silence`);
    return;
  }

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
    case 'input_audio_buffer.speech_started':
      spoken.startedItems.push(typeof evt.item_id === 'string' ? evt.item_id : '');
      console.log(`ok speech_started item_id=${spoken.startedItems.at(-1) || '(none)'}`);
      break;
    case 'conversation.item.input_audio_transcription.completed':
      spoken.transcriptItem = typeof evt.item_id === 'string' ? evt.item_id : '(none)';
      spoken.transcript = String(evt.transcript ?? '');
      spoken.usage = evt.usage ?? null;
      console.log(`ok input transcription item_id=${spoken.transcriptItem} transcript="${spoken.transcript}" usage=${JSON.stringify(evt.usage ?? null)}`);
      finishSpoken();
      break;
    case 'conversation.item.input_audio_transcription.failed':
      sawError = true;
      console.error(`FAIL: input transcription failed: ${JSON.stringify(evt.error ?? evt)}`);
      break;
    case 'response.done':
      console.log(`✓ response.done — received ${audioBytes} bytes of audio`);
      if (speech) {
        spoken.responseDone = true;
        finishSpoken();
        break;
      }
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
