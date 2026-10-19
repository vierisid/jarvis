import type { LLMStreamEvent } from '../llm/provider.ts';
import type { WebSocketServer, WSMessage } from './websocket.ts';
import { chatErrorPayload } from '../failures/chat.ts';
import { failureEvidence } from '../failures/evidence.ts';
import type { UserFailure } from '../failures/projection.ts';

export type RelayOptions = {
  /** Called each time a complete sentence is available during streaming. */
  onSentence?: (sentence: string) => void;
  /** Called when all text is done streaming. */
  onTextDone?: () => void;
  /** Stops relaying immediately when the owning client cancels/supersedes the turn. */
  signal?: AbortSignal;
  /** Called once, immediately before the first visible text chunk is relayed. */
  onTextStart?: () => void;
  /**
   * Q-19: whether a tool call can change something outside Jarvis. A turn that
   * failed after one never reads "nothing was done". Absent, every call counts.
   */
  mayAct?: (call: { name: string; arguments: Record<string, unknown> }) => boolean;
};

// Sentence boundary: period, exclamation, question mark, colon followed by
// whitespace or end.
//
// The terminator must be followed by whitespace, NOT by end-of-buffer: this
// buffer holds a partial token stream, so "end of what has arrived" is not end
// of sentence. Treating it as one splits "Version 1.5" into "Version 1." /
// "5" whenever a chunk happens to end on the period. A producer that knows its
// text is complete says so with `segmentEnd` instead.
const SENTENCE_END_RE = /[.!?:]\s/;

export class StreamRelay {
  private wsServer: WebSocketServer;

  constructor(wsServer: WebSocketServer, private readonly deliver?: (message: WSMessage) => void) {
    this.wsServer = wsServer;
  }

  private emit(message: WSMessage): void {
    if (this.deliver) this.deliver(message);
    else this.wsServer.broadcast(message);
  }

  /**
   * Relay LLM stream events to all connected WebSocket clients.
   * Accumulates and returns the complete response text.
   * Optionally fires onSentence callback as complete sentences arrive.
   */
  async relayStream(
    stream: AsyncIterable<LLMStreamEvent>,
    requestId: string,
    options?: RelayOptions,
  ): Promise<string> {
    let fullText = '';
    let sentenceBuffer = '';
    let streamError: string | null = null;
    let streamFailure: UserFailure | null = null;
    let textStarted = false;
    // Q-19: a turn that already called a tool may have changed something.
    let toolsRan = false;

    try {
      for await (const event of stream) {
        if (options?.signal?.aborted) break;
        if (event.type === 'text') {
          if (event.text) {
            if (!textStarted) {
              textStarted = true;
              options?.onTextStart?.();
            }
            fullText += event.text;
          }

          // Sentence-level TTS callback
          if (options?.onSentence) {
            sentenceBuffer += event.text;
            // Flush complete sentences from the buffer
            let match: RegExpExecArray | null;
            while ((match = SENTENCE_END_RE.exec(sentenceBuffer)) !== null) {
              const end = match.index + match[0].length;
              const sentence = sentenceBuffer.slice(0, end).trim();
              if (sentence) {
                options.onSentence(sentence);
              }
              sentenceBuffer = sentenceBuffer.slice(end);
            }
            // The producer says this text is a finished unit (an acknowledgment
            // ahead of slow tool work), so speak it now rather than waiting for
            // the next segment or the end of the stream.
            if (event.segmentEnd && sentenceBuffer.trim()) {
              options.onSentence(sentenceBuffer.trim());
              sentenceBuffer = '';
            }
          }

          // An empty text event carries only the segmentEnd signal — there is
          // nothing for clients to render.
          if (!event.text) continue;

          // Broadcast chunk to all connected clients
          const message: WSMessage = {
            type: 'stream',
            payload: {
              text: event.text,
              requestId,
              accumulated: fullText,
            },
            id: requestId,
            timestamp: Date.now(),
          };

          this.emit(message);
        } else if (event.type === 'tool_call') {
          if (options?.mayAct?.(event.tool_call) ?? true) toolsRan = true;
          // Broadcast tool call notification to clients
          const toolMessage: WSMessage = {
            type: 'stream',
            payload: {
              tool_call: {
                name: event.tool_call.name,
                arguments: event.tool_call.arguments,
              },
              requestId,
            },
            id: requestId,
            timestamp: Date.now(),
          };

          this.emit(toolMessage);
        } else if (event.type === 'error') {
          console.error('[StreamRelay] Stream error:', event.error);

          // Q-19: the typed code the LLM layer attached, never a guess from
          // the wording here; the failure the dashboard renders as it is.
          const payload = chatErrorPayload(event.code ? { source: 'provider', code: event.code, message: event.error }
            : { source: 'unknown', message: event.error }, { requestId, toolsRan });
          streamFailure = payload.failure;
          const errorMessage: WSMessage = {
            type: 'error',
            payload,
            id: requestId,
            timestamp: Date.now(),
          };

          this.emit(errorMessage);
          streamError = event.error;
          break;
        } else if (event.type === 'done') {
          // Flush remaining sentence buffer
          if (options?.onSentence && sentenceBuffer.trim()) {
            options.onSentence(sentenceBuffer.trim());
            sentenceBuffer = '';
          }
          if (!options?.signal?.aborted) options?.onTextDone?.();

          console.log('[StreamRelay] Stream complete for request:', requestId);

          const doneMessage: WSMessage = {
            type: 'status',
            payload: {
              status: 'done',
              requestId,
              fullText,
              usage: event.response.usage,
            },
            id: requestId,
            timestamp: Date.now(),
          };

          if (!options?.signal?.aborted) this.emit(doneMessage);
        }
      }

      if (streamError) {
        // Error event was already broadcast above. Throw a marked Error so
        // the caller's catch path can SKIP sending another error message
        // (otherwise the user sees the same error twice - once from broadcast,
        // once from the handler's catch-block reply).
        const err = new Error(streamError) as Error & { _streamErrorBroadcast?: boolean; failure?: UserFailure };
        err._streamErrorBroadcast = true;
        // The failure the clients were shown, so the task records the same one.
        if (streamFailure) err.failure = streamFailure;
        throw err;
      }
    } catch (error) {
      console.error('[StreamRelay] Error relaying stream:', error);

      // Only broadcast here if we DIDN'T already broadcast inside the loop.
      // streamError being null means the exception came from somewhere else
      // (e.g., a synchronous throw inside the for-await), so the client
      // hasn't seen anything yet.
      if (!streamError) {
        const payload = chatErrorPayload(failureEvidence(error), { requestId, toolsRan });
        const errorMessage: WSMessage = {
          type: 'error',
          payload,
          id: requestId,
          timestamp: Date.now(),
        };
        this.emit(errorMessage);
        // Clients have seen it now: mark it, so the caller does not send the
        // same error a second time (Q-19), and records the same failure.
        const marked = (error instanceof Error ? error : new Error(String(error))) as Error & { _streamErrorBroadcast?: boolean; failure?: UserFailure };
        marked._streamErrorBroadcast = true;
        marked.failure = payload.failure;
        throw marked;
      }

      throw error;
    }

    return fullText;
  }
}
