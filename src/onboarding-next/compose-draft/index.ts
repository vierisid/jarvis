import { composePersistedFlow } from '../../actions/tools/persisted-workflow-composer';
import { walkFlowNodes } from '../../workflows/db/flow-graph';
import { digest, id, parseInput, scopeId } from './input';
import { DraftError, type CommitControl, type DraftDependencies, type DraftResult, type Intent } from './types';
export type * from './types';
export { createSqliteDraftStore, initializeComposeDraftStore } from './store';

/** Internal B08 capability. No HTTP operation, daemon registration, worker or scheduler. */
export function createComposeDraftProvider<C>(deps: DraftDependencies<C>) {
  async function run(context: C, input: unknown, control?: CommitControl): Promise<DraftResult> {
    try {
      if (deps.enabled !== true) throw new DraftError('disabled');
      const parsed = parseInput(input), submission = parsed.submission, bodyDigest = digest(submission), requestId = submission.request.requestId;
      const scope = await deps.authorize(context);
      if (!scope || !id(scope.actorId) || !id(scope.projectId)) throw new DraftError('unauthorized');
      const owner = Object.freeze({ ...scope }), services = deps.servicesFor(owner, context);
      if (!services || !id(services.id)) throw new DraftError('binding_missing');
      const binding = services.id, store = services.store;
      const storage = <T>(operation: () => T): T => {
        try { return operation(); } catch (error) { throw error instanceof DraftError ? error : new DraftError('storage_unavailable'); }
      };
      const bindingGuard = () => {
        const live = deps.servicesFor(owner, context);
        if (!live || live.id !== binding || live.store !== store) throw new DraftError('binding_missing');
        store.current();
      };
      const guard = async () => {
        const now = await deps.authorize(context);
        if (!now || now.actorId !== owner.actorId || now.projectId !== owner.projectId) throw new DraftError('unauthorized');
        bindingGuard();
      };
      const access = async (cancellable = true) => {
        await guard();
        if (!await services.access(cancellable ? control?.signal : undefined)) throw new DraftError('unauthorized');
        await guard();
      };
      const fence = () => {
        bindingGuard();
        if (control?.signal?.aborted) throw new DraftError('cancelled');
        if (!control || control.mayCommit() !== true) throw new DraftError('claim_lost');
      };
      await access(false); // Authorization for recovery must still run after the worker was aborted.
      // Reconcile before any model work, including after cancellation or changed references.
      const previous = storage(() => store.read(owner, requestId, bodyDigest));
      if (!control || (previous.availability === 'ready' && previous.state === 'saved')) return previous;
      fence();
      const validate = async (): Promise<Intent> => {
        await access(); fence();
        const result = await services.validate(structuredClone(submission), control.signal);
        await access(); fence();
        if (result.availability !== 'ready' || result.state !== 'ready' || !result.intent) throw new DraftError('needs_input');
        const intent = result.intent;
        if (intent.schemaVersion !== 1 || intent.intentVersion !== 1 || intent.scopeId !== scopeId(owner)
          || intent.intentId !== parsed.intentId || intent.requestDigest !== bodyDigest
          || digest({ action: 'create', request: intent.request, answers: intent.answers }) !== bodyDigest
          || intent.qualifications.some(i => i.blocking || i.code !== 'placeholder')
          || intent.references.some(r => r.scopeId !== scopeId(owner))
          || intent.creationPolicy.artifact !== 'disabled_draft'
          || (['publish', 'enable', 'run', 'grantTools', 'linkGoal'] as const).some(k => intent.creationPolicy[k] !== false)) {
          throw new DraftError('intent_changed');
        }
        return structuredClone(intent);
      };
      const intent = await validate();
      const selectedContext = await services.resolveContext(structuredClone(intent), control.signal);
      if (!selectedContext || typeof selectedContext !== 'object' || Array.isArray(selectedContext)
        || Buffer.byteLength(JSON.stringify(selectedContext)) > 64 * 1024) throw new DraftError('service_unavailable');
      const supplemental = structuredClone({ answers: intent.answers, references: intent.references,
        qualifications: intent.qualifications, selectedContext });
      await validate(); // References can change during canonical reads, before incurring model cost.
      fence();
      const composer = services.composer();
      storage(() => store.reserve(owner, requestId, bodyDigest));
      const result = await composePersistedFlow({ ...composer, onCandidate(candidate) {
        fence(); composer.onCandidate?.(candidate);
      } }, { name: 'First workflow', description: submission.request.prompt, context: supplemental, signal: control.signal },
      { projectId: owner.projectId, onJournal(compositionId) {
        fence(); storage(() => store.journal(owner, requestId, bodyDigest, compositionId));
      } });
      await validate();
      if (!result.ok) throw new DraftError('composition_failed');
      if (!walkFlowNodes(result.flow.trigger).some(n => n.type === 'PIECE')) throw new DraftError('needs_input');
      return storage(() => store.save(owner, requestId, bodyDigest, result.compositionRecordId, result.flow, intent.qualifications, fence));
    } catch (error) {
      const reason = error instanceof DraftError ? error.reason : control?.signal?.aborted ? 'cancelled' : 'service_unavailable';
      return { availability: reason === 'disabled' || reason === 'binding_missing' ? 'unsupported' : 'unavailable', reason };
    }
  }
  return { capability: 'compose-draft.v1' as const,
    compose: (context: C, input: unknown, control: CommitControl) => run(context, input, control),
    /** Internal reconciliation only; B10 owns the user-facing authorized result reader. */
    reconcile: (context: C, input: unknown) => run(context, input) };
}
