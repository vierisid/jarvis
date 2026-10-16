import { createHash, randomUUID } from 'node:crypto';
import { scopeId } from './settings.ts';
import { JOURNEY_STEPS } from './types.ts';
import type {
  Acknowledgement, JourneyDependencies, JourneyResult, JourneySnapshot, JourneyStep,
  LegacyStatus, Navigation, Scope, StoredJourney, Transition,
} from './types.ts';
export type * from './types.ts';
export { createSettingsJourneyPersistence } from './settings.ts';

const MAX_RECEIPTS = 2048;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const identity = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const step = (v: unknown): v is JourneyStep => JOURNEY_STEPS.includes(v as JourneyStep);
const oneOf = (v: unknown, values: unknown[]) => values.includes(v);

class JourneyError extends Error {
  constructor(readonly reason: string, readonly unsupported = false) { super(reason); }
}

function parseStored(value: unknown, scope: Scope): StoredJourney {
  if (!object(value) || !object(value.snapshot)) throw new JourneyError('invalid_record');
  const s = value.snapshot;
  if (s.schemaVersion !== 1) throw new JourneyError('unsupported_schema', true);
  // Future values stay untouched and cannot be interpreted as incomplete.
  if (!step(s.stepId) || !oneOf(s.setupState, ['pending', 'completed'])
    || !oneOf(s.interviewState, ['connecting', 'ready', 'thinking', 'error', 'done', 'skipped'])
    || !oneOf(s.tourState, ['pending', 'in_progress', 'done', 'skipped'])
    || !oneOf(s.activationState, ['pending', 'building', 'draft_saved', 'explored', 'legacy_completed'])
    || !oneOf(s.completion, ['active', 'completed', 'explored', 'legacy_completed'])
    || (s.replayReturnStepId !== null && !step(s.replayReturnStepId))) {
    throw new JourneyError('unsupported_state', true);
  }
  if (s.scopeId !== scopeId(scope) || !identity(s.journeyId) || !revision(s.revision)
    || (s.tourStepId !== null && !identity(s.tourStepId))
    || (s.legacyTourStepId !== null && !identity(s.legacyTourStepId))
    || (s.jobId !== null && !identity(s.jobId))
    || (s.buildRequestId !== undefined && s.buildRequestId !== null && !identity(s.buildRequestId))
    || (s.draft !== null && (!object(s.draft) || !identity(s.draft.flowId) || !identity(s.draft.versionId)))
    || !Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS) {
    throw new JourneyError('invalid_record');
  }
  if (s.buildHistory !== undefined) {
    if (!Array.isArray(s.buildHistory) || s.buildHistory.length > MAX_RECEIPTS) throw new JourneyError('invalid_record');
    const requests = new Set<string>();
    const jobs = new Set<string>();
    for (const attempt of s.buildHistory) {
      if (!object(attempt) || (attempt.buildRequestId !== null && !identity(attempt.buildRequestId))
        || (attempt.jobId !== null && !identity(attempt.jobId))
        || (attempt.buildRequestId === null && attempt.jobId === null)) throw new JourneyError('invalid_record');
      if (!oneOf(attempt.outcome, ['failed', 'cancelled'])) throw new JourneyError('unsupported_state', true);
      if (attempt.buildRequestId !== null) {
        if (requests.has(attempt.buildRequestId as string)) throw new JourneyError('invalid_record');
        requests.add(attempt.buildRequestId as string);
      }
      if (attempt.jobId !== null) {
        if (jobs.has(attempt.jobId as string)) throw new JourneyError('invalid_record');
        jobs.add(attempt.jobId as string);
      }
    }
    if (requests.has(s.buildRequestId as string) || jobs.has(s.jobId as string)) throw new JourneyError('invalid_record');
  }
  const seen = new Set<string>();
  for (const r of value.receipts) {
    if (!object(r) || !identity(r.requestId) || typeof r.digest !== 'string'
      || !/^[a-f0-9]{64}$/.test(r.digest) || !revision(r.revision) || r.revision === 0
      || r.revision > s.revision || seen.has(r.requestId)) throw new JourneyError('invalid_record');
    seen.add(r.requestId);
  }
  // Preserve unknown future fields at every level by retaining the raw record.
  return value as unknown as StoredJourney;
}

