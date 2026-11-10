/**
 * Realtime voice session wiring (Phase 2).
 *
 * Glues a `RealtimeSession` (the OpenAI WS client) to an `AudioTransport`
 * (browser today; Pebble once phase2 lands) and to JARVIS's tool executor.
 * Kept separate from ws-service so the wiring is unit-testable with an injected
 * session factory. See docs/GPT_REALTIME_2_INTEGRATION.md §4 Phase 2.
 */

import {
  REALTIME_INPUT_TRANSCRIPTION_MODEL,
  RealtimeSession,
  type RealtimeSessionOptions,
  type RealtimeTranscript,
} from '../comms/realtime.ts';
import type { AudioTransport } from '../comms/audio-transport.ts';
import type { ResolvedRealtimeVoice } from '../config/realtime.ts';
import type { LLMTool } from '../llm/provider.ts';
import { recordUsage } from '../llm/usage.ts';
import { hostedRealtimeError } from '../util/hosted-error.ts';
import { echoesAssistant, MAX_PENDING_UTTERANCES, RealtimeTaint } from '../agents/realtime-taint.ts';
import { estimateTranscriptionCostUsd } from './realtime-budget.ts';

export type RealtimeVoiceDeps = {
  /** Shared tool schema (same `LLMTool[]` the text providers use). */
  tools: LLMTool[];
  /** System prompt / persona for the voice agent. */
  instructions: string;
  /**
   * Auto-approve tool executor — bind to
   * `orchestrator.executeRealtimeToolCall(name, args, { blockedCategories, taint })`.
   * `taint` is THIS session's (#928): every call the session makes is judged
   * against, and taints, its own marks only. Always resolves to a string
   * (result or denial marker).
   */
  executeToolCall: (name: string, args: Record<string, unknown>, taint: RealtimeTaint) => Promise<string>;
  /** Transcript sink (UI captions + vault writes). */
  onTranscript?: (t: RealtimeTranscript) => void;
  /** Error sink. Receives text that is safe to show the user: on a hosted
   *  session it is the shared hosted copy, never the provider's own words. */
  onError?: (err: string) => void;
  /** Fired when the underlying session closes (for ws-service cleanup).
   *  `detail` is the socket's close code/reason when the server gave one. */
  onClose?: (detail?: string) => void;
  /**
   * The estimated USD cost of one input transcription, billed apart from the
   * session's minutes. The dashboard adds it to the BYO monthly budget; a
   * hosted session leaves billing to the proxy.
   */
  onTranscriptionCostUsd?: (usd: number) => void;
  /** Hashed user id for OpenAI abuse monitoring. */
  safetyIdentifier?: string;
  /** Injectable session factory (tests). Defaults to a real `RealtimeSession`. */
  sessionFactory?: (opts: RealtimeSessionOptions) => RealtimeSession;
};

/**
 * Every realtime voice session not yet closed, on any surface (the
 * dashboard's and each pebble's), so a restart can wait for them to finish
 * speaking (anyRealtimeVoicing).
 */
const liveSessions = new Set<RealtimeVoiceSession>();

/**
 * True while any live realtime session may still be heard: its answer to a
 * tool call is still to come, or its audio is still being sent or played
 * (RealtimeSession.isVoicing). The restart route reads it (#1156).
 */
export function anyRealtimeVoicing(): boolean {
  for (const s of liveSessions) if (s.isVoicing) return true;
  return false;
}

/** Tests only: how many sessions are held (a closed one must not be). */
export function liveRealtimeSessionCount(): number {
  return liveSessions.size;
}

/**
 * Create + wire a realtime voice session. The returned object owns the session
 * lifecycle; the caller pushes mic audio via the transport and calls `close()`
 * on disconnect / session timeout.
 */
export class RealtimeVoiceSession {
  private session: RealtimeSession;
  private deps: RealtimeVoiceDeps;
  private closed = false;
  /**
   * This session's taint (#928). Owned here, not by the callers, for the
   * reason the turn boundary is wired here: it is the same for every surface,
   * and leaving it to each caller is how the pebble once shipped with no
   * boundary at all, and how every surface came to share one set.
   */
  readonly taint = new RealtimeTaint();
  /**
   * What the assistant said that can still be coming back through the mic:
   * the reply being spoken (its deltas so far) and the last finals before it.
   * Audio is played as it streams, so only a reply still playing or just
   * finished can echo; RECENT_REPLIES bounds the finals kept.
   */
  private speaking = '';
  private speakingFor: string | undefined;
  private recentReplies: string[] = [];
  /** Utterance item id -> the assistant speech that could leak into it. */
  private speechAtTurnStart = new Map<string, string[]>();
  private static readonly RECENT_REPLIES = 2;

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
    liveSessions.add(this);

