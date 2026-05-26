import type { LLMStreamEvent } from '../llm/provider.ts';
import { classifyErrorString } from '../llm/provider.ts';
import type { WebSocketServer, WSMessage } from './websocket.ts';

export type RelayOptions = {
  /** Called each time a complete sentence is available during streaming. */
  onSentence?: (sentence: string) => void;
  /** Called when all text is done streaming. */
  onTextDone?: () => void;
};

// Sentence boundary: period, exclamation, question mark, colon followed by whitespace or end
const SENTENCE_END_RE = /[.!?:]\s/;

export class StreamRelay {
  private wsServer: WebSocketServer;

  constructor(wsServer: WebSocketServer) {
    this.wsServer = wsServer;
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

    try {
      for await (const event of stream) {
        if (event.type === 'text') {
          fullText += event.text;

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
          }

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

          this.wsServer.broadcast(message);
        } else if (event.type === 'tool_call') {
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

          this.wsServer.broadcast(toolMessage);
        } else if (event.type === 'error') {
          console.error('[StreamRelay] Stream error:', event.error);

          const errorMessage: WSMessage = {
            type: 'error',
            payload: {
              message: event.error,
              code: event.code ?? classifyErrorString(event.error),
              requestId,
            },
            id: requestId,
            timestamp: Date.now(),
          };

          this.wsServer.broadcast(errorMessage);
          streamError = event.error;
          break;
        } else if (event.type === 'done') {
          // Flush remaining sentence buffer
          if (options?.onSentence && sentenceBuffer.trim()) {
            options.onSentence(sentenceBuffer.trim());
            sentenceBuffer = '';
          }
          options?.onTextDone?.();

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

          this.wsServer.broadcast(doneMessage);
        }
      }

      if (streamError) {
        // Error event was already broadcast above. Throw a marked Error so
        // the caller's catch path can SKIP sending another error message
        // (otherwise the user sees the same error twice - once from broadcast,
        // once from the handler's catch-block reply).
        const err = new Error(streamError) as Error & { _streamErrorBroadcast?: boolean };
        err._streamErrorBroadcast = true;
        throw err;
      }
    } catch (error) {
      console.error('[StreamRelay] Error relaying stream:', error);

      // Only broadcast here if we DIDN'T already broadcast inside the loop.
      // streamError being null means the exception came from somewhere else
      // (e.g., a synchronous throw inside the for-await), so the client
      // hasn't seen anything yet.
      if (!streamError) {
        const message = error instanceof Error ? error.message : 'Stream relay error';
        const errorMessage: WSMessage = {
          type: 'error',
          payload: {
            message,
            code: classifyErrorString(message),
            requestId,
          },
          id: requestId,
          timestamp: Date.now(),
        };
        this.wsServer.broadcast(errorMessage);
      }

      throw error;
    }

    return fullText;
  }
}