function fromLegacy(scope: Scope, legacy: LegacyStatus): StoredJourney {
  if (!object(legacy) || ['setup_completed', 'setup_skipped_profile', 'profile_completed',
    'tutorial_completed', 'tutorial_dismissed'].some(k => typeof legacy[k] !== 'boolean')
    || (legacy.tutorial_progress_step !== null && !identity(legacy.tutorial_progress_step))) {
    throw new JourneyError('legacy_status_unknown');
  }
  const interviewState = legacy.setup_skipped_profile ? 'skipped' : legacy.profile_completed ? 'done' : 'connecting';
  const tourState = legacy.tutorial_completed ? 'done' : legacy.tutorial_dismissed ? 'skipped' : 'pending';
  const complete = legacy.setup_completed && interviewState !== 'connecting' && tourState !== 'pending';
  return {
    snapshot: {
      schemaVersion: 1, scopeId: scopeId(scope), journeyId: randomUUID(), revision: 0,
      stepId: complete ? 'exited' : !legacy.setup_completed ? 'welcome' : interviewState === 'connecting' ? 'interview' : 'tour',
      setupState: legacy.setup_completed ? 'completed' : 'pending', interviewState, tourState,
      tourStepId: null, legacyTourStepId: legacy.tutorial_progress_step,
      activationState: complete ? 'legacy_completed' : 'pending',
      completion: complete ? 'legacy_completed' : 'active', jobId: null, draft: null, replayReturnStepId: null,
      buildRequestId: null, buildHistory: [],
    },
    receipts: [],
  };
}

function parseRequest(input: unknown, lane: 'navigation' | 'acknowledgement'): Transition<Navigation | Acknowledgement> {
  if (!object(input) || !identity(input.journeyId) || !identity(input.requestId) || !revision(input.expectedRevision)
    || !object(input.command) || Object.keys(input).some(k => !['journeyId', 'requestId', 'expectedRevision', 'command'].includes(k))) {
    throw new JourneyError('invalid_transition');
  }
  const c = input.command;
  const keys: Record<string, string[]> = lane === 'navigation' ? {
    navigate: ['stepId'], replay_tutorial: [], explore: [], finish: [],
  } : {
    setup_completed: [], interview_finished: ['state'], tour_progress: ['stepId'],
    tour_finished: ['state'], reserve_build: ['buildRequestId'], build_started: ['buildRequestId', 'jobId'],
    build_finished_without_draft: ['buildRequestId', 'jobId', 'outcome'], draft_saved: ['jobId', 'flowId', 'versionId'],
  };
  if (typeof c.type !== 'string' || !Object.hasOwn(keys, c.type)) throw new JourneyError('invalid_command');
  const fields = keys[c.type]!;
  const nullable = c.type === 'build_finished_without_draft' ? ['buildRequestId', 'jobId'] : [];
  if (Object.keys(c).some(k => k !== 'type' && !fields.includes(k))
    || fields.some(k => !(nullable.includes(k) && c[k] === null) && !identity(c[k]))) {
    throw new JourneyError('invalid_command');
  }
  if (c.type === 'navigate' && !oneOf(c.stepId, JOURNEY_STEPS.slice(0, 7))) throw new JourneyError('invalid_command');
  if ((c.type === 'tour_finished' || c.type === 'interview_finished') && !oneOf(c.state, ['done', 'skipped'])) {
    throw new JourneyError('invalid_command');
  }
  if (c.type === 'build_finished_without_draft' && !oneOf(c.outcome, ['failed', 'cancelled'])) throw new JourneyError('invalid_command');
  return input as unknown as Transition<Navigation | Acknowledgement>;
}

function digest(request: Transition<Navigation | Acknowledgement>): string {
  return createHash('sha256').update(JSON.stringify([
    request.journeyId, request.expectedRevision,
    Object.entries(request.command).sort(([a], [b]) => a.localeCompare(b)),
  ])).digest('hex');
}

function requireState(condition: boolean): void {
  if (!condition) throw new JourneyError('invalid_transition');
}

