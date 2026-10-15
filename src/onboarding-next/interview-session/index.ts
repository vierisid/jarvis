import { randomUUID } from 'node:crypto';
import type { Command, Dependencies, PendingTurn, PreparedTurn, RecordV1, Result, Scope, Snapshot } from './types.ts';
import { scopeKey } from './settings.ts';
export type * from './types.ts';
export { createSettingsInterviewStore } from './settings.ts';

const MAX_TURNS = 32; // Existing interviewer caps at 30; includes opening and safeguard.
const MAX_TEXT = 16_384;
const MAX_RECORD = 2_000_000;
export const identity = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const terminal = (s: Snapshot) => s.phase === 'done' || s.phase === 'skipped';
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 4096 && v.every(identity);
class Failure extends Error {
  constructor(readonly kind: Exclude<Result['kind'], 'ok'>, readonly reason: string) { super(reason); }
}

function command(value: unknown): Command {
  if (!object(value)) throw new Failure('invalid', 'invalid_command');
  const fields: Record<string, string[]> = { start: [], read: ['sessionId'], retry: ['sessionId'], skip: ['sessionId'],
    answer: ['sessionId', 'turnId', 'clientRequestId', 'text'] };
  if (typeof value.type !== 'string' || !Object.hasOwn(fields, value.type)) throw new Failure('invalid', 'invalid_command');
  const keys = fields[value.type]!;
  if (Object.keys(value).some(k => k !== 'type' && !keys.includes(k)) || keys.some(k => k === 'text'
    ? typeof value.text !== 'string' || !value.text.trim() || value.text.length > MAX_TEXT
    : !(value.type === 'skip' && k === 'sessionId' && value[k] === null) && !identity(value[k]))) {
    throw new Failure('invalid', 'invalid_command');
  }
  return value as unknown as Command;
}
function checkpointValid(v: unknown): boolean {
  if (!object(v) || !Number.isSafeInteger(v.turnCount) || Number(v.turnCount) < 0 || Number(v.turnCount) > MAX_TURNS
    || typeof v.done !== 'boolean' || !Number.isSafeInteger(v.factsRecorded) || Number(v.factsRecorded) < 0
    || !Array.isArray(v.messages) || v.messages.length > 512
    || (v.farewell !== undefined && typeof v.farewell !== 'string')) return false;
  return v.messages.every(m => object(m) && ['system', 'user', 'assistant', 'tool'].includes(String(m.role))
    && typeof m.content === 'string');
}
function preparedValid(v: unknown): v is PreparedTurn {
  return object(v) && checkpointValid(v.session) && object(v.result)
    && typeof v.result.assistantText === 'string' && v.result.assistantText.length <= MAX_TEXT
    && typeof v.result.done === 'boolean' && v.result.done === (v.session as PreparedTurn['session']).done
    && (v.result.farewell === undefined || typeof v.result.farewell === 'string')
    && Array.isArray(v.facts) && v.facts.length <= 128
    && v.facts.every(f => object(f) && typeof f.theme === 'string' && typeof f.summary === 'string'
      && (f.raw_quote === undefined || typeof f.raw_quote === 'string'));
}
// Stored checkpoints never carry a system prompt; the live interviewer supplies it.
// A persisted system message would otherwise be replayed into the model as instructions.
const hasSystem = (v: unknown) => object(v) && Array.isArray(v.messages) && v.messages.some(m => object(m) && m.role === 'system');
function readRecord(v: unknown, scope: Scope): RecordV1 {
  if (!object(v) || v.schemaVersion !== 1) throw new Failure('unavailable', 'unsupported_record');
  if (JSON.stringify(v).length > MAX_RECORD) throw new Failure('unavailable', 'record_limit');
  if (v.scopeKey !== scopeKey(scope) || !object(v.snapshot) || !checkpointValid(v.checkpoint) || hasSystem(v.checkpoint)
    || !Array.isArray(v.receipts) || v.receipts.length > MAX_TURNS) throw new Failure('unavailable', 'invalid_record');
  const s = v.snapshot;
  if (s.schemaVersion !== 1 || !identity(s.sessionId) || !identity(s.turnId) || !Number.isSafeInteger(s.cursor)
    || Number(s.cursor) < 0 || !['connecting', 'ready', 'thinking', 'error', 'done', 'skipped'].includes(String(s.phase))
    || !ids(s.confirmedFactIds) || !Array.isArray(s.messages) || s.messages.length > MAX_TURNS * 2
    || !s.messages.every(m => object(m) && identity(m.id) && ['user', 'assistant'].includes(String(m.role)) && typeof m.text === 'string')) {
    throw new Failure('unavailable', 'invalid_record');
  }
  if (v.pending !== null && (!object(v.pending) || !identity(v.pending.turnId) || !identity(v.pending.clientRequestId)
    || !identity(v.pending.attemptId) || (v.pending.text !== null && typeof v.pending.text !== 'string')
    || (v.pending.prepared !== undefined && (!preparedValid(v.pending.prepared) || hasSystem(v.pending.prepared.session)))
    || (v.pending.lease !== undefined && (!object(v.pending.lease) || !identity(v.pending.lease.id)
      || !Number.isFinite(v.pending.lease.expiresAt))))) throw new Failure('unavailable', 'invalid_record');
  if (v.receipts.some(r => !object(r) || !identity(r.clientRequestId) || !identity(r.turnId)
    || (r.text !== null && typeof r.text !== 'string'))) throw new Failure('unavailable', 'invalid_record');
  return v as unknown as RecordV1;
}