    this.session.onTranscript((t) => {
      if (t.role === 'assistant') this.noteAssistantSpeech(t);
      // Only a final transcript of something the user said clears the
      // session's taint, and only what was read before that utterance began
      // (#1007; see RealtimeTaint). The assistant's own speech heard back
      // through the mic is not something the user said (#1156).
      if (t.role === 'user' && t.final) {
        // Only what was playing or had been said when the utterance began
        // can have leaked into it. A reply to the utterance itself, which
        // often restates it and can be streaming before its transcript
        // lands, cannot be an echo of it (#1156 review).
        const heardBefore = t.itemId ? this.speechAtTurnStart.get(t.itemId) : undefined;
        if (t.itemId) this.speechAtTurnStart.delete(t.itemId);
        if (!echoesAssistant(t.text, heardBefore ?? [])) this.taint.userTranscript(t.itemId, t.text);
      }
      this.deps.onTranscript?.(t);
    });
    // The taint-gating turn boundary, wired HERE rather than by each caller:
    // it is the same events for every surface, and leaving it to the callers
    // is what left the pebble without one. A voice session has no turn
    // objects, so the user's own words are the only thing that clears the
    // session's taint, and `executeRealtimeToolCall` refuses a taint-gated
    // call outright rather than auto-approving it. The VAD start only records
    // where an utterance began; its transcript (above) clears (#1007).
    // Optional call because a test fake of the inner session may not
    // implement it.
    this.session.onUserTurnStart?.((itemId, assistantAudible) => {
      this.taint.userTurnStarted(itemId);
      if (itemId && !this.speechAtTurnStart.has(itemId)) {
        // Only while assistant audio can still be playing can the mic hear
        // it (#1156 review): once it has played out, the person's words are
        // theirs, even when they repeat the last reply.
        this.speechAtTurnStart.set(itemId, assistantAudible === false ? [] : this.assistantSpeech());
        // A cough leaves a start no transcript claims; bounded as RealtimeTaint's are.
        while (this.speechAtTurnStart.size > MAX_PENDING_UTTERANCES) {
          this.speechAtTurnStart.delete(this.speechAtTurnStart.keys().next().value as string);
        }
      }
    });
    // The one place both realtime surfaces (the dashboard socket in ws-service
    // and the pebble in pebble-realtime) receive session errors, so the hosted
    // rule lives here rather than in each of them. The proxy relays upstream
    // realtime `error` events verbatim (LiteLLM does not rewrite websocket
    // frames), and the dashboard prints this string into the chat as a system
    // line: that is how "You have no credits remaining. Add credits..." from
    // the PLATFORM's upstream account reached a tenant. A BYO key keeps the
    // provider's own words, since it is that user's account and the text tells
    // them what to fix.
    const hosted = resolved.provider === 'usejarvis_ai';
    this.session.onError((e) => this.deps.onError?.(hosted ? hostedRealtimeError(e) : e));
    this.session.onClose((detail) => {
      this.closed = true;
      liveSessions.delete(this);
      this.deps.onClose?.(detail);
    });

    // Fold realtime token usage into the shared llm_usage table so the Usage
    // room reports realtime spend alongside the text tiers. Tier is
    // 'conversation' (realtime is the conversational brain when active) and
    // subsystem labels the source; the provider comes from the resolved
    // session (openai for BYO keys, usejarvis_ai for the hosted proxy).
    this.session.onUsage((u) => {
      recordUsage({
        tier: 'conversation',
        resolved_tier: 'conversation',
        subsystem: 'realtime_voice',
        provider: resolved.provider,
        model: resolved.model,
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        latency_ms: u.latency_ms,
      });
    });

    // The user-side transcription (#1007) is billed apart from the response
    // tokens, on its own model. Recorded as its own subsystem so the Usage
    // room shows it, and costed for the BYO budget. Optional call because a
    // test fake of the inner session may not implement it.
    this.session.onTranscriptionUsage?.((u) => {
      recordUsage({
        tier: 'conversation',
        resolved_tier: 'conversation',
        subsystem: 'realtime_transcription',
        provider: resolved.provider,
        model: REALTIME_INPUT_TRANSCRIPTION_MODEL,
        // A duration-billed model reports seconds, not tokens: its row counts
        // the call with no token volume, and its cost reaches the budget
        // below. gpt-4o-mini-transcribe always reports tokens.
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        latency_ms: 0,
      });
      const usd = estimateTranscriptionCostUsd(u);
      if (usd > 0) this.deps.onTranscriptionCostUsd?.(usd);
    });

    // The critical path: model requests a tool -> run it through the
    // auto-approve executor -> return the result so the model keeps talking.
    this.session.onFunctionCall(async (call) => {
      let result: string;
      try {
        result = await this.deps.executeToolCall(call.name, call.args, this.taint);
      } catch (err) {
        result = `Error executing ${call.name}: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (!this.closed) this.session.sendFunctionResult(call.callId, result);
    });
  }

  private noteAssistantSpeech(t: RealtimeTranscript): void {
    if (!t.final) {
      // A reply whose final never came (cancelled) is not run into the next.
      if (t.replyTo !== this.speakingFor) this.speaking = '';
      this.speakingFor = t.replyTo;
      this.speaking += t.text;
      return;
    }
    this.speaking = '';
    this.recentReplies.push(t.text);
    if (this.recentReplies.length > RealtimeVoiceSession.RECENT_REPLIES) this.recentReplies.shift();
  }

  private assistantSpeech(): string[] {
    return this.speaking ? [...this.recentReplies, this.speaking] : [...this.recentReplies];
  }

  connect(): Promise<void> {
    return this.session.connect();
  }

  /** True while the model is answering (see RealtimeSession.isResponding). */
  get isResponding(): boolean {
    return Boolean(this.session.isResponding);
  }

  /** See RealtimeSession.isVoicing. A test fake may not implement it. */
  get isVoicing(): boolean {
    return !this.closed && Boolean(this.session.isVoicing);
  }

  /** Stop the current spoken response without closing the conversation. */
  interrupt(): void {
    if (!this.closed) this.session.interrupt();
  }

  /**
   * The person stopped the reply (the dashboard's stop, a stop phrase): cut
   * the unheard rest from the conversation, as a barge-in does, and stop it.
   */
  stopReply(): void {
    if (this.closed) return;
    // Optional call because a test fake of the inner session may not implement it.
    if (this.session.stopReply) this.session.stopReply();
    else this.session.interrupt();
  }

  close(): void {
    this.closed = true;
    liveSessions.delete(this);
    this.session.close();
  }
}