function apply(s: JourneySnapshot, c: Navigation | Acknowledgement): JourneySnapshot {
  const n = structuredClone(s);
  const at = s.replayReturnStepId ?? s.stepId;
  const interviewDone = s.interviewState === 'done' || s.interviewState === 'skipped';
  const tourDone = s.tourState === 'done' || s.tourState === 'skipped';
  switch (c.type) {
    case 'navigate': {
      requireState(s.completion === 'active' && s.replayReturnStepId === null && !s.jobId && !s.buildRequestId);
      const adjacent: Partial<Record<JourneyStep, JourneyStep[]>> = {
        welcome: ['explain'], explain: ['welcome', 'legacy-provider-setup', 'google'],
        'legacy-provider-setup': ['explain', 'google'], google: ['explain', 'interview'],
        interview: ['google', 'tour'], tour: ['interview', 'activation'], activation: ['tour'],
      };
      requireState(c.stepId === s.stepId || !!adjacent[s.stepId]?.includes(c.stepId));
      if (['google', 'interview', 'tour', 'activation'].includes(c.stepId)) requireState(s.setupState === 'completed');
      if (['tour', 'activation'].includes(c.stepId)) requireState(interviewDone);
      if (c.stepId === 'activation') requireState(tourDone);
      n.stepId = c.stepId;
      break;
    }
    case 'setup_completed':
      requireState(s.completion === 'active');
      n.setupState = 'completed';
      break;
    case 'interview_finished':
      requireState(s.completion === 'active' && s.setupState === 'completed');
      requireState(!interviewDone || s.interviewState === c.state);
      n.interviewState = c.state;
      break;
    case 'tour_progress':
      requireState(s.stepId === 'tour' && (!tourDone || s.replayReturnStepId !== null));
      n.tourState = 'in_progress'; n.tourStepId = c.stepId;
      break;
    case 'tour_finished':
      requireState(s.stepId === 'tour');
      n.tourState = c.state; n.tourStepId = null;
      // Completing the tour never completes an active journey.
      n.stepId = s.replayReturnStepId ?? 'activation'; n.replayReturnStepId = null;
      break;
    case 'reserve_build':
      requireState(s.completion === 'active' && at === 'activation' && !s.jobId && !s.buildRequestId
        && s.draft === null && !(s.buildHistory ?? []).some(a => a.buildRequestId === c.buildRequestId)
        && s.setupState === 'completed' && interviewDone && (tourDone || s.replayReturnStepId === 'activation'));
      n.activationState = 'building'; n.buildRequestId = c.buildRequestId;
      if (s.replayReturnStepId !== null) n.replayReturnStepId = 'build'; else n.stepId = 'build';
      break;
    case 'build_started':
      requireState(s.completion === 'active' && at === 'build' && s.buildRequestId === c.buildRequestId
        && !s.jobId && s.draft === null && !(s.buildHistory ?? []).some(a => a.jobId === c.jobId));
      n.jobId = c.jobId;
      break;
    case 'build_finished_without_draft':
      requireState(s.completion === 'active' && at === 'build' && s.draft === null
        && (s.buildRequestId ?? null) === c.buildRequestId && s.jobId === c.jobId
        && (c.buildRequestId !== null || c.jobId !== null));
      n.buildHistory = [...(s.buildHistory ?? []), { buildRequestId: c.buildRequestId, jobId: c.jobId, outcome: c.outcome }];
      n.buildRequestId = null; n.jobId = null; n.activationState = 'pending';
      if (s.replayReturnStepId !== null) n.replayReturnStepId = 'activation'; else n.stepId = 'activation';
      break;
    case 'draft_saved':
      requireState(s.completion === 'active' && s.jobId === c.jobId && at === 'build' && s.draft === null);
      n.activationState = 'draft_saved'; n.draft = { flowId: c.flowId, versionId: c.versionId };
      if (s.replayReturnStepId !== null) n.replayReturnStepId = 'result'; else n.stepId = 'result';
      break;
    case 'explore':
      requireState(s.completion === 'active' && s.stepId === 'activation' && s.replayReturnStepId === null && s.jobId === null && !s.buildRequestId);
      n.completion = 'explored'; n.activationState = 'explored'; n.stepId = 'exited';
      break;
    case 'finish':
      requireState(s.completion === 'active' && s.stepId === 'result' && s.replayReturnStepId === null && s.draft !== null);
      n.completion = 'completed'; n.stepId = 'exited';
      break;
    case 'replay_tutorial':
      requireState(s.setupState === 'completed' && interviewDone);
      // A second replay request while already replaying never loses the return location.
      if (s.replayReturnStepId === null && s.stepId !== 'tour') n.replayReturnStepId = s.stepId;
      n.stepId = 'tour'; n.tourState = 'pending'; n.tourStepId = null;
      n.legacyTourStepId = null;
      break;
  }
  return n;
}

