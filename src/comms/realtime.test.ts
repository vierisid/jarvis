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
