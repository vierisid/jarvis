/** Q-07 owns recovery writes. Consumers (including F-21) use this projection;
 * neither a lookup nor a human acknowledgement starts or resumes a run. */
import { getWorkflowDb } from '../db';
import { getFlowRun, type FlowRun } from '../db/repos/flow-run';
import { listWorkflowEffects, type WorkflowEffect } from '../db/repos/workflow-effect';
import { getFlowVersion } from '../db/repos/flow-version';
import { walkFlowNodes } from '../db/flow-graph';
import { apId } from '../db/ids';
import { digest } from './effect-context';
import { lookupProviderReceipt, pieceCompletionReceipt, providerReceipt, type ProviderEvidence } from './provider-reconciliation';
import { activeEmergencyState } from '../../authority/emergency';
import type { AuthorityEngine } from '../../authority/engine';
import { boundedReceiptText } from '../../roles/untrusted';

export class RecoveryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export type RecoveryChoice = { requestId: string; revision: string; action: 'reconcile' | 'inspect'; effectId?: string; note?: string };
export type RecoveryReceipt = {
  id: string; runId: string; flowId: string; versionId: string; requestId: string;
  action: RecoveryChoice['action']; effectId: string | null; actor: 'user'; createdAt: number;
  evidenceVersion: string; choiceDigest: string; evidence: ProviderEvidence | { outcome: 'inspected'; reason: string };
  /** Identity of the exact effect/receipt checked, independent of later run progress. */
  effectEvidenceVersion?: string;
};
export type RecoveryProjection = {
  runId: string; flowId: string; versionId: string; revision: string;
  state: 'unknown' | 'blocked' | 'recoverable'; needsAttention: boolean;
  canReplay: false; newRunRequired: true; reason: string;
  effects: Array<{ effectId: string; stepName: string; status: 'unknown' | 'not_started' | 'completed'; lookupSupported: boolean; providerEvidence?: ProviderEvidence }>;
  untrackedSteps: Array<{ stepName: string; executionPath: Array<[string, number]> | null; status: 'unknown' }>;
  receipts: RecoveryReceipt[];
};
const TERMINAL = new Set(['FAILED', 'TIMEOUT', 'INTERNAL_ERROR', 'QUOTA_EXCEEDED', 'STOPPED', 'MEMORY_LIMIT_EXCEEDED', 'SCHEDULE_FAILURE']);

function receipts(runId: string): RecoveryReceipt[] {
  return (getWorkflowDb().query('SELECT record FROM workflow_recovery_receipt WHERE run_id=? ORDER BY rowid').all(runId) as { record: string }[]).map(row => JSON.parse(row.record));
}
function snapshot(runId: string) {
  const run = getFlowRun(runId);
  if (!run) throw new RecoveryError('Run not found', 404);
  const effects = listWorkflowEffects(runId);
  // Actual evidence, not wall-clock freshness. A late receipt invalidates an inspection.
  const evidenceVersion = digest({ run, effects });
  return { run, effects, evidenceVersion };
}
function effectStatus(effect: WorkflowEffect): 'unknown' | 'not_started' | 'completed' {
  if (effect.status === 'pending' || effect.status === 'blocked' && !effect.outcome) return 'not_started';
  if (effect.outcome && effect.outcome.status !== 'succeeded') return effect.outcome.effect === 'not_started' ? 'not_started' : 'unknown';
  // These are dispatch authorizations, not execution receipts (legacy pieces / delegates).
  if (effect.route === 'piece' || effect.route === 'agent') return 'unknown';
  if (effect.route === 'piece-dispatch' && !pieceCompletionReceipt(effect)) return 'unknown';
  return effect.status === 'succeeded' ? 'completed' : 'unknown';
}

/** A legacy/mixed engine may have persisted a step receipt but lost the direct
 * completion POST. Only a top-level, succeeded step is unambiguous here; loop
 * outputs require their exact path and are deliberately not guessed. */
function lookupCandidate(effect: WorkflowEffect, run: FlowRun): WorkflowEffect {
  if (effect.result !== undefined || effect.route !== 'piece-dispatch' || effect.executionPath.length) return effect;
  const step = run.steps?.[effect.stepName] as { status?: unknown; output?: unknown } | undefined;
  return step?.status === 'SUCCEEDED' && step.output !== undefined ? { ...effect, result: step.output } : effect;
}

function effectEvidenceVersion(effect: WorkflowEffect, run: FlowRun): string {
  return digest({ id: effect.id, versionDigest: effect.versionDigest, requestDigest: effect.requestDigest,
    providerBinding: effect.providerBinding, receipt: providerReceipt(lookupCandidate(effect, run)) });
}

/** Community/CODE steps have no effect ledger. Retained failure/in-flight
 * evidence must still appear, including loop instances not covered by an
 * earlier iteration's receipt. A status-less progress output proves no completion. */
