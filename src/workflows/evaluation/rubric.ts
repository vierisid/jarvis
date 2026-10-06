import { readFileSync } from 'node:fs';
import { fingerprint } from '../../actions/tools/composition-provenance';

/** Per-task limits agreed for a hosted profile. Null means not yet agreed. */
export interface Budget { maxRequestsPerTask: number | null; maxTokensPerTask: number | null; maxP95CompositionMs: number | null }

/**
 * Release thresholds for workflow composition, fixed before a held-out run so
 * results cannot move them. A changed threshold is a new id, not an edit.
 * Rates count every scheduled task; unrun and failed tasks stay in the denominator.
 */
export interface ReleaseRubric {
  schemaVersion: 1; id: string; status: 'proposed' | 'frozen'; source: string;
  frozen: null | { at: string; approvedBy: string[] };
  /** Compare the point estimate or the 95% lower bound with each minimum. */
  decision: 'point-estimate' | 'lower-bound';
  /** Distinct tasks per profile; with repeats, a task counts only when all of its repeats do. */
  sample: { unit: 'task'; minSupportedTasks: number; minNegativeTasks: number; repeatAggregation: 'all' };
  /** human-reviewed: a task is correct only when its automatic checks pass and a reviewer agrees. */
  intent: { measure: 'automatic' | 'human-reviewed'; minFirstCandidateCorrect: number; minCorrectAfterRepair: number };
  safety: { maxUnexpectedEffects: number; maxMissedAbstentions: number };
  humanEffort: { maxMedianEdits: number; maxMedianCorrectionMs: number };
  /** Keyed by hosted profile id; '*' covers a profile without its own entry. */
  budgets: Record<string, Budget>;
}
export const DEFAULT_RUBRIC_PATH = new URL('./rubric/workflow-release-v1.json', import.meta.url);

const share = (n: unknown) => typeof n === 'number' && n >= 0 && n <= 1;
const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
const limit = (n: unknown) => n === null || (typeof n === 'number' && Number.isFinite(n) && n > 0);

export function validateRubric(value: unknown): ReleaseRubric {
  const r = value as ReleaseRubric;
  const fail = (what: string): never => { throw new Error('Invalid release rubric: ' + what); };
  if (r?.schemaVersion !== 1) fail('schemaVersion');
  if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(r.id)) fail('id');
  if (typeof r.source !== 'string' || !r.source.trim()) fail('source');
  if (!['point-estimate', 'lower-bound'].includes(r.decision)) fail('decision');
  if (r.sample?.unit !== 'task' || r.sample.repeatAggregation !== 'all'
    || !count(r.sample.minSupportedTasks) || r.sample.minSupportedTasks < 1 || !count(r.sample.minNegativeTasks)) fail('sample');
  if (!['automatic', 'human-reviewed'].includes(r.intent?.measure)
    || !share(r.intent.minFirstCandidateCorrect) || !share(r.intent.minCorrectAfterRepair)) fail('intent');
  if (!count(r.safety?.maxUnexpectedEffects) || !count(r.safety?.maxMissedAbstentions)) fail('safety');
  if (!(r.humanEffort?.maxMedianEdits >= 0) || !(r.humanEffort?.maxMedianCorrectionMs >= 0)) fail('humanEffort');
  if (!r.budgets || typeof r.budgets !== 'object' || !Object.keys(r.budgets).length
    || !Object.values(r.budgets).every(b => limit(b?.maxRequestsPerTask) && limit(b?.maxTokensPerTask) && limit(b?.maxP95CompositionMs))) fail('budgets');
  if (r.status === 'proposed') { if (r.frozen !== null) fail('a proposed rubric has no freeze record'); }
  else if (r.status === 'frozen') {
    if (typeof r.frozen?.at !== 'string' || !Number.isFinite(Date.parse(r.frozen.at))
      || !Array.isArray(r.frozen.approvedBy) || !r.frozen.approvedBy.length
      || !r.frozen.approvedBy.every(name => typeof name === 'string' && name.trim().length > 0)) fail('a frozen rubric needs its date and approvers');
    // Freezing includes agreeing the per-plan budgets the report is judged against.
    if (Object.values(r.budgets).some(b => Object.values(b).some(v => v === null))) fail('a frozen rubric needs agreed budgets');
  } else fail('status');
  return r;
}

export function loadRubric(path: string | URL = DEFAULT_RUBRIC_PATH): { rubric: ReleaseRubric; sha256: string } {
  const rubric = validateRubric(JSON.parse(readFileSync(path, 'utf8')));
  return { rubric, sha256: fingerprint(rubric) };
}

/** Why a held-out run may not start under this rubric. */
export function rubricProblems(rubric: ReleaseRubric, startedAt: Date): string[] {
  if (rubric.status !== 'frozen') return ['Release rubric ' + rubric.id + ' is proposed, not frozen; freeze it with its approvers before a held-out run.'];
  if (Date.parse(rubric.frozen!.at) > startedAt.getTime()) return ['Release rubric ' + rubric.id + ' is dated after this run started.'];
  return [];
}

export function budgetFor(rubric: ReleaseRubric, profileId: string): Budget | null {
  return rubric.budgets[profileId] ?? rubric.budgets['*'] ?? null;
}
