/**
 * Realtime voice session wiring (Phase 2).
 *
 * Glues a `RealtimeSession` (the OpenAI WS client) to an `AudioTransport`
 * (browser today; Pebble once phase2 lands) and to JARVIS's tool executor.
 * Kept separate from ws-service so the wiring is unit-testable with an injected
 * session factory. See docs/GPT_REALTIME_2_INTEGRATION.md §4 Phase 2.
 */

import {
  RealtimeSession,
  type RealtimeSessionOptions,
  type RealtimeTranscript,
} from '../comms/realtime.ts';
import type { AudioTransport } from '../comms/audio-transport.ts';
import type { ResolvedRealtimeVoice } from '../config/realtime.ts';
import type { LLMTool } from '../llm/provider.ts';

export type RealtimeVoiceDeps = {
  /** Shared tool schema (same `LLMTool[]` the text providers use). */
  tools: LLMTool[];
  /** System prompt / persona for the voice agent. */
  instructions: string;
  /**
   * Auto-approve tool executor — bind to
   * `orchestrator.executeRealtimeToolCall(name, args, { blockedCategories })`.
   * Always resolves to a string (result or denial marker).
   */
  executeToolCall: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Transcript sink (UI captions + vault writes). */
  onTranscript?: (t: RealtimeTranscript) => void;
  /** Error sink. */
  onError?: (err: string) => void;
  /** Fired when the underlying session closes (for ws-service cleanup). */
  onClose?: () => void;
  /** Hashed user id for OpenAI abuse monitoring. */
  safetyIdentifier?: string;
  /** Injectable session factory (tests). Defaults to a real `RealtimeSession`. */
  sessionFactory?: (opts: RealtimeSessionOptions) => RealtimeSession;
};

/**
 * Create + wire a realtime voice session. The returned object owns the session
 * lifecycle; the caller pushes mic audio via the transport and calls `close()`
 * on disconnect / session timeout.
 */
export class RealtimeVoiceSession {
  private session: RealtimeSession;
  private deps: RealtimeVoiceDeps;
  private closed = false;

  constructor(resolved: ResolvedRealtimeVoice, transport: AudioTransport, deps: RealtimeVoiceDeps) {
    this.deps = deps;
    const opts: RealtimeSessionOptions = {
      resolved,
      tools: deps.tools,
      instructions: deps.instructions,
      transport,
      safetyIdentifier: deps.safetyIdentifier,
    };
    this.session = deps.sessionFactory ? deps.sessionFactory(opts) : new RealtimeSession(opts);

    this.session.onTranscript((t) => this.deps.onTranscript?.(t));
    this.session.onError((e) => this.deps.onError?.(e));
    this.session.onClose(() => {
      this.closed = true;
      this.deps.onClose?.();
    });

    // The critical path: model requests a tool -> run it through the
    // auto-approve executor -> return the result so the model keeps talking.
    this.session.onFunctionCall(async (call) => {
      let result: string;
      try {
        result = await this.deps.executeToolCall(call.name, call.args);
      } catch (err) {
        result = `Error executing ${call.name}: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (!this.closed) this.session.sendFunctionResult(call.callId, result);
    });
  }

  connect(): Promise<void> {
    return this.session.connect();
  }

  close(): void {
    this.closed = true;
    this.session.close();
  }
}
