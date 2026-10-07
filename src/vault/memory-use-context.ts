import { AsyncLocalStorage } from 'node:async_hooks';
import { currentBriefTurn, type BriefExecutionContext } from '../brief/chat-context';
import { defangDelimiters } from '../roles/untrusted';
import type { LLMMessage } from '../llm/provider';
import type { PackedRecall } from './recall-context';
import { getMemoryUsageLedger, memoryDigest, MEMORY_USE_LIMITS, MemoryUsageError,
  type MemoryUsageLedger, type MemoryUseTarget } from './memory-usage';

type Capture = { target: MemoryUseTarget; ledger: MemoryUsageLedger; packs: Map<string, PackedRecall> };
const workflows = new AsyncLocalStorage<Capture | null>();
const turns = new WeakMap<BriefExecutionContext, Capture>();
function current(): Capture | undefined {
  if (process.env.JARVIS_BRIEF_MEMORY_USAGE !== '1') return;
  const workflow = workflows.getStore();
  if (workflow !== undefined) return workflow ?? undefined;
  const turn = currentBriefTurn();
  if (!turn) return;
  let capture = turns.get(turn);
  if (!capture) {
    const { conversationId, turnId, requestId } = turn;
    capture = { target: { purpose: 'conversation_context', turn: { conversationId, turnId, requestId },
      runId: null, workflowId: null, callId: turnId }, ledger: getMemoryUsageLedger(), packs: new Map() };
    turns.set(turn, capture);
  }
  return capture;
}
/** Called only inside the governed workflow effect, with its authenticated run identity. */
export function withWorkflowMemory<T>(runId: string, workflowId: string, callId: string, run: () => T): T {
  if (process.env.JARVIS_BRIEF_MEMORY_USAGE !== '1') return run();
  return workflows.run({ target: { purpose: 'workflow_context', turn: null, runId, workflowId, callId },
    ledger: getMemoryUsageLedger(), packs: new Map() }, run);
}
/** Retrieval alone records selection, never supply. Text lives only in this bounded execution scope. */
export function capturePackedMemory(packed: PackedRecall): void {
  const capture = current();
  if (!capture) return;
  const key = memoryDigest(packed);
  if (capture.packs.has(key)) return;
  if (capture.packs.size >= MEMORY_USE_LIMITS.captures) throw new MemoryUsageError('Memory packing capacity exceeded');
  capture.ledger.record(capture.target, packed.selected, 'selected');
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
  const system = messages.filter(m => m.role === 'system' && typeof m.content === 'string');
  const refs = new Map<string, PackedRecall['included'][number]>();
  for (const pack of capture.packs.values()) {
    if (pack.text && system.some(m => (m.content as string).includes(pack.text) || (m.content as string).includes(defangDelimiters(pack.text)))) {
      for (const ref of pack.included) refs.set(`${ref.factId}:${ref.sourceRevision}`, ref);
    }
  }
  if (refs.size) capture.ledger.record(capture.target, [...refs.values()], 'supplied');
}