function untrackedSteps(run: FlowRun, effects: WorkflowEffect[]): RecoveryProjection['untrackedSteps'] {
  const nodes = new Map(walkFlowNodes(getFlowVersion(run.flowVersionId)?.trigger).map(node => [node.name, node]));
  const coveredInstances = new Set(effects.map(effect => digest([effect.stepName, effect.executionPath])));
  const result: RecoveryProjection['untrackedSteps'] = [];
  const failedInstances = new Set<string>();
  const pending = [{ steps: run.steps ?? {}, path: [] as Array<[string, number]> }];
  while (pending.length) {
    const { steps, path } = pending.pop()!;
    for (const [stepName, raw] of Object.entries(steps)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const step = raw as { status?: unknown; output?: { iterations?: unknown } };
      const node = nodes.get(stepName);
      if (node?.type === 'LOOP_ON_ITEMS' && Array.isArray(step.output?.iterations)) {
        step.output.iterations.forEach((iteration, index) => {
          if (iteration && typeof iteration === 'object' && !Array.isArray(iteration)) {
            pending.push({ steps: iteration, path: [...path, [stepName, index]] });
          }
        });
      }
      if (node?.type !== 'PIECE' && node?.type !== 'CODE') continue;
      if (step.status === 'FAILED') failedInstances.add(stepName);
      if (step.status === 'SUCCEEDED') continue;
      if (!coveredInstances.has(digest([stepName, path]))) result.push({ stepName, executionPath: path, status: 'unknown' });
    }
  }
  const failed = run.failedStep?.name;
  const failedNode = failed ? nodes.get(failed) : undefined;
  // failedStep has no loop path. Without an exact failed instance in the
  // retained log, a completed earlier iteration cannot account for it.
  // Queue recovery's synthetic failure marker is not an executed graph step.
  if (failed && (failedNode?.type === 'PIECE' || failedNode?.type === 'CODE')
    && !failedInstances.has(failed) && !result.some(step => step.stepName === failed)
    && !effects.some(effect => effect.stepName === failed && effect.executionPath.length === 0)) {
    result.push({ stepName: failed, executionPath: null, status: 'unknown' });
  }
  return result;
}
export function getRunRecovery(runId: string): RecoveryProjection | null {
  const { run, effects, evidenceVersion } = snapshot(runId);
  if (!TERMINAL.has(run.status)) return null;
  const history = receipts(runId);
  const current = history.filter(r => r.evidenceVersion === evidenceVersion);
  const projected = effects.map(effect => {
    const version = effectEvidenceVersion(effect, run);
    const applicable = history.filter(r => r.effectId === effect.id && r.action === 'reconcile'
      && (r.effectEvidenceVersion ? r.effectEvidenceVersion === version : r.evidenceVersion === evidenceVersion));
    // Once this exact send was confirmed, a later absence/timeout/revocation
    // cannot undo that historical fact. Keep every attempt in the audit history.
    const evidence = (applicable.findLast(r => r.evidence.outcome === 'confirmed') ?? applicable.at(-1))?.evidence as ProviderEvidence | undefined;
    return { effectId: effect.id, stepName: effect.stepName, status: evidence?.outcome === 'confirmed' ? 'completed' as const : effectStatus(effect),
      lookupSupported: !!(providerReceipt(lookupCandidate(effect, run)) && effect.providerBinding), ...(evidence ? { providerEvidence: evidence } : {}) };
  });
  const untracked = untrackedSteps(run, effects);
  const uncertain = !effects.length || untracked.length > 0 || projected.some(e => e.status === 'unknown');
  const state = uncertain ? 'unknown' : projected.every(e => e.status === 'not_started') ? 'blocked' : 'recoverable';
  return { runId, flowId: run.flowId, versionId: run.flowVersionId,
    revision: digest([evidenceVersion, history.at(-1)?.id ?? null]), state,
    needsAttention: !current.some(r => r.action === 'inspect'), canReplay: false, newRunRequired: true,
    reason: state === 'unknown'
      ? 'Some external outcomes are unknown. Inspect the provider and retained partial results before a new intentional run.'
      : state === 'blocked'
        ? 'Recorded effects did not dispatch. Inspect the blocker, then request a new run through the normal approval checks.'
        : 'Partial results are retained. Review completed effects before requesting a new run; this run cannot be replayed.',
    effects: projected, untrackedSteps: untracked, receipts: history };
}

/** Stable pages include acknowledged rows so a filtered page never pretends to be complete. */
export function listRunRecoveries(limit = 50, cursor?: string | null, projectId?: string): { recoveries: RecoveryProjection[]; next: string | null } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RecoveryError('limit must be an integer from 1 to 100');
  let after = 0;
  if (cursor) { if (!/^\d{1,16}$/.test(cursor)) throw new RecoveryError('Invalid recovery cursor'); after = Number(cursor); }
  // Scope through the flow, as main's run routes do, even if a legacy run's
  // project column is wrong. Filter before LIMIT so foreign rows never consume
  // a page or make a project's inbox appear complete too early.
  const projectFilter = projectId === undefined ? '' : ' AND flow_id IN (SELECT id FROM flow WHERE project_id = ?)';
  const rows = getWorkflowDb().query(`SELECT rowid AS cursor, id FROM flow_run WHERE rowid > ? AND status IN
    ('FAILED','TIMEOUT','INTERNAL_ERROR','QUOTA_EXCEEDED','STOPPED','MEMORY_LIMIT_EXCEEDED','SCHEDULE_FAILURE')${projectFilter} ORDER BY rowid LIMIT ?`)
    .all(after, ...(projectId === undefined ? [] : [projectId]), limit + 1) as { cursor: number; id: string }[];
  const page = rows.slice(0, limit);
  return { recoveries: page.map(r => getRunRecovery(r.id)!).filter(r => r.needsAttention),
    next: rows.length > limit ? String(page.at(-1)!.cursor) : null };
}