/** Optional factory. All work starts with an authenticated request, never import. */
export function createInterviewSessionProvider<Context>(deps: Dependencies<Context>) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Invalid interview timeout');
  const live = new Map<string, AbortController>();
  const authorize = (context: Context): Scope => {
    const s = deps.authorize(context);
    if (!s || !identity(s.actorId) || !identity(s.projectId)) throw new Failure('unauthorized', 'authentication_required');
    return { actorId: s.actorId, projectId: s.projectId };
  };
  const sameScope = (context: Context, scope: Scope) => scopeKey(authorize(context)) === scopeKey(scope);
  const pending = (turnId: string, clientRequestId: string, text: string | null): PendingTurn =>
    ({ turnId, clientRequestId, text, attemptId: randomUUID() });
  const write = (tx: { write(r: RecordV1): void }, r: RecordV1) => {
    r.snapshot.cursor++;
    if (JSON.stringify(r).length > MAX_RECORD) throw new Failure('unavailable', 'record_limit');
    tx.write(r);
  };
  function initial(scope: Scope): RecordV1 {
    const sessionId = randomUUID(), turnId = randomUUID();
    const session = deps.interviewer!.create();
    if (!checkpointValid(session) || session.done || session.turnCount !== 0) throw new Failure('unavailable', 'invalid_interviewer');
    return { schemaVersion: 1, scopeKey: scopeKey(scope),
      snapshot: { schemaVersion: 1, sessionId, turnId, cursor: 0, phase: 'connecting', messages: [], confirmedFactIds: [], pendingAnswer: null },
      checkpoint: { ...session, messages: [] }, pending: pending(turnId, `opening:${sessionId}`, null), receipts: [] };
  }
  const current = (scope: Scope) => deps.store.transaction(scope, tx => readRecord(tx.current, scope));
  const publicResult = (context: Context, scope: Scope): Result => {
    if (!sameScope(context, scope)) throw new Failure('unauthorized', 'scope_changed');
    return { kind: 'ok', snapshot: structuredClone(current(scope).snapshot) };
  };

  async function drive(context: Context, scope: Scope): Promise<void> {
    const leaseId = randomUUID();
    const work = deps.store.transaction(scope, tx => {
      const r = readRecord(tx.current, scope);
      if (terminal(r.snapshot) || !r.pending || (r.pending.lease && r.pending.lease.expiresAt > now())) return null;
      r.pending.lease = { id: leaseId, expiresAt: now() + timeoutMs };
      r.snapshot.phase = 'thinking'; delete r.snapshot.error;
      write(tx, r);
      return structuredClone(r);
    });
    if (!work?.pending) return;
    const controller = new AbortController();
    live.set(leaseId, controller);
    const isCurrent = () => {
      try {
        const r = current(scope);
        return !controller.signal.aborted && sameScope(context, scope) && !terminal(r.snapshot)
          && r.pending?.lease?.id === leaseId && r.pending.lease.expiresAt > now();
      } catch { return false; }
    };
    const fenced = (change: (r: RecordV1) => void) => {
      if (!sameScope(context, scope)) throw new Failure('unauthorized', 'scope_changed');
      return deps.store.transaction(scope, tx => {
        const r = readRecord(tx.current, scope);
        if (terminal(r.snapshot) || r.pending?.lease?.id !== leaseId) return false;
        change(r); write(tx, r); return true;
      });
    };
    let stage: 'turn' | 'save' = work.pending.prepared ? 'save' : 'turn';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const timeout = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('interrupted'));
      controller.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => controller.abort(), timeoutMs);
    });
    try {
      let prepared = work.pending.prepared;
      if (!prepared) {
        const seed = deps.interviewer!.create();
        const session = { ...work.checkpoint, messages: [...seed.messages.filter(m => m.role === 'system'), ...work.checkpoint.messages] };
        prepared = await Promise.race([Promise.resolve().then(() => {
          if (!isCurrent()) throw new Error('stale');
          return deps.interviewer!.prepare({ scope, session: structuredClone(session), answer: work.pending!.text,
            turnId: work.pending!.turnId, signal: controller.signal });
        }), timeout]);
        if (!isCurrent()) throw new Error('stale');
        if (!preparedValid(prepared) || prepared.session.turnCount !== work.checkpoint.turnCount + 1) throw new Error('Invalid prepared turn');
        prepared = structuredClone(prepared);
        prepared.session.messages = prepared.session.messages.filter(m => m.role !== 'system');
        if (!fenced(r => { r.pending!.prepared = prepared; })) return;
      }
      stage = 'save';
      if (!isCurrent()) throw new Error('stale');
      const receipt = await Promise.race([Promise.resolve().then(() => {
        if (!isCurrent()) throw new Error('stale');
        return deps.profile!.commit({ scope,
        sessionId: work.snapshot.sessionId, turnId: work.pending!.turnId, clientRequestId: work.pending!.clientRequestId,
        attemptId: work.pending!.attemptId, facts: structuredClone(prepared!.facts), wrap: prepared!.result.done,
        signal: controller.signal, isCurrent });
      }), timeout]);
      if (!isCurrent()) throw new Error('stale');
      if (!receipt || !ids(receipt.confirmedFactIds)) throw new Error('Invalid fact acknowledgement');
      fenced(r => {
        const p = r.pending!;
        const completed = p.prepared!;
        r.checkpoint = completed.session;
        r.snapshot.confirmedFactIds = [...new Set([...r.snapshot.confirmedFactIds, ...receipt.confirmedFactIds])];
        r.checkpoint.factsRecorded = r.snapshot.confirmedFactIds.length;
        if (completed.result.assistantText) r.snapshot.messages.push({ id: `${p.turnId}:assistant`, role: 'assistant', text: completed.result.assistantText });
        r.snapshot.phase = completed.result.done ? 'done' : 'ready';
        if (completed.result.farewell !== undefined) r.snapshot.farewell = completed.result.farewell;
        r.receipts.push({ clientRequestId: p.clientRequestId, turnId: p.turnId, text: p.text });
        r.snapshot.turnId = randomUUID(); r.snapshot.pendingAnswer = null; r.pending = null;
      });
    } catch {
      fenced(r => {
        r.snapshot.phase = 'error';
        r.snapshot.error = `${stage}_${controller.signal.aborted || now() >= work.pending!.lease!.expiresAt ? 'timeout' : 'failed'}`;
        delete r.pending!.lease; // Prepared work and the write-attempt identity survive.
      });
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', abort); controller.abort(); live.delete(leaseId);
    }
  }

  return {
    async request(context: Context, input: unknown): Promise<Result> {
      try {
        if (deps.enabled !== true || !deps.interviewer || deps.profile?.capability !== 'interview-profile.v1') {
          return { kind: 'unavailable', reason: 'interview_capability_unavailable' };
        }
        const scope = authorize(context), c = command(input);
        const shouldDrive = deps.store.transaction(scope, tx => {
          // A first Skip can arrive before Start or before its reply. Scope is
          // still exclusively authenticated; it never selects another actor's session.
          const currentSkip = c.type === 'skip' && c.sessionId === null;
          const r = tx.current === null && (c.type === 'start' || currentSkip) ? initial(scope) : readRecord(tx.current, scope);
          if (c.type !== 'start' && !currentSkip && c.sessionId !== r.snapshot.sessionId) throw new Failure('conflict', 'session_changed');
          if (tx.current === null) write(tx, r);
          if (c.type === 'skip') {
            if (!terminal(r.snapshot)) {
              const lease = r.pending?.lease?.id;
              r.snapshot.phase = 'skipped'; delete r.snapshot.error;
              // Retain the accepted answer and any uncertain write identity for audit/reconciliation.
              if (r.pending) delete r.pending.lease;
              write(tx, r);
              if (lease) live.get(lease)?.abort();
            }
            return false;
          }
          if (c.type === 'answer') {
            const prior = r.receipts.find(p => p.clientRequestId === c.clientRequestId)
              ?? (r.pending?.clientRequestId === c.clientRequestId ? r.pending : undefined);
            if (prior) {
              if (prior.turnId !== c.turnId || prior.text !== c.text) throw new Failure('conflict', 'request_reused');
              return !terminal(r.snapshot) && !!r.pending;
            }
            if (terminal(r.snapshot) || r.pending || r.snapshot.turnId !== c.turnId) throw new Failure('conflict', 'turn_changed');
            if (r.receipts.length >= MAX_TURNS) throw new Failure('unavailable', 'turn_limit');
            r.pending = pending(c.turnId, c.clientRequestId, c.text);
            r.snapshot.pendingAnswer = { sessionId: c.sessionId, turnId: c.turnId, clientRequestId: c.clientRequestId, text: c.text };
            r.snapshot.messages.push({ id: `${c.turnId}:user`, role: 'user', text: c.text, clientRequestId: c.clientRequestId });
            write(tx, r);
          }
          // Reads only reconcile the persisted snapshot; explicit start/retry/answer
          // can reclaim an expired lease. A socket closing never cancels accepted work.
          return c.type !== 'read' && !terminal(r.snapshot) && !!r.pending;
        });
        if (shouldDrive) await drive(context, scope);
        return publicResult(context, scope);
      } catch (err) {
        return err instanceof Failure ? { kind: err.kind, reason: err.reason }
          : { kind: 'unavailable', reason: 'interview_storage_unavailable' };
      }
    },
  };
}
