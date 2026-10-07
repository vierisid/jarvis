import { getDb } from './schema';
import { assertNoForgottenMemory, assertNoForgottenProfileSources, automaticSourceKey } from './memory-suppression';
import type { Database } from 'bun:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentBriefTurn, type BriefExecutionContext } from '../brief/chat-context';
import { defangDelimiters } from '../roles/untrusted';
import type { LLMMessage } from '../llm/provider';
import type { PackedRecall } from './recall-context';
import { getMemoryUsageLedger, memoryDigest, MEMORY_USE_LIMITS, MemoryUsageError,
  type MemoryUseTarget } from './memory-usage';

type Capture = { target: MemoryUseTarget | null; db: Database; packs: Map<string, PackedRecall>; profileSources: Set<string> };
const recalls = new AsyncLocalStorage<Capture>();
const workflows = new AsyncLocalStorage<Capture | null>();
const turns = new WeakMap<BriefExecutionContext, Capture>();
function current(): Capture | undefined {
  const workflow = workflows.getStore();
  if (workflow !== undefined) return workflow ?? undefined;
  const turn = currentBriefTurn();
  if (!turn) return recalls.getStore();
  let capture = turns.get(turn);
  if (!capture) {
    const { conversationId, turnId, requestId } = turn;
    capture = { target: { purpose: 'conversation_context', turn: { conversationId, turnId, requestId },
      runId: null, workflowId: null, callId: turnId }, db: getDb(), packs: new Map(), profileSources: new Set() };
    turns.set(turn, capture);
  }
  return capture;
}
/** Called only inside the governed workflow effect, with its authenticated run identity. */
export function withWorkflowMemory<T>(runId: string, workflowId: string, callId: string, run: () => T): T {
  return workflows.run({ target: { purpose: 'workflow_context', turn: null, runId, workflowId, callId },
    db: getDb(), packs: new Map(), profileSources: new Set() }, run);
}
/** Retrieval alone records selection, never supply. Text lives only in this bounded execution scope. */
export function capturePackedMemory(packed: PackedRecall): void {
  const capture = current();
  if (!capture) return;
  const key = memoryDigest(packed);
  if (capture.packs.has(key)) return;
  if (capture.packs.size >= MEMORY_USE_LIMITS.captures) throw new MemoryUsageError('Memory packing capacity exceeded');
  if (capture.target && process.env.JARVIS_BRIEF_MEMORY_USAGE === '1') getMemoryUsageLedger().record(capture.target, packed.selected, 'selected');
  capture.packs.set(key, packed);
}
/** The manifest is made by the packer. The exact whole-block check only verifies
 * that this request still carries it (raw ambient block or the role builder's
 * delimiter-neutralized form). It never derives IDs or associations from text.
 * Handoff means supplied to the provider adapter, not receipt, reliance or success.
 */
export function recordMemoryHandoff(messages: readonly LLMMessage[]): void {
  const capture = current();
  if (!capture) return;
  if (capture.db !== getDb()) throw new MemoryUsageError('Memory context belongs to a replaced vault');
  assertNoForgottenProfileSources(capture.db, capture.profileSources);
  const system = messages.filter(m => m.role === 'system' && typeof m.content === 'string');
  const refs = new Map<string, PackedRecall['included'][number]>();
  for (const pack of capture.packs.values()) {
    if (pack.text && system.some(m => (m.content as string).includes(pack.text) || (m.content as string).includes(defangDelimiters(pack.text)))) {
      for (const ref of pack.included) refs.set(`${ref.factId}:${ref.sourceRevision}`, ref);
    }
  }
  if (refs.size) {
    assertNoForgottenMemory(capture.db, [...refs.values()].map(ref => ref.factId));
    if (capture.target && process.env.JARVIS_BRIEF_MEMORY_USAGE === '1') getMemoryUsageLedger().record(capture.target, [...refs.values()], 'supplied');
  }
}

/** Legacy chat scopes need invalidation too, but cannot fabricate a canonical usage target. */
export function withMemoryRecall<T>(run: () => T): T {
  if (current()) return run();
  let db: Database;
  try { db = getDb(); } catch { return run(); } // No initialized vault has no recall to capture.
  return recalls.run({ target: null, db, packs: new Map(), profileSources: new Set() }, run);
}
/** Async iterators execute on consumption, after the preparation scope has returned. */
export function bindMemoryRecallStream<T>(stream: AsyncIterable<T>): AsyncIterable<T> {
  const capture = recalls.getStore();
  if (!capture) return stream;
  return { [Symbol.asyncIterator]() {
    const iterator = recalls.run(capture, () => stream[Symbol.asyncIterator]());
    return {
      next: (...args: [] | [undefined]) => recalls.run(capture, () => iterator.next(...args)),
      return: (value?: any) => recalls.run(capture, () => iterator.return ? iterator.return(value) : Promise.resolve({ done: true as const, value })),
      throw: (error?: any) => recalls.run(capture, () => iterator.throw ? iterator.throw(error) : Promise.reject(error)),
    };
  } };
}
export function captureProfileSources(answers: Record<string, string | undefined>): void {
  const capture = current(); if (!capture) return;
  for (const [field, answer] of Object.entries(answers)) if (answer) {
    for (const kind of ['answer', 'derived']) capture.profileSources.add(automaticSourceKey(capture.db,
      { source: 'user_profile', source_ref: `profile:${kind}:${field}`, quote: answer })!);
  }
}
