import { createHash } from 'node:crypto';
import { isTourStep, legacyTourStep, TOUR_STEPS } from './steps.ts';
import type { Journey, JourneyResult, Scope, TourCommand, TourDependencies, TourResult, TourSnapshot, Transition } from './types.ts';

class TourError extends Error { constructor(readonly reason: string, readonly unsupported = false) { super(reason); } }
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const id = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= 200;
const revision = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const scopeKey = (s: Scope) => createHash('sha256').update(JSON.stringify([s.actorId, s.projectId])).digest('hex');
function parse(input: unknown): TourCommand {
  if (!object(input)) throw new TourError('invalid_request');
  const fields = input.type === 'read' ? ['type'] : input.type === 'replay'
    ? ['type', 'sessionId', 'revision', 'requestId'] : input.type === 'navigate'
      ? ['type', 'sessionId', 'revision', 'requestId', 'from', 'action', 'to'] : [];
  if (!fields.length || Object.keys(input).some(k => !fields.includes(k))) throw new TourError('invalid_request');
  if (input.type === 'read') return { type: 'read' };
  if (!id(input.sessionId) || !id(input.requestId) || !revision(input.revision)) throw new TourError('invalid_request');
  if (input.type === 'navigate' && (!isTourStep(input.from) || !['back', 'next', 'skip', 'finish'].includes(input.action as string)
    || (input.to !== undefined && !isTourStep(input.to) && input.to !== 'first-workflow'))) throw new TourError('invalid_request');
  return input as unknown as TourCommand;
}
function snapshot(result: JourneyResult, scope: Scope): Journey {
  if (result?.availability !== 'ready') {
    // Do not expose arbitrary errors from injected services.
    const known = ['revision_conflict', 'request_conflict', 'journey_conflict', 'invalid_transition', 'transition_limit', 'unauthorized'];
    throw new TourError(result && known.includes(result.reason) ? result.reason : 'journey_unavailable', result?.availability === 'unsupported');
  }
  const s = result.snapshot;
  if (!object(s) || s.schemaVersion !== 1 || s.scopeId !== scopeKey(scope) || !id(s.journeyId) || !revision(s.revision)
    || !id(s.stepId) || !['pending', 'in_progress', 'done', 'skipped'].includes(s.tourState)
    || !(s.tourStepId === null || id(s.tourStepId)) || !(s.legacyTourStepId === null || id(s.legacyTourStepId))
    || !(s.replayReturnStepId === null || id(s.replayReturnStepId))) throw new TourError('journey_unavailable');
  return structuredClone(s);
}
function step(s: Journey) {
  if (s.stepId !== 'tour') return null;
  if ((s.tourState === 'done' || s.tourState === 'skipped') && s.replayReturnStepId === null) return null;
  if (s.tourStepId !== null && !isTourStep(s.tourStepId)) throw new TourError('unsupported_progress', true);
  return s.tourStepId ?? legacyTourStep(s.legacyTourStepId);
}
function navigation(c: Extract<TourCommand, { type: 'navigate' }>) {
  const i = TOUR_STEPS.indexOf(c.from);
  const target = c.action === 'back' ? TOUR_STEPS[i - 1] : c.action === 'skip' || c.action === 'finish' || c.from === 'pebble'
    ? 'first-workflow' : TOUR_STEPS[i + 1];
  if (!target || (c.action === 'finish' && c.from !== 'pebble') || (c.to !== undefined && c.to !== target)) throw new TourError('invalid_transition');
  return target === 'first-workflow'
    ? { type: 'tour_finished' as const, state: c.action === 'skip' ? 'skipped' as const : 'done' as const }
    : { type: 'tour_progress' as const, stepId: target };
}
/** Inert by default. No DB, renderer, model, account or workflow side effects.
 * All durable writes use B01's atomic CAS and retry receipts. */
export function createTourProvider<C>(deps: TourDependencies<C>) {
  return {
    capability: 'tour.v1' as const,
    async request(context: C, input: unknown, signal?: AbortSignal): Promise<TourResult> {
      try {
        if (deps.enabled !== true) throw new TourError('disabled', true);
        const c = parse(input);
        const scope = await deps.authorize(context);
        if (!scope || !id(scope.actorId) || !id(scope.projectId)) throw new TourError('unauthorized');
        const recheck = async () => {
          const now = await deps.authorize(context);
          if (signal?.aborted || now?.actorId !== scope.actorId || now?.projectId !== scope.projectId) throw new TourError('unauthorized');
        };
        await recheck();
        const port = deps.journeyFor(scope, context);
        let s = snapshot(await port.read(), scope);
        const room = async (at: NonNullable<ReturnType<typeof step>>) => {
          try { const status = await deps.roomStatus?.(scope, at); return status === 'ready' || status === 'unavailable' ? status : 'unsupported'; }
          catch { return 'unavailable' as const; }
        };
        let replayed: boolean | undefined;
        if (c.type !== 'read') {
          if (c.sessionId !== s.journeyId) throw new TourError('journey_conflict');
          if (c.revision > s.revision) throw new TourError('revision_conflict');
          const command = c.type === 'replay' ? { type: 'replay_tutorial' as const } : navigation(c);
          if (c.revision === s.revision && c.type === 'navigate') {
            if (step(s) !== c.from) throw new TourError('invalid_transition');
            if ((c.action === 'next' || c.action === 'finish') && await room(c.from) !== 'ready') throw new TourError('room_unavailable');
          }
          await recheck();
          const transition = { journeyId: c.sessionId, expectedRevision: c.revision, requestId: c.requestId, command };
          // Old revisions reach B01 only for receipt replay or CAS rejection;
          // they can never overwrite a newer tab, even after capability loss.
          const result = c.type === 'replay'
            ? await port.transition(transition as Transition<{ type: 'replay_tutorial' }>)
            : await port.acknowledge(transition as Parameters<typeof port.acknowledge>[0]);
          s = snapshot(result, scope); replayed = result.availability === 'ready' ? result.replayed : undefined;
        }
        const at = step(s);
        const result: TourSnapshot = { schemaVersion: 1, scopeId: s.scopeId, sessionId: s.journeyId, revision: s.revision,
          active: at !== null, stepId: at, roomStatus: at ? await room(at) : 'unsupported', journey: s };
        await recheck();
        return { availability: 'ready', snapshot: result, ...(replayed !== undefined ? { replayed } : {}) };
      } catch (error) {
        return { availability: error instanceof TourError && error.unsupported ? 'unsupported' : 'unavailable',
          reason: error instanceof TourError ? error.reason : 'storage_unavailable' };
      }
    },
  };
}
