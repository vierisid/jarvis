import { test, expect, describe } from 'bun:test';
import {
  RealtimeSession,
  buildSessionUpdate,
  convertToolsForRealtime,
  type RealtimeSocket,
  type RealtimeSocketFactory,
} from './realtime.ts';
import type { ResolvedRealtimeVoice } from '../config/realtime.ts';
import type { LLMTool } from '../llm/provider.ts';
import { BrowserAudioTransport } from './audio-transport.ts';

const RESOLVED: ResolvedRealtimeVoice = {
  apiKey: 'sk-test',
  model: 'gpt-realtime-2',
  voice: 'marin',
  reasoningEffort: 'medium',
  maxSessionMinutes: 10,
  blockedCategories: [],
};

const TOOLS: LLMTool[] = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

describe('convertToolsForRealtime', () => {
  test('maps LLMTool to GA realtime function entries', () => {
    const out = convertToolsForRealtime(TOOLS);
    expect(out).toEqual([
      { type: 'function', name: 'read_file', description: 'Read a file', parameters: TOOLS[0]!.parameters },
    ]);
  });
});

describe('buildSessionUpdate', () => {
  test('produces GA session shape with reasoning.effort and audio nesting', () => {
    const msg = buildSessionUpdate(RESOLVED, TOOLS, 'Be helpful', 24000, 24000) as any;
    expect(msg.type).toBe('session.update');
    expect(msg.session.type).toBe('realtime');
    expect(msg.session.model).toBe('gpt-realtime-2');
    expect(msg.session.reasoning).toEqual({ effort: 'medium' });
    expect(msg.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(msg.session.audio.output.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(msg.session.audio.output.voice).toBe('marin');
    expect(msg.session.tools).toHaveLength(1);
    expect(msg.session.tool_choice).toBe('auto');
  });

  test('omits voice and tools when not provided', () => {
    const noVoice = { ...RESOLVED, voice: undefined };
    const msg = buildSessionUpdate(noVoice, [], 'hi', 24000, 48000) as any;
    expect(msg.session.audio.output.format).toEqual({ type: 'audio/pcm', rate: 48000 });
    expect(msg.session.audio.output.voice).toBeUndefined();
    expect(msg.session.tools).toBeUndefined();
    expect(msg.session.tool_choice).toBeUndefined();
  });
});

// --- Fake socket for session lifecycle / event dispatch ---

class FakeSocket implements RealtimeSocket {
  sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.onclose?.(); }
  emit(evt: object): void { this.onmessage?.({ data: JSON.stringify(evt) }); }
  sentTypes(): string[] { return this.sent.map((s) => JSON.parse(s).type); }
}

function makeSession() {
  const socket = new FakeSocket();
  const factory: RealtimeSocketFactory = () => socket;
  const sentAudio: Buffer[] = [];
  const transport = new BrowserAudioTransport({
    sendAudio: (c) => sentAudio.push(c),
    inputSampleRate: 24000,
  });
  const session = new RealtimeSession({
    resolved: RESOLVED,
    tools: TOOLS,
    instructions: 'Be helpful',
    transport,
    socketFactory: factory,
  });
  return { socket, session, transport, sentAudio };
}

describe('RealtimeSession lifecycle', () => {
  test('sends session.update on open', async () => {
    const { socket, session } = makeSession();
    await session.connect();
    socket.onopen!();
    expect(socket.sentTypes()).toContain('session.update');
  });

  test('mic chunks become input_audio_buffer.append', async () => {
    const { socket, session, transport } = makeSession();
    await session.connect();
    socket.onopen!();
    (transport as BrowserAudioTransport).pushMicChunk(Buffer.from([1, 2, 3, 4]));
    const appendMsg = socket.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'input_audio_buffer.append');
    expect(appendMsg).toBeTruthy();
    expect(appendMsg.audio).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
  });

  test('output audio delta is decoded and routed to transport playback', async () => {
    const { socket, session, sentAudio } = makeSession();
    await session.connect();
    socket.onopen!();
    const pcm = Buffer.from([9, 8, 7, 6]);
    socket.emit({ type: 'response.output_audio.delta', delta: pcm.toString('base64') });
    expect(sentAudio).toHaveLength(1);
    expect(sentAudio[0]!.equals(pcm)).toBe(true);
  });

  test('transcripts (user + assistant) are emitted', async () => {
    const { socket, session } = makeSession();
    const got: Array<{ role: string; text: string; final: boolean }> = [];
    session.onTranscript((t) => got.push(t));
    await session.connect();
    socket.onopen!();
    socket.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello' });
    socket.emit({ type: 'response.output_audio_transcript.done', transcript: 'hi there' });
    expect(got).toEqual([
      { role: 'user', text: 'hello', final: true },
      { role: 'assistant', text: 'hi there', final: true },
    ]);
  });

  test('function call (name from output_item.added + args from done) is emitted', async () => {
    const { socket, session } = makeSession();
    const calls: any[] = [];
    session.onFunctionCall((c) => calls.push(c));
    await session.connect();
    socket.onopen!();
    socket.emit({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c1', name: 'read_file' } });
    socket.emit({ type: 'response.function_call_arguments.done', call_id: 'c1', arguments: '{"path":"/etc/hosts"}' });
    expect(calls).toEqual([{ callId: 'c1', name: 'read_file', args: { path: '/etc/hosts' } }]);
  });

  test('sendFunctionResult emits function_call_output + response.create', async () => {
    const { socket, session } = makeSession();
    await session.connect();
    socket.onopen!();
    socket.sent = [];
    session.sendFunctionResult('c1', { ok: true });
    expect(socket.sentTypes()).toEqual(['conversation.item.create', 'response.create']);
    const item = JSON.parse(socket.sent[0]!).item;
    expect(item).toEqual({ type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' });
  });

  test('speech_started triggers transport.stopPlayback (barge-in)', async () => {
    const { socket, session, transport } = makeSession();
    let stopped = 0;
    const orig = transport.stopPlayback.bind(transport);
    transport.stopPlayback = () => { stopped++; orig(); };
    await session.connect();
    socket.onopen!();
    socket.emit({ type: 'input_audio_buffer.speech_started' });
    expect(stopped).toBe(1);
  });

  test('barge-in cancels the active response and suppresses its trailing audio', async () => {
    const { socket, session, sentAudio } = makeSession();
    await session.connect();
    socket.onopen!();
    // A response is in flight and producing audio.
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', delta: Buffer.from([1, 2]).toString('base64') });
    expect(sentAudio).toHaveLength(1);
    socket.sent = [];
    // User barges in mid-response.
    socket.emit({ type: 'input_audio_buffer.speech_started' });
    expect(socket.sentTypes()).toContain('response.cancel');
    // Late deltas from the cancelled response are dropped (not played).
    socket.emit({ type: 'response.output_audio.delta', delta: Buffer.from([3, 4]).toString('base64') });
    expect(sentAudio).toHaveLength(1);
    // The next response clears suppression and plays again.
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', delta: Buffer.from([5, 6]).toString('base64') });
    expect(sentAudio).toHaveLength(2);
  });

  test('barge-in with no active response does not send response.cancel', async () => {
    const { socket, session } = makeSession();
    await session.connect();
    socket.onopen!();
    socket.sent = [];
    socket.emit({ type: 'input_audio_buffer.speech_started' });
    expect(socket.sentTypes()).not.toContain('response.cancel');
  });

  test('error events surface via onError', async () => {
    const { socket, session } = makeSession();
    const errs: string[] = [];
    session.onError((e) => errs.push(e));
    await session.connect();
    socket.onopen!();
    socket.emit({ type: 'error', error: { message: 'boom' } });
    expect(errs).toEqual(['boom']);
  });

  test('swallows benign barge-in cancel race errors (no active response)', async () => {
    const { socket, session } = makeSession();
    const errs: string[] = [];
    session.onError((e) => errs.push(e));
    await session.connect();
    socket.onopen!();
    // Both the message form and the code form must be swallowed.
    socket.emit({ type: 'error', error: { message: 'Cancellation failed: no active response found' } });
    socket.emit({ type: 'error', error: { code: 'response_cancel_not_active', message: 'x' } });
    expect(errs).toEqual([]);
    // A real error still surfaces.
    socket.emit({ type: 'error', error: { message: 'boom' } });
    expect(errs).toEqual(['boom']);
  });

  test('warns when transport input rate is below the realtime 24kHz minimum', async () => {
    const socket = new FakeSocket();
    const transport = new BrowserAudioTransport({ sendAudio: () => {}, inputSampleRate: 16000 });
    const session = new RealtimeSession({
      resolved: RESOLVED,
      tools: [],
      instructions: 'x',
      transport,
      socketFactory: () => socket,
    });
    const errs: string[] = [];
    session.onError((e) => errs.push(e));
    await session.connect();
    expect(errs.some((e) => e.includes('24000') && e.includes('upsampled'))).toBe(true);
  });
});