/** Creates a dormant, unregistered provider. Only explicit method calls can
 * touch persistence. Navigation cannot acknowledge another provider's work. */
export function createJourneyProvider(deps: JourneyDependencies) {
  const validateFinish = deps.validateFinish;
  async function run(input: unknown, lane: 'read' | 'navigation' | 'acknowledgement'): Promise<JourneyResult> {
    try {
      const scope = await deps.authorize();
      if (!scope || !identity(scope.actorId) || !identity(scope.projectId)) throw new JourneyError('unauthorized');
      const request = lane === 'read' ? undefined : parseRequest(input, lane);
      return deps.persistence.transaction(scope, tx => {
        // Mutations must refer to an identity obtained from a successful read.
        if (tx.current === null && request) throw new JourneyError('journey_not_initialized');
        const record = tx.current === null ? fromLegacy(scope, tx.readLegacy()) : parseStored(tx.current, scope);
        if (!request) {
          if (tx.current === null) tx.write(record);
          return { availability: 'ready', snapshot: structuredClone(record.snapshot) };
        }
        const s = record.snapshot;
        if (request.journeyId !== s.journeyId) return { availability: 'unavailable', reason: 'journey_conflict', snapshot: s };
        const hash = digest(request);
        const receipt = record.receipts.find(r => r.requestId === request.requestId);
        if (receipt) {
          if (receipt.digest !== hash) return { availability: 'unavailable', reason: 'request_conflict', snapshot: s };
          // Return CURRENT progress on a retry, never the historical snapshot.
          return { availability: 'ready', snapshot: s, appliedRevision: receipt.revision, replayed: true };
        }
        if (request.expectedRevision !== s.revision) return { availability: 'unavailable', reason: 'revision_conflict', snapshot: s };
        if (record.receipts.length >= MAX_RECEIPTS || s.revision === Number.MAX_SAFE_INTEGER) {
          throw new JourneyError('transition_limit');
        }
        const next = apply(s, request.command);
        if (request.command.type === 'finish') {
          let valid = false;
          try { valid = validateFinish?.(scope, structuredClone(s), tx.resource) === true; } catch { /* Fail closed without exposing reader errors. */ }
          if (!valid) throw new JourneyError('result_unavailable');
        }
        next.revision++;
        tx.write({ ...record, snapshot: next, receipts: [...record.receipts, {
          requestId: request.requestId, digest: hash, revision: next.revision,
        }] });
        return { availability: 'ready', snapshot: next, appliedRevision: next.revision, replayed: false };
      });
    } catch (error) {
      // No raw SQL, profile content, credentials or client input in error replies.
      return { availability: error instanceof JourneyError && error.unsupported ? 'unsupported' : 'unavailable',
        reason: error instanceof JourneyError ? error.reason : 'storage_unavailable' };
    }
  }
  return {
    canFinishDraft: typeof validateFinish === 'function',
    read: () => run(undefined, 'read'),
    transition: (request: Transition<Navigation>) => run(request, 'navigation'),
    acknowledge: (request: Transition<Acknowledgement>) => run(request, 'acknowledgement'),
  };
}

/** A peer notification is only an invalidation: re-read the server, then use
 * this reducer. On failure retain display state but keep mutations unavailable.
 * The host MUST discard its cache when authenticated scope changes. */
export function reconcileJourney(previous: JourneyResult | null, incoming: JourneyResult): JourneyResult {
  const before = previous?.snapshot;
  const after = incoming.snapshot;
  if (!after) return before ? { ...incoming, snapshot: before } : incoming;
  if (!before) return incoming;
  if (before.scopeId !== after.scopeId) return { availability: 'unavailable', reason: 'scope_changed' };
  if (before.journeyId !== after.journeyId) return { availability: 'unavailable', reason: 'journey_conflict' };
  if (after.revision < before.revision) return { ...incoming, snapshot: before };
  return incoming;
}
