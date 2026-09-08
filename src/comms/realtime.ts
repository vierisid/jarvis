/**
 * RealtimeSession — native WebSocket client for OpenAI's GA Realtime API
 * (`gpt-realtime-2`), driving premium speech-to-speech voice.
 *
 * No SDK — raw `fetch`/`WebSocket`, consistent with src/llm/*. JARVIS sits in
 * the middle as an audio relay (via an `AudioTransport`) AND as the tool
 * executor: OpenAI requests a function, the caller gates + runs it, then calls
 * `sendFunctionResult`.
 *
 * Protocol notes (GA, post-2026-05): connect to
 * `wss://api.openai.com/v1/realtime?model=...` with a Bearer key and NO
 * `OpenAI-Beta` header. Session config is nested under `session.audio.{input,output}`
 * with `session.type:'realtime'`; reasoning effort is `session.reasoning.effort`;
 * output events use the `response.output_audio*` names. See
 * docs/GPT_REALTIME_2_INTEGRATION.md.
 */

import type { LLMTool } from '../llm/provider.ts';
import type { ResolvedRealtimeVoice } from '../config/realtime.ts';
import type { AudioTransport } from './audio-transport.ts';


/**
 * OpenAI realtime rejects an input audio rate below 24 kHz
 * (`integer_below_min_value` on `session.audio.input.format.rate`). Transports
 * that capture at a lower rate (e.g. the Pebble's 16 kHz mic) MUST upsample to
 * at least this before streaming. Confirmed via live smoke test 2026-06-01.
 */
export const MIN_REALTIME_INPUT_RATE = 24000;

export type RealtimeFunctionCall = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
};

export type RealtimeTranscript = {
  role: 'user' | 'assistant';
  text: string;
  /** true once the utterance is complete (vs. a streaming delta). */
  final: boolean;
};

/**
 * Per-response usage reported by OpenAI in `response.done`. We feed this into
 * the shared `llm_usage` table so the Usage room can attribute realtime spend
 * the same way it accounts for the text tiers.
 */
export type RealtimeUsage = {
  input_tokens: number;
  output_tokens: number;
  /** Wall-clock since `response.created` for this response, in ms. */
  latency_ms: number;
};

/** Minimal WebSocket surface we depend on — lets tests inject a fake. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
}

export type RealtimeSocketFactory = (
  url: string,
  opts: { headers: Record<string, string> },
) => RealtimeSocket;

export type RealtimeSessionOptions = {
  resolved: ResolvedRealtimeVoice;
  /** Shared tool schema (same `LLMTool[]` the text providers use). */
  tools: LLMTool[];
  /** System prompt / persona for the voice agent. */
  instructions: string;
  /** Audio in/out bridge (browser or Pebble). */
  transport: AudioTransport;
  /** Hashed user id for OpenAI abuse monitoring (optional). */
  safetyIdentifier?: string;
  /** Injectable socket factory (defaults to a Bun WebSocket). */
  socketFactory?: RealtimeSocketFactory;
};

