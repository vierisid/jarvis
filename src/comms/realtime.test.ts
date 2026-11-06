import { test, expect, describe } from 'bun:test';
import {
  RealtimeSession,
  buildSessionUpdate,
  convertToolsForRealtime,
  type RealtimeSocket,
  type RealtimeSocketFactory,
  type RealtimeSessionOptions,
} from './realtime.ts';
import type { ResolvedRealtimeVoice } from '../config/realtime.ts';
import type { LLMTool } from '../llm/provider.ts';
import { BrowserAudioTransport } from './audio-transport.ts';

const RESOLVED: ResolvedRealtimeVoice = {
  provider: 'openai',
  // Distinct from the OpenAI constant so a re-hardcoded connect() FAILS.
  url: 'wss://proxy.test/v1/realtime',
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
    // The model rides on the connect URL only (see the hosted case below).
    expect('model' in msg.session).toBe(false);
    expect(msg.session.reasoning).toEqual({ effort: 'medium' });
    expect(msg.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    // The user's transcript is what clears a voice session's taint (#1007);
    // without this the server never sends it.
    expect(msg.session.audio.input.transcription).toEqual({ model: 'gpt-4o-mini-transcribe' });
    expect(msg.session.audio.output.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(msg.session.audio.output.voice).toBe('marin');
    expect(msg.session.tools).toHaveLength(1);
    expect(msg.session.tool_choice).toBe('auto');
  });

  // Prod, 2026-09-10: every hosted session died on `invalid_value: Unsupported
  // option for this model.` because the update restated the proxy alias as
  // `session.model`, which the proxy forwards to OpenAI verbatim.
  test('hosted: the proxy alias goes on the URL and never into the session', async () => {
    const hosted: ResolvedRealtimeVoice = { ...RESOLVED, provider: 'usejarvis_ai', model: 'uj-realtime' };
    const socket = new FakeSocket();
    const dialed: string[] = [];
    const session = new RealtimeSession({
      resolved: hosted,
      tools: TOOLS,
      instructions: 'x',
      transport: new BrowserAudioTransport({ sendAudio: () => {}, inputSampleRate: 24000 }),
      socketFactory: (url) => {
        dialed.push(url);
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
    });
    await session.connect();
    expect(dialed[0]).toBe('wss://proxy.test/v1/realtime?model=uj-realtime');
    const update = socket.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'session.update');
    expect(update).toBeTruthy();
    expect(JSON.stringify(update)).not.toContain('uj-realtime');
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

function makeSession(extra: Partial<RealtimeSessionOptions> = {}) {
  const socket = new FakeSocket();
  const dialed: string[] = [];
  // connect() resolves on OPEN now, so a dial that never opens is a dial that
  // failed. Fire onopen a microtask later, the way a real socket would.
  const factory: RealtimeSocketFactory = (url) => {
    dialed.push(String(url));
    queueMicrotask(() => socket.onopen?.());
    return socket;
  };
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
    ...extra,
  });
  return { socket, session, transport, sentAudio, dialed };
}

describe('RealtimeSession lifecycle', () => {
  test('dials resolved.url, not a hardcoded endpoint', async () => {
    const { session, dialed } = makeSession();
    await session.connect();
    expect(dialed[0]).toBe('wss://proxy.test/v1/realtime?model=gpt-realtime-2');
  });

  test('sends session.update on open', async () => {
    const { socket, session } = makeSession();
    await session.connect();
    expect(socket.sentTypes()).toContain('session.update');
  });

  // The pebble bug: a proxy that refuses the upgrade (revoked key, a plan that
  // does not serve realtime, wrong endpoint) closes the socket without ever
  // sending an `error` event. connect() used to resolve regardless, so callers
  // announced the session `live`, flipped the pebble to listening, and dropped
  // back to idle when the close landed -- with the reason nowhere in sight.
  test('connect() rejects when the socket closes before it opens', async () => {
    const socket = new FakeSocket();
    const session = new RealtimeSession({
      resolved: RESOLVED,
      tools: [],
      instructions: 'x',
      transport: new BrowserAudioTransport({ sendAudio: () => {}, inputSampleRate: 24000 }),
      socketFactory: () => {
        queueMicrotask(() => socket.onclose?.({ code: 1008, reason: 'model not in plan' }));
        return socket;
      },
    });
    // The close code and reason are the server's only explanation, so they have
    // to survive into the error the caller logs.
    await expect(session.connect()).rejects.toThrow(/closed before it opened.*1008.*model not in plan/);
  });

  test('connect() rejects when the socket errors before it opens', async () => {
    const socket = new FakeSocket();
    const session = new RealtimeSession({
      resolved: RESOLVED,
      tools: [],
      instructions: 'x',
      transport: new BrowserAudioTransport({ sendAudio: () => {}, inputSampleRate: 24000 }),
      socketFactory: () => {
        queueMicrotask(() => socket.onerror?.({}));
        return socket;
      },
    });
    await expect(session.connect()).rejects.toThrow(/while connecting/);
  });

  test('a close AFTER open reports the code/reason to onClose, not to connect()', async () => {
    const { socket, session } = makeSession();
    const closes: Array<string | undefined> = [];
    session.onClose((detail) => closes.push(detail));
    await session.connect();
    socket.onclose!({ code: 1011, reason: 'upstream error' });
    expect(closes).toEqual(['code 1011: upstream error']);
  });

  test('mic chunks become input_audio_buffer.append', async () => {
    const { socket, session, transport } = makeSession();
    await session.connect();
    (transport as BrowserAudioTransport).pushMicChunk(Buffer.from([1, 2, 3, 4]));
    const appendMsg = socket.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'input_audio_buffer.append');
    expect(appendMsg).toBeTruthy();
    expect(appendMsg.audio).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
  });

  test('output audio delta is decoded and routed to transport playback', async () => {
    const { socket, session, sentAudio } = makeSession();
    await session.connect();
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
    socket.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello' });
    socket.emit({ type: 'response.output_audio_transcript.done', transcript: 'hi there' });
    expect(got).toEqual([
      { role: 'user', text: 'hello', final: true },
      { role: 'assistant', text: 'hi there', final: true },
    ]);
  });

  // #1007: input transcription is billed apart from the response tokens.
  test('an input transcription\'s usage is emitted, tokens or duration, even with no words', async () => {
    const { socket, session } = makeSession();
    const got: unknown[] = [];
    session.onTranscriptionUsage((u) => got.push(u));
    await session.connect();
    socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'hello',
      usage: { type: 'tokens', input_tokens: 120, output_tokens: 4, total_tokens: 124, input_token_details: { audio_tokens: 120, text_tokens: 0 } } });
    socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i2', transcript: '',
      usage: { type: 'tokens', input_tokens: 30, output_tokens: 0, total_tokens: 30 } });
    socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i3', transcript: 'hi',
      usage: { type: 'duration', seconds: 2.5 } });
    socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i4', transcript: 'no usage' });
    socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i5', transcript: 'junk',
      usage: { type: 'tokens', input_tokens: 'many', output_tokens: -3 } });
    // Mixed: the valid count is kept, the negative one clamped to 0.
    socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i6', transcript: 'mixed',
      usage: { type: 'tokens', input_tokens: 100, output_tokens: -3 } });
    expect(got).toEqual([
      { input_tokens: 120, output_tokens: 4 },
      { input_tokens: 30, output_tokens: 0 },
      { input_tokens: 0, output_tokens: 0, seconds: 2.5 },
      { input_tokens: 100, output_tokens: 0 },
    ]);
  });

  test('function call (name from output_item.added + args from done) is emitted', async () => {
    const { socket, session } = makeSession();
    const calls: any[] = [];
    session.onFunctionCall((c) => calls.push(c));
    await session.connect();
    socket.emit({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c1', name: 'read_file' } });
    socket.emit({ type: 'response.function_call_arguments.done', call_id: 'c1', arguments: '{"path":"/etc/hosts"}' });
    expect(calls).toEqual([{ callId: 'c1', name: 'read_file', args: { path: '/etc/hosts' } }]);
  });

  test('sendFunctionResult emits function_call_output + response.create', async () => {
    const { socket, session } = makeSession();
    await session.connect();
    socket.sent = [];
    session.sendFunctionResult('c1', { ok: true });
    expect(socket.sentTypes()).toEqual(['conversation.item.create', 'response.create']);
    const item = JSON.parse(socket.sent[0]!).item;
    expect(item).toEqual({ type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' });
  });

  // Prod proxy, 2026-09-10: a reply with two tool calls sent one response.create
  // per result; OpenAI refused the second with
  // conversation_already_has_active_response and the pebble died on the error.
  describe('tool results and response.create', () => {
    const handOut = (socket: FakeSocket, callId: string) => {
      socket.emit({ type: 'response.output_item.added', item: { type: 'function_call', call_id: callId, name: 'open_dashboard_room' } });
      socket.emit({ type: 'response.function_call_arguments.done', call_id: callId, arguments: '{"room":"settings"}' });
    };
    const started = async (extra: Partial<RealtimeSessionOptions> = {}) => {
      const s = makeSession(extra);
      s.session.onFunctionCall(() => {});
      await s.session.connect();
      s.socket.sent = [];
      return s;
    };

    test('two calls in one reply: ONE response.create, once both results are in and the reply is done', async () => {
      const { socket, session } = await started();
      socket.emit({ type: 'response.created' });
      handOut(socket, 'c1');
      handOut(socket, 'c2');
      session.sendFunctionResult('c1', 'ok');
      socket.emit({ type: 'response.done', response: {} });
      expect(socket.sentTypes()).toEqual(['conversation.item.create']); // c2 still running
      session.sendFunctionResult('c2', 'ok');
      expect(socket.sentTypes()).toEqual(['conversation.item.create', 'conversation.item.create', 'response.create']);
    });

    test('a result that lands before response.done waits for it', async () => {
      const { socket, session } = await started();
      socket.emit({ type: 'response.created' });
      handOut(socket, 'c1');
      session.sendFunctionResult('c1', 'ok');
      expect(socket.sentTypes()).toEqual(['conversation.item.create']);
      socket.emit({ type: 'response.done', response: {} });
      expect(socket.sentTypes()).toEqual(['conversation.item.create', 'response.create']);
    });

    test('a result while our response.create is unacknowledged is voiced after that response', async () => {
      const { socket, session } = await started();
      session.sendFunctionResult('c1', 'ok');
      session.sendFunctionResult('c2', 'ok');
      expect(socket.sentTypes()).toEqual(['conversation.item.create', 'response.create', 'conversation.item.create']);
      socket.emit({ type: 'response.created' });
      socket.emit({ type: 'response.done', response: {} });
      expect(socket.sentTypes().filter((t) => t === 'response.create')).toHaveLength(2);
    });

    test('a refusal because the server already started a response is not fatal and is retried after it', async () => {
      const { socket, session } = await started();
      const errs: string[] = [];
      session.onError((e) => errs.push(e));
      session.sendFunctionResult('c1', 'ok');
      socket.emit({ type: 'response.created' }); // the VAD's response, not ours
      socket.emit({ type: 'error', error: { code: 'conversation_already_has_active_response', message: 'Conversation already has an active response in progress' } });
      expect(errs).toEqual([]);
      socket.emit({ type: 'response.done', response: {} });
      expect(socket.sentTypes()).toEqual(['conversation.item.create', 'response.create', 'response.create']);
    });

    test('barge-in drops a deferred response.create: the user turn response sees the tool output', async () => {
      const { socket, session } = await started();
      socket.emit({ type: 'response.created' });
      handOut(socket, 'c1');
      session.sendFunctionResult('c1', 'ok');
      socket.emit({ type: 'input_audio_buffer.speech_started' });
      socket.emit({ type: 'response.done', response: { status: 'cancelled' } });
      socket.emit({ type: 'response.created' }); // the VAD answering the user
      socket.emit({ type: 'response.done', response: {} });
      expect(socket.sentTypes()).toEqual(['conversation.item.create', 'response.cancel']);
    });

    test('a result landing while the user still has the turn is not voiced over them', async () => {
      const { socket, session } = await started();
      socket.emit({ type: 'response.created' });
      handOut(socket, 'c1');
      socket.emit({ type: 'input_audio_buffer.speech_started' });
      session.sendFunctionResult('c1', 'ok'); // the tool returns mid-utterance
      socket.emit({ type: 'response.done', response: { status: 'cancelled' } });
      expect(socket.sentTypes()).toEqual(['response.cancel', 'conversation.item.create']);
      socket.emit({ type: 'response.created' }); // the VAD's reply sees the output
      socket.emit({ type: 'response.done', response: {} });
      expect(socket.sentTypes()).not.toContain('response.create');
      // The gate is lifted: a later result is voiced as usual.
      session.sendFunctionResult('c2', 'ok');
      expect(socket.sentTypes().at(-1)).toBe('response.create');
    });

    test('a call that never returns holds the reply back only for the grace, then stops blocking', async () => {
      const { socket, session } = await started({ toolResultGraceMs: 20 });
      socket.emit({ type: 'response.created' });
      handOut(socket, 'c1');
      handOut(socket, 'hung');
      socket.emit({ type: 'response.done', response: {} });
      session.sendFunctionResult('c1', 'ok');
      expect(socket.sentTypes()).toEqual(['conversation.item.create']);
      await new Promise((r) => setTimeout(r, 60));
      expect(socket.sentTypes()).toEqual(['conversation.item.create', 'response.create']);
      socket.emit({ type: 'response.created' });
      socket.emit({ type: 'response.done', response: {} });
      // A later reply's call is voiced at once: the hung one no longer counts.
      socket.emit({ type: 'response.created' });
      handOut(socket, 'c3');
      socket.emit({ type: 'response.done', response: {} });
      session.sendFunctionResult('c3', 'ok');
      expect(socket.sentTypes().at(-1)).toBe('response.create');
      expect(socket.sentTypes().filter((t) => t === 'response.create')).toHaveLength(2);
    });

    test('a late result after the grace is still voiced on its own', async () => {
      const { socket, session } = await started({ toolResultGraceMs: 20 });
      socket.emit({ type: 'response.created' });
      handOut(socket, 'c1');
      handOut(socket, 'slow');
      socket.emit({ type: 'response.done', response: {} });
      session.sendFunctionResult('c1', 'ok');
      await new Promise((r) => setTimeout(r, 60));
      socket.emit({ type: 'response.created' });
      socket.emit({ type: 'response.done', response: {} });
      session.sendFunctionResult('slow', 'finally');
      expect(socket.sentTypes().filter((t) => t === 'response.create')).toHaveLength(2);
    });

    test('a long call from an earlier reply does not hold back the next reply', async () => {
      const { socket, session } = await started();
      socket.emit({ type: 'response.created' });
      handOut(socket, 'delegate'); // still running
      socket.emit({ type: 'response.done', response: {} });
      socket.emit({ type: 'response.created' }); // the user asks for something else
      handOut(socket, 'nav');
      socket.emit({ type: 'response.done', response: {} });
      session.sendFunctionResult('nav', 'ok');
      expect(socket.sentTypes()).toEqual(['conversation.item.create', 'response.create']);
    });

    test("a grace expiring during the user's turn waits for the VAD reply, which sees the output", async () => {
      const { socket, session } = await started({ toolResultGraceMs: 20 });
      socket.emit({ type: 'response.created' });
      handOut(socket, 'c1');
      handOut(socket, 'c2');
      socket.emit({ type: 'response.done', response: {} });
      session.sendFunctionResult('c1', 'ok');
      socket.emit({ type: 'input_audio_buffer.speech_started' });
      await new Promise((r) => setTimeout(r, 60));
      expect(socket.sentTypes()).toEqual(['conversation.item.create']);
      socket.emit({ type: 'response.created' });
      socket.emit({ type: 'response.done', response: {} });
      expect(socket.sentTypes()).toEqual(['conversation.item.create']);
    });

    test('a grace expiring after a stop dropped the result sends nothing', async () => {
      const { socket, session } = await started({ toolResultGraceMs: 20 });
      socket.emit({ type: 'response.created' });
      handOut(socket, 'c1');
      handOut(socket, 'c2');
      socket.emit({ type: 'response.done', response: {} });
      session.sendFunctionResult('c1', 'ok');
      session.interrupt();
      await new Promise((r) => setTimeout(r, 60));
      expect(socket.sentTypes()).toEqual(['conversation.item.create', 'response.cancel']);
    });

    test('our own response starting mid-utterance does not end the user turn', async () => {
      const { socket, session } = await started();
      const creates = () => socket.sentTypes().filter((t) => t === 'response.create').length;
      session.sendFunctionResult('c0', 'ok'); // response.create, not yet acknowledged
      socket.emit({ type: 'input_audio_buffer.speech_started' });
      socket.emit({ type: 'response.created' }); // ours, not the VAD's
      session.sendFunctionResult('c1', 'ok');
      socket.emit({ type: 'response.done', response: {} });
      expect(creates()).toBe(1);
      socket.emit({ type: 'response.created' }); // the VAD's reply
      socket.emit({ type: 'response.done', response: {} });
      expect(creates()).toBe(1);
    });

    test('without an onFunctionCall handler, calls are not waited on', async () => {
      const { socket, session } = makeSession();
      await session.connect();
      socket.sent = [];
      socket.emit({ type: 'response.created' });
      handOut(socket, 'c1');
      socket.emit({ type: 'response.done', response: {} });
      session.sendFunctionResult('c2', 'ok');
      expect(socket.sentTypes()).toEqual(['conversation.item.create', 'response.create']);
    });

    test("the dashboard's stop also drops tool results waiting to be voiced", async () => {
      const { socket, session } = await started();
      socket.emit({ type: 'response.created' });
      handOut(socket, 'c1');
      session.sendFunctionResult('c1', 'ok');
      session.interrupt();
      socket.emit({ type: 'response.done', response: { status: 'cancelled' } });
      expect(socket.sentTypes()).toEqual(['conversation.item.create', 'response.cancel']);
    });
  });

  test('speech_started triggers transport.stopPlayback (barge-in)', async () => {
    const { socket, session, transport } = makeSession();
    let stopped = 0;
    const orig = transport.stopPlayback.bind(transport);
    transport.stopPlayback = () => { stopped++; orig(); };
    await session.connect();
    socket.emit({ type: 'input_audio_buffer.speech_started' });
    expect(stopped).toBe(1);
  });

  test('barge-in cancels the active response and suppresses its trailing audio', async () => {
    const { socket, session, sentAudio } = makeSession();
    await session.connect();
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

  test('barge-in drops the cancelled response\'s trailing transcript fragments, not its final', async () => {
    const { socket, session } = makeSession();
    const got: Array<{ role: string; text: string; final: boolean; interrupted?: boolean }> = [];
    session.onTranscript((t) => got.push(t));
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio_transcript.delta', delta: 'Here is' });
    socket.emit({ type: 'input_audio_buffer.speech_started' });
    // Unheard words from the cancelled reply.
    socket.emit({ type: 'response.output_audio_transcript.delta', delta: ' the rest' });
    socket.emit({ type: 'response.output_audio_transcript.done', transcript: 'Here is the rest' });
    // The final still reaches the dashboard, which shows only finals.
    expect(got).toEqual([
      { role: 'assistant', text: 'Here is', final: false },
      { role: 'assistant', text: 'Here is the rest', final: true, interrupted: true },
    ]);
    // The next reply is shown again.
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio_transcript.done', transcript: 'Okay.' });
    expect(got.at(-1)).toEqual({ role: 'assistant', text: 'Okay.', final: true });
  });

  test('response.done emits a usage event with token totals and latency', async () => {
    const { socket, session } = makeSession();
    const events: Array<{ input_tokens: number; output_tokens: number; latency_ms: number }> = [];
    session.onUsage((u) => events.push(u));
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({
      type: 'response.done',
      response: { usage: { input_tokens: 42, output_tokens: 17 } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.input_tokens).toBe(42);
    expect(events[0]!.output_tokens).toBe(17);
    expect(events[0]!.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test('response.done with no usage object does NOT fire onUsage', async () => {
    const { socket, session } = makeSession();
    const events: unknown[] = [];
    session.onUsage((u) => events.push(u));
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.done', response: {} });
    expect(events).toHaveLength(0);
  });

  test('barge-in with no active response does not send response.cancel', async () => {
    const { socket, session } = makeSession();
    await session.connect();
    socket.sent = [];
    socket.emit({ type: 'input_audio_buffer.speech_started' });
    expect(socket.sentTypes()).not.toContain('response.cancel');
  });

  test('error events surface via onError', async () => {
    const { socket, session } = makeSession();
    const errs: string[] = [];
    session.onError((e) => errs.push(e));
    await session.connect();
    socket.emit({ type: 'error', error: { message: 'boom' } });
    expect(errs).toEqual(['boom']);
  });

  test('swallows benign barge-in cancel race errors (no active response)', async () => {
    const { socket, session } = makeSession();
    const errs: string[] = [];
    session.onError((e) => errs.push(e));
    await session.connect();
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
      socketFactory: () => {
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
    });
    const errs: string[] = [];
    session.onError((e) => errs.push(e));
    await session.connect();
    expect(errs.some((e) => e.includes('24000') && e.includes('upsampled'))).toBe(true);
  });
});

describe('RealtimeSession.isResponding', () => {
  test('is true from response.created until response.done', async () => {
    const { socket, session } = makeSession();
    await session.connect();
    expect(session.isResponding).toBe(false);
    socket.emit({ type: 'response.created' });
    expect(session.isResponding).toBe(true);
    socket.emit({ type: 'response.done', response: {} });
    expect(session.isResponding).toBe(false);
  });

  test('counts a response requested for tool output before it starts', async () => {
    const { session } = makeSession();
    await session.connect();
    session.sendFunctionResult('c1', 'ok');
    expect(session.isResponding).toBe(true);
  });

  test('tool output held back by the user turn does not count as responding', async () => {
    const { socket, session } = makeSession();
    session.onFunctionCall(() => {});
    await session.connect();
    socket.emit({ type: 'input_audio_buffer.speech_started' });
    session.sendFunctionResult('c1', 'ok');
    expect(session.isResponding).toBe(false);
  });
});

describe('RealtimeSession.connect after its error sink closed it', () => {
  test('does not dial, and rejects', async () => {
    let dialed = 0;
    const session = new RealtimeSession({
      resolved: RESOLVED,
      tools: [],
      instructions: 'x',
      transport: new BrowserAudioTransport({ sendAudio: () => {}, inputSampleRate: 16000 }),
      socketFactory: () => { dialed++; return new FakeSocket(); },
    });
    session.onError(() => session.close());
    await expect(session.connect()).rejects.toThrow(/closed before it connected/);
    expect(dialed).toBe(0);
  });
});

describe('#1156: barge-in truncates the unheard part of the reply', () => {
  // 24 kHz s16 mono: 48 bytes a millisecond.
  const audio = (ms: number) => Buffer.alloc(ms * 48).toString('base64');

  function clocked() {
    let t = 1_000;
    const made = makeSession({ now: () => t });
    return { ...made, advance: (ms: number) => { t += ms; } };
  }

  test('sends conversation.item.truncate at the time played so far', async () => {
    const { socket, session, advance } = clocked();
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(3000) });
    socket.emit({ type: 'response.done', response: {} });
    advance(1200);
    socket.sent = [];
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user_2' });
    const truncate = socket.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'conversation.item.truncate');
    expect(truncate).toMatchObject({ item_id: 'item_a', content_index: 0, audio_end_ms: 1200 });
  });

  test('two chunks of one item count as one item\'s audio', async () => {
    const { socket, session, advance } = clocked();
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(500) });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(500) });
    advance(400);
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user_2' });
    const truncate = socket.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'conversation.item.truncate');
    expect(truncate?.audio_end_ms).toBe(400);
  });

  test('a response still generating is cut at the end of the audio that arrived, never past it', async () => {
    const { socket, session, advance } = clocked();
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(500) });
    advance(2000);
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user_2' });
    const truncate = socket.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'conversation.item.truncate');
    expect(truncate).toMatchObject({ item_id: 'item_a', audio_end_ms: 500 });
  });

  test('an item queued behind another starts when that one ends, and each is cut where playback is', async () => {
    const { socket, session, advance } = clocked();
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(1000) });
    socket.emit({ type: 'response.done', response: {} });
    advance(100);
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_b', content_index: 0, delta: audio(2000) });
    socket.emit({ type: 'response.done', response: {} });
    // 600ms in: item_a (0..1000) is playing, item_b (1000..3000) has not begun.
    advance(500);
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user_2' });
    const cuts = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'conversation.item.truncate')
      .map((m) => [m.item_id, m.audio_end_ms]);
    expect(cuts).toEqual([['item_a', 600], ['item_b', 0]]);
  });

  test('a stall inside one item keeps the cut relative to the item (#1156 review)', async () => {
    const { socket, session, advance } = clocked();
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(500) });
    advance(700); // all 500ms played; generation stalls
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(500) });
    advance(200);
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user_2' });
    const cuts = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'conversation.item.truncate');
    expect(cuts.map((m) => [m.item_id, m.audio_end_ms])).toEqual([['item_a', 700]]);
  });

  test('a stop cuts the unheard rest and starts the next reply\'s clock afresh (#1156 review)', async () => {
    const { socket, session, advance } = clocked();
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(5000) });
    socket.emit({ type: 'response.done', response: {} });
    advance(1000);
    socket.sent = [];
    session.stopReply();
    const cut = socket.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'conversation.item.truncate');
    expect(cut).toMatchObject({ item_id: 'item_a', audio_end_ms: 1000 });
    expect(socket.sentTypes()).toContain('response.cancel');
    // The client flushed item_a: the next reply plays from its arrival.
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_b', content_index: 0, delta: audio(3000) });
    advance(400);
    socket.sent = [];
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user_3' });
    const cuts = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'conversation.item.truncate');
    expect(cuts.map((m) => [m.item_id, m.audio_end_ms])).toEqual([['item_b', 400]]);
  });

  test('a stop during a response ignores its in-flight audio, so a later barge-in cuts nothing heard (#1156 review)', async () => {
    const { socket, session, advance, sentAudio } = clocked();
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(2000) });
    advance(1000);
    session.stopReply();
    const played = sentAudio.length;
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(500) });
    expect(sentAudio.length).toBe(played);
    advance(300);
    socket.sent = [];
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user_2' });
    expect(socket.sentTypes()).not.toContain('conversation.item.truncate');
    expect(socket.sentTypes()).not.toContain('response.cancel');
  });

  test('an earlier item all played is not cut because a new response has started', async () => {
    const { socket, session, advance } = clocked();
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(300) });
    socket.emit({ type: 'response.done', response: {} });
    advance(500);
    socket.emit({ type: 'response.created' }); // no audio from it yet
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user_2' });
    expect(socket.sentTypes()).not.toContain('conversation.item.truncate');
  });

  test('a hosted session sends no truncate until the proxy is known to relay it', async () => {
    let t = 1_000;
    const { socket, session } = makeSession({ now: () => t, resolved: { ...RESOLVED, provider: 'usejarvis_ai' } });
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(3000) });
    t += 500;
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user_2' });
    expect(socket.sentTypes()).not.toContain('conversation.item.truncate');
    expect(socket.sentTypes()).toContain('response.cancel');
  });

  test('sends nothing once all of it can have played', async () => {
    const { socket, session, advance } = clocked();
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(800) });
    socket.emit({ type: 'response.done', response: {} });
    advance(800);
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user_2' });
    expect(socket.sentTypes()).not.toContain('conversation.item.truncate');
  });

  test('a refused truncate does not end the session; other errors still do', async () => {
    const { socket, session, advance } = clocked();
    const errs: string[] = [];
    session.onError((e) => errs.push(e));
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio.delta', item_id: 'item_a', content_index: 0, delta: audio(3000) });
    advance(100);
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user_2' });
    const truncate = socket.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'conversation.item.truncate');
    socket.emit({ type: 'error', error: { message: 'audio_end_ms is too large', event_id: truncate.event_id } });
    expect(errs).toEqual([]);
    socket.emit({ type: 'error', error: { message: 'boom', event_id: 'someone_else' } });
    expect(errs).toEqual(['boom']);
  });
});