export function validateRecoveryChoice(value: Record<string, unknown>): RecoveryChoice {
  if (Object.keys(value).some(k => !['requestId', 'revision', 'action', 'effectId', 'note'].includes(k))) throw new RecoveryError('Unexpected recovery field');
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value.requestId)) throw new RecoveryError('A stable requestId of 8–80 characters is required');
  if (typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) throw new RecoveryError('The displayed recovery revision is required');
  if (value.action === 'reconcile') {
    if (typeof value.effectId !== 'string' || !/^wfe_[a-f0-9]{64}$/.test(value.effectId) || value.note !== undefined) throw new RecoveryError('Reconcile requires only an effectId');
  } else if (value.action === 'inspect') {
    if (typeof value.note !== 'string' || !value.note.trim() || value.note.length > 2000 || value.effectId !== undefined) throw new RecoveryError('Inspection requires a note of 1–2000 characters');
  } else throw new RecoveryError('Choose reconcile or inspect; recovery never executes a run');
  return value as RecoveryChoice;
}

export async function decideRunRecovery(runId: string, raw: Record<string, unknown>, deps: { authority?: AuthorityEngine; fetchImpl?: typeof fetch } = {}): Promise<RecoveryReceipt> {
  const choice = validateRecoveryChoice(raw);
  const choiceDigest = digest(choice);
  const duplicate = () => {
    const existing = receipts(runId).find(r => r.requestId === choice.requestId);
    if (existing && existing.choiceDigest !== choiceDigest) throw new RecoveryError('requestId was already used for a different recovery choice', 409);
    return existing;
  };
  const repeated = duplicate(); if (repeated) return repeated;
  const projection = getRunRecovery(runId);
  if (!projection) throw new RecoveryError('Only a terminal incomplete run can be reviewed', 409);
  if (projection.revision !== choice.revision) throw new RecoveryError('Recovery evidence changed; refresh before deciding', 409);
  const { run, effects, evidenceVersion } = snapshot(runId);
  let evidence: RecoveryReceipt['evidence'];
  let effectVersion: string | undefined;
  if (choice.action === 'inspect') {
    evidence = { outcome: 'inspected', reason: boundedReceiptText(choice.note!.trim(), 2000) };
  } else {
    const effect = effects.find(e => e.id === choice.effectId);
    if (!effect) throw new RecoveryError('Effect does not belong to this run', 404);
    effectVersion = effectEvidenceVersion(effect, run);
    const checkpoint = () => {
      if (activeEmergencyState() !== 'normal') throw new RecoveryError('Provider lookup is held by Pause or Kill', 409);
      const decision = deps.authority?.checkAuthority({ agentId: `workflow:${runId}`, agentRoleId: 'workflow-default', agentAuthorityLevel: 0,
        toolName: 'workflow_recovery_lookup', toolCategory: 'workflow-piece', actionCategory: 'read_data', temporaryGrants: new Map(), profile: null });
      if (!decision?.allowed || decision.requiresApproval) throw new RecoveryError('Authority does not allow this provider lookup', 403);
    };
    try { checkpoint(); evidence = await lookupProviderReceipt(lookupCandidate(effect, run), checkpoint, deps.fetchImpl); }
    catch { evidence = { outcome: 'blocked', reason: 'Provider lookup held by current Authority or emergency policy. No action was replayed.' }; }
  }
  return getWorkflowDb().transaction(() => {
    const repeated = duplicate(); if (repeated) return repeated;
    if (getRunRecovery(runId)?.revision !== choice.revision) throw new RecoveryError('Recovery evidence changed; refresh before deciding', 409);
    const receipt: RecoveryReceipt = { id: apId(), runId, flowId: run.flowId, versionId: run.flowVersionId,
      requestId: choice.requestId, action: choice.action, effectId: choice.effectId ?? null, actor: 'user', createdAt: Date.now(),
      evidenceVersion, choiceDigest, evidence, ...(effectVersion ? { effectEvidenceVersion: effectVersion } : {}) };
    getWorkflowDb().run('INSERT INTO workflow_recovery_receipt (id,run_id,request_id,record) VALUES (?,?,?,?)',
      [receipt.id, runId, choice.requestId, JSON.stringify(receipt)]);
    return receipt;
  })();
}
