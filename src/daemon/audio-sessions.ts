/**
 * Audio session buffer for the ambient pebble.
 *
 * Sidecar streams PCM s16 mono 16 kHz audio to the daemon via two events:
 *   - `audio.session_start` — opens a session keyed by session_id
 *   - `audio.session_end` — carries the full PCM as inline base64 binary
 *
 * Once T22 is in place, T23 plugs STT into onSessionEnd to turn the buffer
 * into a transcript and feed it as the real user message to the LLM.
 */

import type { SidecarEvent } from '../sidecar/protocol.ts';

export interface AudioSession {
  sidecarId: string;
  sessionId: string;
  startedAt: number;
  sampleRate: number;
  channels: number;
  format: string; // "pcm_s16le"
}

export interface CompletedAudioSession extends AudioSession {
  endedAt: number;
  durationMs: number;
  pcm: Buffer;
}

export class AudioSessionRegistry {
  private active = new Map<string, AudioSession>();
  private onCompleteListeners = new Set<(session: CompletedAudioSession) => void>();

  /**
   * Hook the registry into the sidecar manager's event stream. Returns a
   * disposer that removes the listener.
   */
  attach(onEvent: (cb: (sidecarId: string, event: SidecarEvent) => void) => void): void {
    onEvent((sidecarId, event) => {
      if (event.event_type === 'audio.session_start') {
        const sessionId = String((event.payload as Record<string, unknown>)?.session_id ?? '');
        if (!sessionId) return;
        const sampleRate = Number((event.payload as Record<string, unknown>)?.sample_rate ?? 16000);
        const channels = Number((event.payload as Record<string, unknown>)?.channels ?? 1);
        const format = String((event.payload as Record<string, unknown>)?.format ?? 'pcm_s16le');
        this.active.set(this.key(sidecarId, sessionId), {
          sidecarId,
          sessionId,
          startedAt: Date.now(),
          sampleRate,
          channels,
          format,
        });
        return;
      }

      if (event.event_type === 'audio.session_end') {
        const payload = event.payload as Record<string, unknown> | undefined;
        const sessionId = String(payload?.session_id ?? '');
        if (!sessionId) return;
        const session = this.active.get(this.key(sidecarId, sessionId));
        this.active.delete(this.key(sidecarId, sessionId));

        const binary = event.binary as { type?: string; data?: string; mime_type?: string } | undefined;
        let pcm = Buffer.alloc(0);
        if (binary && binary.type === 'inline' && typeof binary.data === 'string') {
          try {
            pcm = Buffer.from(binary.data, 'base64');
          } catch (err) {
            console.warn('[audio-sessions] failed to decode inline PCM:', err);
            // Fall through with empty PCM. The session was already removed from
            // `active`, so returning here would strand the caller (pebble stuck
            // 'working', summon slot held). Firing the listeners with empty PCM
            // lets the completion path reset the pebble and release the summon.
          }
        } else {
          // No inline PCM. Large captures are normalized to inline upstream
          // (sidecar connection layer), so reaching here means an empty /
          // zero-length capture — fall through so the completion path still
          // resets state.
          console.warn('[audio-sessions] session_end without inline PCM (empty capture)');
        }

        const durationMs = Number(payload?.duration_ms ?? 0);
        const completed: CompletedAudioSession = {
          sidecarId,
          sessionId,
          startedAt: session?.startedAt ?? Date.now() - durationMs,
          endedAt: Date.now(),
          durationMs,
          sampleRate: session?.sampleRate ?? Number(payload?.sample_rate ?? 16000),
          channels: session?.channels ?? Number(payload?.channels ?? 1),
          format: session?.format ?? String(payload?.format ?? 'pcm_s16le'),
          pcm,
        };

        for (const listener of this.onCompleteListeners) {
          try {
            listener(completed);
          } catch (err) {
            console.warn('[audio-sessions] listener error:', err);
          }
        }
      }
    });
  }

  /** Register a listener for completed sessions (PCM ready for STT). */
  onComplete(listener: (session: CompletedAudioSession) => void): () => void {
    this.onCompleteListeners.add(listener);
    return () => this.onCompleteListeners.delete(listener);
  }

  private key(sidecarId: string, sessionId: string): string {
    return `${sidecarId}::${sessionId}`;
  }
}
