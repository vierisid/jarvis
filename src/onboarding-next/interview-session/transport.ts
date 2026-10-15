import type { Command, Result } from './types.ts';

export interface RequestEnvelope {
  type: 'interview_session_request';
  requestId: string;
  speakReply: false;
  command: Command;
}
export interface ReplyEnvelope {
  type: 'interview_session_snapshot';
  requestId: string;
  result: Result;
}
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
/** B11 calls this with its authenticated connection context. No WS registration. */
export function createInterviewTransportHandler<Context>(provider: { request(context: Context, command: unknown): Promise<Result> }) {
  return async (context: Context, value: unknown): Promise<ReplyEnvelope | null> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Partial<RequestEnvelope>;
    if (v.type !== 'interview_session_request' || !validId(v.requestId)) return null;
    const result: Result = v.speakReply !== false || Object.keys(v).some(k => !['type', 'requestId', 'speakReply', 'command'].includes(k))
      ? { kind: 'invalid', reason: 'written_interview_only' } : await provider.request(context, v.command);
    return { type: 'interview_session_snapshot', requestId: v.requestId, result };
  };
}

/** A socket is injected by the host. This opens no connection and handles no
 * audio/voice messages. A disconnect rejects the request, not the server turn. */
export function createInterviewSocketTransport(socket: Pick<WebSocket, 'readyState' | 'send' | 'addEventListener' | 'removeEventListener'>,
  timeoutMs = 35_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 125_000) throw new Error('Invalid transport timeout');
  return (command: Command, signal?: AbortSignal): Promise<Result> => new Promise((resolve, reject) => {
    if (socket.readyState !== 1 || signal?.aborted) { reject(new Error('Interview connection unavailable')); return; }
    const requestId = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', message);
      socket.removeEventListener('close', close);
      socket.removeEventListener('error', close);
      signal?.removeEventListener('abort', close);
    };
    const close = () => { cleanup(); reject(new Error('Interview connection interrupted')); };
    const message = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let v: ReplyEnvelope;
      try { v = JSON.parse(event.data); } catch { return; }
      if (!v || v.type !== 'interview_session_snapshot' || v.requestId !== requestId) return;
      if (!v.result || !['ok', 'unavailable', 'invalid', 'conflict', 'unauthorized'].includes(v.result.kind)) return;
      cleanup(); resolve(v.result);
    };
    socket.addEventListener('message', message as EventListener);
    socket.addEventListener('close', close);
    socket.addEventListener('error', close);
    signal?.addEventListener('abort', close, { once: true });
    timer = setTimeout(close, timeoutMs);
    try { socket.send(JSON.stringify({ type: 'interview_session_request', requestId, speakReply: false, command } satisfies RequestEnvelope)); }
    catch { close(); }
  });
}