/** Convert shared `LLMTool`s into the GA realtime `tools` entry format. */
export function convertToolsForRealtime(tools: LLMTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** Build the `session.update` payload for a speech-to-speech session. */
export function buildSessionUpdate(
  resolved: ResolvedRealtimeVoice,
  tools: LLMTool[],
  instructions: string,
  inputSampleRate: number,
  outputSampleRate: number,
): Record<string, unknown> {
  const session: Record<string, unknown> = {
    type: 'realtime',
    model: resolved.model,
    output_modalities: ['audio'],
    instructions,
    audio: {
      input: {
        // OpenAI requires rate >= MIN_REALTIME_INPUT_RATE (24kHz).
        format: { type: 'audio/pcm', rate: inputSampleRate },
        // Plain semantic_vad — the low-latency, natural, preamble-friendly
        // default. (server_vad and eagerness tuning both made it worse.) The
        // first-turn "doesn't start" was dropped opening audio, fixed by the
        // transport buffering — not the VAD. Leave this alone.
        turn_detection: { type: 'semantic_vad' },
      },
      output: {
        // `rate` is required on output format too (confirmed via live smoke test).
        format: { type: 'audio/pcm', rate: outputSampleRate },
        ...(resolved.voice ? { voice: resolved.voice } : {}),
      },
    },
    // GA reasoning control lives under `reasoning.effort` (GPT-5 convention).
    reasoning: { effort: resolved.reasoningEffort },
  };

  if (tools.length > 0) {
    session.tools = convertToolsForRealtime(tools);
    session.tool_choice = 'auto';
  }

  return { type: 'session.update', session };
}

/**
 * How long to wait for the realtime socket to open before calling the dial
 * failed. Generous (a cold proxy can take seconds) but bounded, because the
 * caller is holding the user's microphone open while it waits.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Render a close event as `code 1008: reason` for logs. A refused realtime
 * upgrade says everything it is going to say here, so this is usually the only
 * evidence of WHY a session would not open.
 */
function describeSocketClose(ev: unknown): string {
  const e = ev as { code?: unknown; reason?: unknown } | undefined;
  const code = typeof e?.code === 'number' ? e.code : undefined;
  const reason = typeof e?.reason === 'string' ? e.reason.trim() : '';
  return [code !== undefined ? `code ${code}` : '', reason].filter(Boolean).join(': ');
}

function defaultSocketFactory(url: string, opts: { headers: Record<string, string> }): RealtimeSocket {
  // Bun's WebSocket accepts a headers option (non-standard but supported).
  return new WebSocket(url, opts as unknown as string[]) as unknown as RealtimeSocket;
}

export class RealtimeSession {
  private opts: RealtimeSessionOptions;
  private ws: RealtimeSocket | null = null;
  private closed = false;

  // Pending function calls: call_id -> name (captured from output_item.added,
  // joined with arguments from function_call_arguments.done).
  private pendingCalls = new Map<string, string>();

  private audioCb: ((chunk: Buffer) => void) | null = null;
  private transcriptCb: ((t: RealtimeTranscript) => void) | null = null;
  private functionCallCb: ((c: RealtimeFunctionCall) => void) | null = null;
  private usageCb: ((u: RealtimeUsage) => void) | null = null;
  private errorCb: ((err: string) => void) | null = null;
  private openCb: (() => void) | null = null;
  private closeCb: ((detail?: string) => void) | null = null;
  private speechStartedCb: (() => void) | null = null;
  // Response-latency instrumentation (user-stopped → first audio).
  private turnEndedAt = 0;
  private loggedResponseLatency = false;
  // True while the model is generating a response (response.created..done).
  // Gates barge-in cancel so we don't send response.cancel with nothing active
  // (which OpenAI rejects with an error event).
  private responseActive = false;
  // Wall-clock the current response started (response.created), used to compute
  // a per-response latency for the usage record on response.done.
  private responseStartedAt = 0;
  // Set on barge-in: suppress any output audio deltas still arriving from the
  // response we just cancelled, until the next response begins.
  private suppressOutputAudio = false;

  constructor(opts: RealtimeSessionOptions) {
    this.opts = opts;
  }

  onAudio(cb: (chunk: Buffer) => void): void { this.audioCb = cb; }
  onTranscript(cb: (t: RealtimeTranscript) => void): void { this.transcriptCb = cb; }
  onFunctionCall(cb: (c: RealtimeFunctionCall) => void): void { this.functionCallCb = cb; }
  /** Fires once per `response.done` with the token + latency accounting. */
  onUsage(cb: (u: RealtimeUsage) => void): void { this.usageCb = cb; }
  onError(cb: (err: string) => void): void { this.errorCb = cb; }
  onOpen(cb: () => void): void { this.openCb = cb; }
  /** Fired when the socket closes. `detail` carries the close code/reason
   *  when the server gave one: the only explanation a refused session ever
   *  produces, since a rejected upgrade sends no `error` event. */
  onClose(cb: (detail?: string) => void): void { this.closeCb = cb; }
  /** Fired when the model detects the user started speaking (barge-in). */
  onSpeechStarted(cb: () => void): void { this.speechStartedCb = cb; }

  /**
   * Connect, send session.update, and wire the transport's mic + playback.
   *
   * Resolves only once the socket is OPEN, and rejects when the dial fails.
   * That matters more than it looks: this used to resolve the moment the socket
   * object existed, so every caller announced a session as `live` before the
   * server had accepted it. A refused upgrade (revoked key, a plan that does
   * not serve realtime, a wrong endpoint) arrives as a bare `close` with no
   * `error` event, so the pebble went to `listening` on a socket that was
   * already gone and dropped back to idle half a second later with the reason
   * nowhere in either log. Any close or socket error BEFORE open is the dial
   * failing, and it is reported as such.
   */
  connect(): Promise<void> {
    const { resolved, safetyIdentifier, socketFactory, transport } = this.opts;
    const url = `${resolved.url}?model=${encodeURIComponent(resolved.model)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${resolved.apiKey}`,
    };
    if (safetyIdentifier) headers['OpenAI-Safety-Identifier'] = safetyIdentifier;

    if (transport.inputSampleRate < MIN_REALTIME_INPUT_RATE) {
      this.errorCb?.(
        `Transport input rate ${transport.inputSampleRate}Hz is below the realtime ` +
        `minimum of ${MIN_REALTIME_INPUT_RATE}Hz — audio must be upsampled or OpenAI ` +
        `will reject the input buffer.`,
      );
    }

    const factory = socketFactory ?? defaultSocketFactory;
    const ws = factory(url, { headers });
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Close the half-open socket ourselves: without this a proxy that
        // accepts the TCP connection and then never completes the upgrade
        // leaves a dangling socket per press.
        this.close();
        reject(new Error(`realtime socket did not open within ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      ws.onopen = () => {
        this.send(buildSessionUpdate(resolved, this.opts.tools, this.opts.instructions, transport.inputSampleRate, transport.outputSampleRate));
        // Route mic audio straight into the realtime input buffer.
        transport.onMicChunk((pcm) => this.pushAudio(pcm));
        // Route realtime output audio to the speaker.
        this.onAudio((chunk) => transport.playback(chunk));
        // Barge-in: stop playback the moment the user starts talking.
        this.onSpeechStarted(() => transport.stopPlayback());
        this.openCb?.();
        settle();
      };
      ws.onmessage = (ev) => {
        try {
          const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
          this.handleServerEvent(JSON.parse(data));
        } catch (err) {
          this.errorCb?.(`Failed to parse realtime event: ${err}`);
        }
      };
      ws.onerror = () => {
        // Before open this IS the dial failing, so reject rather than fire the
        // live-session error sink, which the caller reads as "a live session
        // hit a problem" and answers by tearing down a session that never was.
        if (!settled) {
          settle(new Error('realtime WebSocket error while connecting'));
          return;
        }
        this.errorCb?.('Realtime WebSocket error');
      };
      ws.onclose = (ev) => {
        this.closed = true;
        const detail = describeSocketClose(ev);
        if (!settled) {
          settle(new Error(`realtime socket closed before it opened${detail ? ` (${detail})` : ''}`));
          return;
        }
        this.closeCb?.(detail || undefined);
      };
    });
  }

  /** Append a PCM s16/mono frame to the realtime input buffer. */
  pushAudio(pcm: Buffer): void {
    if (this.closed) return;
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  /** Return a tool result to the model, then ask it to continue speaking. */
  sendFunctionResult(callId: string, result: unknown): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: typeof result === 'string' ? result : JSON.stringify(result),
      },
    });
    this.send({ type: 'response.create' });
  }

  /** Cancel the in-flight response (used on barge-in). */
  interrupt(): void {
    this.send({ type: 'response.cancel' });
  }

  close(): void {
    this.closed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.closed) return;
    this.ws.send(JSON.stringify(payload));
  }

  /** Dispatch a parsed server event. Exposed for unit testing. */
  handleServerEvent(evt: Record<string, unknown>): void {
    const type = evt.type as string;
    switch (type) {
      case 'input_audio_buffer.speech_stopped': {
        // User finished talking — start the response-latency clock.
        this.turnEndedAt = Date.now();
        this.loggedResponseLatency = false;
        break;
      }
      case 'response.created': {
        // A new response is in flight — clear any barge-in suppression so its
        // audio plays, and arm the cancel gate.
        this.responseActive = true;
        this.suppressOutputAudio = false;
        this.responseStartedAt = Date.now();
        break;
      }
      case 'response.done': {
        this.responseActive = false;
        // Extract per-response usage if present and emit it. OpenAI realtime
        // reports `response.usage.{input_tokens, output_tokens}` (plus audio /
        // text breakdowns we don't currently surface). Missing fields default
        // to 0 so a malformed event doesn't crash the session.
        const resp = (evt.response as Record<string, unknown> | undefined) ?? {};
        const usage = resp.usage as Record<string, unknown> | undefined;
        if (usage && this.usageCb) {
          const input = Number(usage.input_tokens ?? 0);
          const output = Number(usage.output_tokens ?? 0);
          const latency = this.responseStartedAt > 0 ? Date.now() - this.responseStartedAt : 0;
          this.usageCb({
            input_tokens: Number.isFinite(input) ? input : 0,
            output_tokens: Number.isFinite(output) ? output : 0,
            latency_ms: latency,
          });
        }
        this.responseStartedAt = 0;
        break;
      }
      case 'response.output_audio.delta': {
        // Drop deltas from a response we cancelled on barge-in.
        if (this.suppressOutputAudio) break;
        const delta = evt.delta as string | undefined;
        if (delta) {
          if (!this.loggedResponseLatency && this.turnEndedAt > 0) {
            console.log(`[realtime] response latency: ${Date.now() - this.turnEndedAt}ms (user stopped → first audio)`);
            this.loggedResponseLatency = true;
          }
          this.audioCb?.(Buffer.from(delta, 'base64'));
        }
        break;
      }
      case 'response.output_audio_transcript.delta': {
        const delta = evt.delta as string | undefined;
        if (delta) this.transcriptCb?.({ role: 'assistant', text: delta, final: false });
        break;
      }
      case 'response.output_audio_transcript.done': {
        const text = evt.transcript as string | undefined;
        if (text) this.transcriptCb?.({ role: 'assistant', text, final: true });
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = evt.transcript as string | undefined;
        if (text) this.transcriptCb?.({ role: 'user', text, final: true });
        break;
      }
      case 'input_audio_buffer.speech_started': {
        // Barge-in: cancel the in-flight response server-side (stops token/audio
        // billing for speech the user will never hear) and suppress any deltas
        // still in flight from it. `stopPlayback` (local) is wired via the
        // callback; without the cancel, OpenAI keeps generating server-side.
        if (this.responseActive) {
          this.interrupt();
          this.responseActive = false;
          this.suppressOutputAudio = true;
        }
        this.speechStartedCb?.();
        break;
      }
      case 'response.output_item.added': {
        const item = evt.item as { type?: string; name?: string; call_id?: string } | undefined;
        if (item?.type === 'function_call' && item.call_id && item.name) {
          this.pendingCalls.set(item.call_id, item.name);
        }
        break;
      }
      case 'response.function_call_arguments.done': {
        const callId = evt.call_id as string | undefined;
        if (!callId) break;
        // `name` may arrive on this event or earlier via output_item.added.
        const name = (evt.name as string | undefined) ?? this.pendingCalls.get(callId) ?? '';
        this.pendingCalls.delete(callId);
        let args: Record<string, unknown> = {};
        const raw = evt.arguments as string | undefined;
        if (raw) {
          try { args = JSON.parse(raw); } catch { args = {}; }
        }
        if (name) this.functionCallCb?.({ callId, name, args });
        break;
      }
      case 'error': {
        const e = evt.error as { message?: string; code?: string } | undefined;
        const msg = e?.message || 'Unknown realtime error';
        // Benign barge-in race: we sent response.cancel after the model had
        // just finished server-side (its response.done hadn't reached us yet),
        // so there was nothing left to cancel. Harmless — the response is over.
        // Swallow it: surfacing it churned the browser session (it reset the
        // stream on every interrupt → voice_end/voice_start spam).
        if (e?.code === 'response_cancel_not_active' || /no active response|cancellation failed/i.test(msg)) {
          break;
        }
        this.errorCb?.(msg);
        break;
      }
      default:
        // Unhandled event types (session.created/updated, etc.) are
        // intentionally ignored.
        break;
    }
  }
}