describe('#1156: an assistant transcript names the utterance it answers', () => {
  test('replyTo is the utterance begun before the reply started', async () => {
    const { socket, session } = makeSession();
    const got: Array<Record<string, unknown>> = [];
    session.onTranscript((t) => got.push(t));
    await session.connect();
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user_1' });
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio_transcript.done', transcript: 'Sure.' });
    // The user's own line lands after the reply to it.
    socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user_1', transcript: 'Hi there' });
    expect(got).toEqual([
      { role: 'assistant', text: 'Sure.', final: true, replyTo: 'user_1' },
      { role: 'user', text: 'Hi there', final: true, itemId: 'user_1' },
    ]);
  });

  test('a reply with no utterance before it carries none', async () => {
    const { socket, session } = makeSession();
    const got: Array<Record<string, unknown>> = [];
    session.onTranscript((t) => got.push(t));
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_audio_transcript.done', transcript: 'Hello.' });
    expect(got).toEqual([{ role: 'assistant', text: 'Hello.', final: true }]);
  });
});

describe('#1156: isVoicing, which a restart waits on', () => {
  const audio = (ms: number) => Buffer.alloc(ms * 48).toString('base64');

  test('covers the restart call, its voiced answer, and that answer playing out', async () => {
    let t = 1_000;
    const { socket, session } = makeSession({ now: () => t });
    // RealtimeVoiceSession always registers one; a call is only awaited then.
    session.onFunctionCall(() => {});
    await session.connect();
    expect(session.isVoicing).toBe(false);
    // The model asks for restart_daemon.
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.output_item.added', item: { type: 'function_call', name: 'navigate', call_id: 'c1' } });
    socket.emit({ type: 'response.function_call_arguments.done', call_id: 'c1', arguments: '{}' });
    socket.emit({ type: 'response.done', response: {} });
    // The route runs here: the call has no result yet, so the answer is still to come.
    expect(session.isVoicing).toBe(true);
    session.sendFunctionResult('c1', 'Restarting Jarvis.');
    expect(session.isVoicing).toBe(true);
    socket.emit({ type: 'response.created' });
    expect(session.isVoicing).toBe(true);
    socket.emit({ type: 'response.output_audio.delta', item_id: 'a1', content_index: 0, delta: audio(3000) });
    socket.emit({ type: 'response.done', response: {} });
    // Sent whole, but 3s of it can still be playing.
    t += 2_999;
    expect(session.isVoicing).toBe(true);
    t += 1;
    expect(session.isVoicing).toBe(false);
  });

  test('an answer held back while the person talks is still to come', async () => {
    const { socket, session } = makeSession();
    session.onFunctionCall(() => {});
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'navigate', arguments: '{}' });
    socket.emit({ type: 'response.done', response: {} });
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'u2' });
    session.sendFunctionResult('c1', 'Restarting Jarvis.');
    // Not requested yet (the user has the turn), but it will be voiced.
    expect(session.isVoicing).toBe(true);
  });

  test('a newer response does not hide a result still to come', async () => {
    const { socket, session } = makeSession();
    session.onFunctionCall(() => {});
    await session.connect();
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'navigate', arguments: '{}' });
    socket.emit({ type: 'response.done', response: {} });
    // A response of its own (a barge-in, an echo) runs and ends while the
    // room action is out; it clears the calls that gate response.create.
    socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'u2' });
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.done', response: {} });
    expect(session.isVoicing).toBe(true);
    session.sendFunctionResult('c1', 'Restarting Jarvis.');
    socket.emit({ type: 'response.created' });
    socket.emit({ type: 'response.done', response: {} });
    expect(session.isVoicing).toBe(false);
  });

  test('a closed session is never voicing', async () => {
    const { socket, session } = makeSession();
    await session.connect();
    socket.emit({ type: 'response.created' });
    expect(session.isVoicing).toBe(true);
    socket.close();
    expect(session.isVoicing).toBe(false);
  });
});
