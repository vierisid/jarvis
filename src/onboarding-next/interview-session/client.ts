import type { Answer, Command, Result, Snapshot } from './types.ts';

type Local = { version: 1; sessionId: string | null; draft: { text: string; clientRequestId: string }; answer: Answer | null };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
/** Headless state for U10. storageKey must be scoped by authenticated account,
 * project and tab by the host. Dispose/recreate on identity change. Text stays
 * in this scoped draft record, never telemetry or Pebble conversation storage. */
export function createInterviewClient(deps: {
  storage: Storage;
  storageKey: string;
  send(command: Command, signal?: AbortSignal): Promise<Result>;
  changed?(): void;
}) {
  const blank = (): Local => ({ version: 1, sessionId: null, draft: { text: '', clientRequestId: crypto.randomUUID() }, answer: null });
  let local = blank();
  const raw = deps.storage.getItem(deps.storageKey);
  if (raw !== null) {
    const v = JSON.parse(raw) as Local;
    const id = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 200;
    if (v.version !== 1 || (v.sessionId !== null && !id(v.sessionId)) || !v.draft || typeof v.draft.text !== 'string'
      || v.draft.text.length > 16_384 || !id(v.draft.clientRequestId) || (v.answer !== null && (!v.answer
        || !id(v.answer.sessionId) || !id(v.answer.turnId) || !id(v.answer.clientRequestId) || typeof v.answer.text !== 'string'
        || v.answer.text.length > 16_384))) throw new Error('Interview draft unavailable');
    local = v;
  }
  let snapshot: Snapshot | null = null;
  let error: string | null = null;
  let disposed = false;
  let active = 0;
  const requests = new Set<AbortController>();
  const save = (next: Local) => { deps.storage.setItem(deps.storageKey, JSON.stringify(next)); local = next; };
  const changed = () => { if (!disposed) deps.changed?.(); };
  function accept(s: Snapshot, allowSession: boolean) {
    if (!s || s.schemaVersion !== 1 || !Number.isSafeInteger(s.cursor) || !Array.isArray(s.messages)
      || !Array.isArray(s.confirmedFactIds) || !['connecting', 'ready', 'thinking', 'error', 'done', 'skipped'].includes(s.phase)) {
      throw new Error('Invalid interview snapshot');
    }
    if (snapshot && (s.sessionId !== snapshot.sessionId || s.cursor < snapshot.cursor
      || ((snapshot.phase === 'done' || snapshot.phase === 'skipped') && s.phase !== snapshot.phase))) return;
    if (local.sessionId && local.sessionId !== s.sessionId) throw new Error('Interview session changed');
    if (!local.sessionId && !allowSession) return;
    const next = structuredClone(local);
    next.sessionId = s.sessionId;
    const answer = next.answer;
    if (answer && s.messages.some(m => m.id === `${answer.turnId}:user` && m.role === 'user'
      && m.clientRequestId === answer.clientRequestId && m.text === answer.text)) {
      if (next.draft.clientRequestId === answer.clientRequestId && next.draft.text === answer.text) {
        next.draft = { text: '', clientRequestId: crypto.randomUUID() };
      }
      if (s.pendingAnswer === null || s.phase === 'done' || s.phase === 'skipped') next.answer = null;
    } else if (answer && (s.turnId !== answer.turnId || s.phase === 'done' || s.phase === 'skipped')) {
      // Another tab won this prompt. The server's advanced turn proves that our
      // old intent cannot be accepted; retain its draft for deliberate editing.
      next.answer = null;
    }
    save(next); snapshot = structuredClone(s); error = null;
  }
  async function request(c: Command) {
    if (disposed) return;
    const controller = new AbortController(); requests.add(controller); active++; changed();
    const cursorAtSend = snapshot?.cursor ?? -1;
    const canReportError = () => snapshot?.phase !== 'done' && snapshot?.phase !== 'skipped'
      && (snapshot?.cursor ?? -1) <= cursorAtSend;
    try {
      const result = await deps.send(c, controller.signal);
      if (disposed) return;
      if (result.kind === 'ok') accept(result.snapshot, c.type === 'start');
      else if (canReportError()) error = result.kind === 'conflict' ? 'The interview changed. Reconnect to restore it.' : 'The interview is unavailable. Reconnect or skip.';
    } catch {
      if (!disposed && canReportError()) error = 'Connection interrupted. Reconnect to restore your answer.';
    } finally { requests.delete(controller); active--; changed(); }
  }
  return {
    state: () => structuredClone({ snapshot, draft: local.draft, pendingAnswer: local.answer, busy: active > 0, error }),
    setDraft(text: string) {
      if (disposed || text.length > 16_384) return;
      save({ ...local, draft: { text, clientRequestId: crypto.randomUUID() } }); changed();
    },
    connect: () => request({ type: 'start' }),
    refresh: () => local.sessionId ? request({ type: 'read', sessionId: local.sessionId }) : request({ type: 'start' }),
    async submit() {
      if (disposed || active || !snapshot || snapshot.phase !== 'ready' || !local.draft.text.trim() || local.answer) return;
      const answer = { sessionId: snapshot.sessionId, turnId: snapshot.turnId, ...local.draft };
      // Persist BEFORE the transport. A reload/lost acknowledgement uses this ID and body.
      save({ ...local, answer }); changed(); await request({ type: 'answer', ...answer });
    },
    retry: () => active ? Promise.resolve() : local.answer ? request({ type: 'answer', ...local.answer })
      : local.sessionId ? request({ type: 'retry', sessionId: local.sessionId }) : request({ type: 'start' }),
    skip: () => local.sessionId ? request({ type: 'skip', sessionId: local.sessionId }) : Promise.resolve(),
    dispose() { disposed = true; for (const c of requests) c.abort(); requests.clear(); },
  };
}
