import { createHash } from 'node:crypto';
import type { Journey, JourneyPort, Scope } from './types.ts';
export const owner: Scope = { actorId: 'tour-owner', projectId: 'tour-project' };
export const key = (scope = owner) => createHash('sha256').update(JSON.stringify([scope.actorId, scope.projectId])).digest('hex');
export const journey = (): Journey => ({ schemaVersion: 1, scopeId: key(), journeyId: 'journey', revision: 0,
  stepId: 'tour', setupState: 'completed', interviewState: 'done', tourState: 'pending', tourStepId: null,
  legacyTourStepId: null, replayReturnStepId: null, activationState: 'pending', completion: 'active' });
/** Contract-only port for standalone/no-B01 checks. Integration uses real B01. */
export function portFixture() {
  let state = journey(); let writes = 0;
  const port: JourneyPort = {
    async read() { return { availability: 'ready', snapshot: structuredClone(state) }; },
    async acknowledge(t) {
      if (t.expectedRevision !== state.revision) return { availability: 'unavailable', reason: 'revision_conflict' };
      writes++; state.revision++;
      if (t.command.type === 'tour_progress') { state.tourStepId = t.command.stepId; state.tourState = 'in_progress'; }
      else { state.tourState = t.command.state; state.stepId = 'activation'; state.tourStepId = null; }
      return port.read();
    },
    async transition(t) {
      if (t.expectedRevision !== state.revision) return { availability: 'unavailable', reason: 'revision_conflict' };
      writes++; state.revision++; state.stepId = 'tour'; state.tourState = 'pending'; state.tourStepId = null; state.legacyTourStepId = null;
      return port.read();
    },
  };
  return { port, get state() { return state; }, get writes() { return writes; } };
}
