import type { ToolRegistry } from '../../actions/tools/registry';
import { collectActionVerification } from '../../actions/action-verification';
import type { ActionOutcome } from '../../actions/action-outcome';
import { projectDocument } from './decision-document';
import { combineDecisions, type AuthorityEngine, type AuthorityProfile } from '../../authority/engine';
import type { AuditTrail } from '../../authority/audit';
import type { EmergencyController } from '../../authority/emergency';
import type { ApprovalManager, ApprovalRequest } from '../../authority/approval';
import { approvalNeedsClick } from '../../authority/approval';
// The same budget the column's primary writer uses, imported rather than
// restated so the two cannot drift.
import { RECEIPT_MAX_CHARS } from '../../authority/deferred-executor';
import type { ActionCategory } from '../../roles/authority';
import { boundedReceiptText } from '../../roles/untrusted';
import { getWorkflowDb } from '../db';
import { assertRunNotCanceled } from './cancellation';
import { withExecutionScope } from '../../actions/execution-scope';
import { ActionOutcomeError, type ActionFailure } from '../../actions/action-outcome';
import { getFlowRun } from '../db/repos/flow-run';
import { createWaitpoint, getWaitpoint } from '../db/repos/waitpoint';
import { claimWorkflowEffect, getWorkflowEffect, saveWorkflowEffect, type WorkflowEffect } from '../db/repos/workflow-effect';
import { canonicalJson, digest, resolveEffectContext, type WorkflowApprovalPending, type WorkflowEffectContext } from './effect-context';
import { aboveLevelMayAsk, governedCategoriesFor, substituteAboveLevel } from '../../authority/tool-action-map';
import { boundedApprovalLabel } from '../../authority/approval-delivery';
import { budgetCap, budgetOf, deferredAhead, deferredAheadLimit, waitingWorkflowCards } from './deferred-cards';

/**
 * A flow name on a card or an audit row: the same 512 the HTTP routes cap a
 * `displayName` at (`FLOW_DISPLAY_NAME_MAX_CHARS`), so any name those routes
 * accept renders whole and only a name written by a path that does not cap it
 * is shortened.
 */
const WORKFLOW_NAME_LABEL_MAX_CHARS = 512;
/** A step name on a card or an audit row: the 120 `auditRefusal` already uses. */
export const WORKFLOW_STEP_LABEL_MAX_CHARS = 120;
import { holdStep, PAUSED_REASON } from './emergency-hold';

export interface WorkflowAuthorityDependencies {
  authorityEngine?: AuthorityEngine; auditTrail?: AuditTrail; emergencyController?: EmergencyController;
  approvalManager?: ApprovalManager;
  onWorkflowApproval?: (request: ApprovalRequest) => void | Promise<void>;
}
/**
 * Who an effect is dispatched for when it is not the workflow itself. A
 * delegated sub-agent's gate judged the call with this identity; the boundary
 * judges it again with the same one, never with a looser one.
 */
export type EffectPrincipal = {
  agentId: string; agentRoleId: string; agentAuthorityLevel: number; profile?: AuthorityProfile | null;
};
export interface EffectInvocation {
  context: WorkflowEffectContext; piece: string; action: string; route: string;
  toolName: string; category: ActionCategory; toolCategory: string;
  /**
   * Every category the effect reaches when it spans more than one (a skill
   * that clicks controls and sends a message). Each is checked and the
   * decisions fold as the chat gate folds them; `category` stays the worst
   * case and is what the record carries. Defaults to [category].
   */
  categories?: ActionCategory[];
  request: Record<string, unknown>;
  /** Only the validated versioned piece document protocol can enroll a review. */
  documentReview?: boolean;
  /** A reviewed UI capability cannot be auto-allowed by category overrides. */
  confirmation?: { confirm: 'always'; intent: string; reason?: string };
  /** Process-bound browser review; never reconstructed after restart. */
  reviewRegistry?: ToolRegistry;
  prepare: () => { arguments: Record<string, unknown>; target: Record<string, unknown>; bindings?: Record<string, unknown> };
  validateTarget?: (args: Record<string, unknown>, target: Record<string, unknown>) => void;
  /**
   * Why a card could not show this effect as it would run, or null (#1040).
   * Asked only when the decision needs a card, before one is raised: a value
   * the card would cut or could not display is refused, typed and for good,
   * rather than approved unseen. An effect let run without a card is not
   * asked, since there is nothing to show it on.
   */
  cardRefusal?: (args: Record<string, unknown>) => string | null;
  /**
   * The card sentence from the frozen arguments (#1040). `prepare` puts it in
   * the target; this gives one to a record made before that, by an earlier
   * build, that reaches its card only now (a step held by Pause across the
   * upgrade). The target is not part of the request digest, so no identity
   * changes.
   */
  intentFor?: (args: Record<string, unknown>) => string;
  /**
   * Q-05: recheck what the record was made against beyond its arguments and
   * target, such as the memory facts a recipient matched. Runs before the
   * policy and any approval, inside the dispatch checkpoint and, with
   * `revalidateOnReplay`, before a recorded authorization is handed out again.
   * Throws an ActionOutcomeError to block; the record keeps the outcome.
   */
  revalidate?: (record: WorkflowEffect) => void;
  /** For routes whose replay re-dispatches (a piece's own retry), recheck before handing out the recorded result. */
  revalidateOnReplay?: boolean;
  execute: (args: Record<string, unknown>, checkpoint: () => void) => Promise<unknown>;
  principal?: EffectPrincipal;
  /** The caller's gate already found this effect needs approval; the boundary never concludes otherwise. */
  approvalRequired?: boolean;
  /** Trusted native action deadline, persisted with the exact review. */
  approvalExpiresAt?: number;
  /** The engine owns this dispatch. Only its completion receipt can finish it. */
  externalDispatch?: boolean;
  /** Qualified native resumable work owns its own dispatch/checkpoint ledger.
   * Keep the same approval pending between timer slices, and recheck policy on
   * every slice. Only the final confirmed result completes the effect. */
  deferCompletion?: (result: unknown) => boolean;
  providerBinding?: WorkflowEffect['providerBinding'];
  /**
   * The tool's own gate asked for `confirm` and this is its floor: a pure
   * level shortfall above a floor the principal clears becomes an approval
   * card instead of a denial, the substitution the chat gate makes (a write
   * to a shell rc at the default level, #522). Absent: a shortfall denies.
   */
  aboveLevelFloor?: ActionCategory;
  /**
   * Narrows `aboveLevelFloor` (#953): the substitution is made only when every
   * category denied by level is one of these AND governed for the principal
   * (the shared governed list or its profile's), checked afresh on every
   * recheck. Anything else denied by level stays denied. Absent: the floor
   * alone decides, as for a gated tool.
   */
  aboveLevelGovernedOnly?: readonly ActionCategory[];
}
export type EffectReply = { result: unknown; outcome?: ActionOutcome; approval?: never } | { approval: WorkflowApprovalPending; result?: never };

/**
 * Give an approved workflow approval its receipt when its effect ends without
 * succeeding (#845).
 *
 * Before this only success called `markExecuted`, so every other ending left
 * `approval_requests.status = 'approved'` with no `execution_outcome` for
 * good: the approvals surface showed a granted approval that never ran, and
 * only `/api/workflow-runs/:id/effects` said otherwise. The deferred executor
 * already closes the same zombie for a non-workflow approval with
 * `markExecuted(id, text, 'blocked')`, and its `failed` for a tool that threw;
 * this is the same rule for a workflow-owned one, with the same outcomes.
 *
 * `blocked` when the effect was never dispatched or its outcome says it was
 * blocked; `failed` when it was dispatched and did not succeed, which is what
 * the deferred executor's `failed` means too ("the call was dispatched, so a
 * partial effect is possible") and why an `unknown` outcome is `failed` here
 * rather than `blocked`: `blocked` would tell an operator nothing happened.
 *
 * A no-op for an effect with no approval, and for an approval that is not
 * `approved` -- `markExecuted` only writes an approved row, so a denied or
 * expired one keeps its own status. The receipt names the effect, so the
 * approval leads to the record that holds the detail. Best effort: a failed
 * receipt write must not replace the error the step is about to throw.
 */
export function closeEffectApproval(approvals: ApprovalManager | undefined, effect: WorkflowEffect,
  outcome: 'blocked' | 'failed'): void {
  if (!effect.approvalId || !approvals) return;
  try {
    approvals.markExecuted(effect.approvalId, boundedReceiptText(canonicalJson({ effectId: effect.id,
      status: effect.status, error: effect.error ?? null }), RECEIPT_MAX_CHARS), outcome);
  } catch (error) { console.error('[Workflow Authority] approval receipt failed:', error); }
}

/** Budgets for waiting workflow cards, and the steps that wait for a place: `deferred-cards.ts` (#1039). */
export { maxWaitingWorkflowCards } from './deferred-cards';

/**
 * A refusal decided before anything was dispatched (Q-19). Typed so a failed
 * run can say why without reading the message. It becomes the effect's
 * outcome only where nothing has been dispatched yet: the same check failing
 * part way through an effect still records an uncertain outcome.
 */
class PolicyRefusal extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
const refused = (error: PolicyRefusal): ActionFailure =>
  ({ status: 'blocked', code: error.code, message: error.message, effect: 'not_started' });

/**
 * Refusals by Authority, an approval or the emergency state. A workflow never
 * handles one as an outcome to branch on: it fails the step, even a probe's.
 */
export const GOVERNANCE_REFUSALS: ReadonlySet<string> = new Set(['EMERGENCY_STOPPED', 'RUN_NOT_RUNNING', 'AUTHORITY_DENIED',
  'APPROVAL_DENIED', 'APPROVAL_EXPIRED', 'APPROVAL_WITHDRAWN', 'APPROVAL_REQUIRED', 'WORKFLOW_CHANGED', 'CARD_CANNOT_SHOW']);

/** The durable identity of an effect: one per run, step, loop position and route. */
export const workflowEffectId = (runId: string, stepName: string, executionPath: Array<[string, number]>, route: string) =>
  'wfe_' + digest([runId, stepName, executionPath, route]);

/**
 * The Authority decision for one effect, as the principal it runs as: every
 * category folded, then the above-level substitution. The emergency, run and
 * cancellation fences, and the ratchets a caller adds, are `policy()`'s.
 */
function judgeEffect(authority: AuthorityEngine, input: EffectInvocation, runId: string) {
  const who = input.principal ?? { agentId: `workflow:${runId}`, agentRoleId: 'workflow-default', agentAuthorityLevel: 0, profile: null };
  // Fold first, then ratchet. Every category the effect reaches is judged
  // as the SAME principal -- its level and its merged profile apply to
  // each one, not just to the nominal category -- and `combineDecisions`
  // folds them the way the chat gate does. The fold can only tighten: it
  // returns a denial if any category denies, else an approval if any
  // requires one, so it can never clear an approval another category
  // asked for. The caller's ratchet then applies to that folded result,
  // so a gate that already required approval cannot be talked out of it
  // by a looser recomputation here, and the fold cannot bypass it.
  const categories = input.categories?.length ? input.categories : [input.category];
  const check = (actionCategory: ActionCategory) => authority.checkAuthority({
    agentId: who.agentId, agentRoleId: who.agentRoleId, agentAuthorityLevel: who.agentAuthorityLevel,
    toolName: input.toolName, toolCategory: input.toolCategory,
    actionCategory, temporaryGrants: new Map(), profile: who.profile ?? null });
  const decisions = categories.map(check);
  const folded = combineDecisions(decisions);
  const governed = governedCategoriesFor(authority.getConfig().governed_categories, who.profile);
  const decision = input.aboveLevelFloor && aboveLevelMayAsk(decisions, input.aboveLevelGovernedOnly, governed)
    ? substituteAboveLevel(folded, { confirm: 'above_level', floorCategory: input.aboveLevelFloor }, check)
    : folded;
  return decision;
}

/** The daemon owns policy, frozen arguments, approvals and the dispatch fence. */
export class WorkflowEffectBoundary {
  constructor(private readonly deps: WorkflowAuthorityDependencies) {}

  /**
   * Record a capability we refused before an effect record could exist. A tool
   * with no bounded Authority action never reaches `invoke`, and a refusal is
   * exactly the event an operator needs in the audit trail, so log it here.
   * Best effort: the refusal itself is raised by the caller either way.
   */
  auditRefusal(input: { context: WorkflowEffectContext; toolName: string; category: ActionCategory }): void {
    try {
      // The step name is engine-supplied provenance and is not validated on
      // this path -- `resolveEffectContext`'s graph check has not run, because
      // this is the refusal that happens before an effect record can exist --
      // so it is bounded before it reaches the audit row.
      //
      // `boundedReceiptText` and not a bare `.slice(0, 120)` (#634). This is
      // the same defect as `bound()`'s: `<<<UNTRUSTED_CONTENT` is 20
      // characters, so a 120-character cut comfortably keeps an open delimiter
      // and drops the close, into a durable audit row a person reads. It was
      // also, embarrassingly, the line #634's own reasoning cited as the
      // precedent for the number 120.
      //
      // `boundedApprovalLabel` (which wraps `boundedReceiptText`) since #651,
      // so the label is also one line: on this path the step name is the raw
      // `X-Jarvis-Step-Name` header, and a header can carry a vertical tab,
      // a form feed or a NEL even though it cannot carry CR or LF.
      const step = boundedApprovalLabel(input.context.stepName ?? 'unknown step', WORKFLOW_STEP_LABEL_MAX_CHARS);
      this.deps.auditTrail?.log({ agent_id: `workflow:${input.context.runId}`,
        agent_name: `Workflow ${input.context.runId} / ${step}`,
        tool_name: input.toolName, action_category: input.category,
        authority_decision: 'denied', approval_id: null, executed: false });
    } catch (error) { console.error('[Workflow Authority] refusal audit failed:', error); }
  }

  async invoke(input: EffectInvocation): Promise<EffectReply> {
    const { authorityEngine: authority, emergencyController: emergency, auditTrail: audit, approvalManager: approvals } = this.deps;
    if (!authority || !emergency || !audit) throw new Error('Workflow Authority is unavailable; execution denied');
    const resolved = resolveEffectContext(input.context, input.piece, input.action);
    const id = workflowEffectId(resolved.run.id, resolved.stepName, resolved.executionPath, input.route);
    let effect = getWorkflowEffect(id);
    // A piece effect recorded before Q-08 has a request digest without the
    // engine's digest of the whole input. It is matched without it once and
    // bound to it from then on, so an approval parked across the upgrade runs
    // instead of failing as changed. Records made since always carry it.
    if (effect && input.route === 'piece' && effect.requestDigest !== digest(input.request)) {
      const { inputDigest, ...earlier } = input.request;
      if (typeof inputDigest === 'string' && effect.requestDigest === digest(earlier)) {
        effect.requestDigest = digest(input.request);
        saveWorkflowEffect(effect);
      }
    }
    if (effect && (effect.requestDigest !== digest(input.request) || effect.versionDigest !== resolved.versionDigest
      || effect.toolName !== input.toolName || effect.actionCategory !== input.category)) {
      throw new Error('Workflow effect changed since it was recorded; start a new run for new arguments or version');
    }
    if (effect?.status === 'succeeded') {
      // A piece's or a delegation's recorded DISPATCH AUTHORIZATION is handed
      // out again when its step re-runs (a governed action that pauses itself
      // resumes through it). Not while Jarvis is paused or stopped (Q-08):
      // before, this returned ahead of every check.
      if (input.route === 'piece' || input.route === 'agent') {
        const state = emergency.getState();
        if (state === 'killed') {
          // This attempt dispatches nothing; the recorded authorization is left as it is (Q-19).
          throw new ActionOutcomeError({ status: 'blocked', code: 'EMERGENCY_STOPPED', message: 'Workflow effect blocked: system killed', effect: 'not_started' });
        }
        if (state === 'paused') {
          return { approval: { effectId: id, approvalId: '',
            waitpointId: holdStep({ runId: resolved.run.id, projectId: resolved.run.projectId, stepName: resolved.stepName }).id, hold: PAUSED_REASON } };
        }
      }
      // A recorded piece authorization is handed out again on the engine's own
      // retry, and the piece then calls the service again: recheck first. A
      // refusal is kept beside the result, which stays what it was.
      if (input.revalidateOnReplay) {
        try {
          input.revalidate?.(effect);
          // Authority is asked again too: an override, a context rule or an
          // un-governed category added since the first dispatch stops the
          // retry, as the checkpoint would have stopped the first one. Not for
          // a tracked send whose receipt is recorded: its replay hands back
          // the stored result and calls nothing.
          if (input.route === 'piece-dispatch') return { result: effect.result, ...(effect.outcome ? { outcome: effect.outcome } : {}) };
          const current = judgeEffect(authority, input, effect.runId);
          if (!current.allowed) throw new PolicyRefusal('AUTHORITY_DENIED', `Authority denied ${input.toolName}: ${current.reason}`);
          if ((current.requiresApproval || input.confirmation || input.approvalRequired) && !effect.approvalId) {
            throw new PolicyRefusal('APPROVAL_REQUIRED', 'Workflow Authority now requires approval; effect was not dispatched');
          }
          // Granted is `approved`, or `executed` with a committed outcome once
          // the first dispatch recorded its receipt (`executionState`).
          const approval = effect.approvalId ? approvals?.getRequest(effect.approvalId) : null;
          const granted = approval?.status === 'approved'
            || (approval?.status === 'executed' && (approval.execution_outcome ?? 'committed') === 'committed');
          if (effect.approvalId && !granted) {
            throw new PolicyRefusal('APPROVAL_WITHDRAWN', 'Workflow approval is no longer approved; dispatch blocked');
          }
        } catch (error) {
          const failure = error instanceof PolicyRefusal ? new ActionOutcomeError(refused(error)) : error;
          if (failure instanceof ActionOutcomeError) { effect.replayRefusal = { outcome: failure.outcome, at: Date.now() }; saveWorkflowEffect(effect); }
          // A refused retry is a governance decision, so the trail shows it
          // like every other refusal, not only the effect record.
          if (error instanceof PolicyRefusal) {
            audit.log({ agent_id: `workflow:${effect.runId}`,
              agent_name: `Workflow ${boundedApprovalLabel(resolved.version.displayName, WORKFLOW_NAME_LABEL_MAX_CHARS)} / ${boundedApprovalLabel(effect.stepName, WORKFLOW_STEP_LABEL_MAX_CHARS)} / ${effect.id}`,
              tool_name: effect.toolName, action_category: input.category, authority_decision: 'denied',
              approval_id: effect.approvalId, executed: false });
          }
          throw failure;
        }
      }
      return { result: effect.result, ...(effect.outcome ? { outcome: effect.outcome } : {}) };
    }
    if (effect?.outcome && effect.outcome.status !== 'succeeded') throw new ActionOutcomeError(effect.outcome);
    if (effect?.status === 'dispatching') throw new Error('Workflow effect outcome is uncertain or still in flight; automatic replay is blocked');
    if (effect && effect.status !== 'pending') throw new Error(effect.error ?? `Workflow effect is ${effect.status}`);
    if (!effect) {
      const prepared = JSON.parse(canonicalJson(input.prepare()));
      effect = { id, runId: resolved.run.id, projectId: resolved.run.projectId, flowId: resolved.run.flowId,
        versionId: resolved.version.id, versionDigest: resolved.versionDigest, stepName: resolved.stepName,
        executionPath: resolved.executionPath, route: input.route, toolName: input.toolName,
        actionCategory: input.category, requestDigest: digest(input.request), ...prepared,
        provenance: { source: 'workflow-runtime', sandboxId: input.context.sandboxId ?? null,
          machineBindingVersion: 1,
          triggeredBy: resolved.run.triggeredBy, environment: resolved.run.environment,
          piece: input.piece, action: input.action },
        decision: 'unresolved', reason: '', status: 'pending', approvalId: null, waitpointId: null, createdAt: Date.now(),
        ...(input.providerBinding ? { providerBinding: input.providerBinding } : {}) };
      saveWorkflowEffect(effect!);
    }
    let record = effect!;
    // The trail names who was judged: the workflow itself, or the sub-agent a
    // delegated call was judged as.
    const judged = input.principal ? ` / as ${input.principal.agentRoleId} (level ${input.principal.agentAuthorityLevel})` : '';
    // Labels a human judges from, bounded and kept to one line (#651), the
    // same helper the refusal path above uses.
    // The flow name is capped at 512 on the HTTP routes but not on the agent
    // path, where `compose` takes it from the composer model's own output, and
    // no path keeps a line break out of it. The step name is the graph's node
    // name, which readiness requires to be an identifier but does not cap.
    // Labels only: `record.stepName` itself is fenced identity -- the effect id
    // is digested over it -- so it stays exactly what the graph holds.
    const flowLabel = boundedApprovalLabel(resolved.version.displayName, WORKFLOW_NAME_LABEL_MAX_CHARS);
    const stepLabel = boundedApprovalLabel(record.stepName, WORKFLOW_STEP_LABEL_MAX_CHARS);
    const log = (executed: boolean) => audit.log({ agent_id: `workflow:${record.runId}`,
      agent_name: `Workflow ${flowLabel} / ${stepLabel} / ${record.id}${judged}`,
      tool_name: record.toolName, action_category: input.category,
      authority_decision: record.decision === 'denied' ? 'denied' : record.approvalId ? 'approval_required' : 'allowed',
      approval_id: record.approvalId, executed });
    // Pause holds (Q-08): a step reached while Jarvis is paused parks on a
    // HOLD waitpoint instead of being refused for good, and is judged afresh
    // when Resume releases it. Asked before the decision and again before the
    // dispatch claim; a step already dispatching is in flight and finishes.
    const holdIfPaused = (): EffectReply | null => emergency.getState() === 'paused'
      ? { approval: { effectId: id, approvalId: '', waitpointId: holdStep({ runId: record.runId, projectId: record.projectId, stepName: record.stepName }).id, hold: PAUSED_REASON } }
      : null;
    const policy = () => {
      // Kill stops. The controller is the one source of truth: a copy of the
      // state taken at boot kept workflows blocked after Resume (Q-08).
      const state = emergency.getState();
      if (state === 'killed') throw new PolicyRefusal('EMERGENCY_STOPPED', 'Workflow effect blocked: system killed');
      const run = getFlowRun(record.runId);
      if (!run || run.status !== 'RUNNING') throw new PolicyRefusal('RUN_NOT_RUNNING', `Workflow effect blocked: run is ${run?.status ?? 'missing'}`);
      // Cancellation has one fence, owned by `runtime/cancellation`. Defer to it
      // rather than reading job rows here, so the boundary and the daemon's
      // other dispatch points can never disagree about whether a run is dead.
      assertRunNotCanceled(record.runId);
      const decision = judgeEffect(authority, input, record.runId);
      if (!decision.allowed) throw new PolicyRefusal('AUTHORITY_DENIED', `Authority denied ${input.toolName}: ${decision.reason}`);
      // A capability whose UI effect cannot be described is reviewed whatever
      // the category check concluded; the card carries the uncertainty.
      if (input.confirmation) return { ...decision, requiresApproval: true,
        reason: `${decision.reason}; ${input.confirmation.reason ?? `${input.toolName} requires user review of uncertain UI effects`}` };
      // A gate that already required approval for this principal is never
      // overruled by a recomputation here that happens to be looser.
      if (input.approvalRequired && !decision.requiresApproval) {
        return { ...decision, requiresApproval: true, reason: `${decision.reason}; approval required by the calling gate` };
      }
      return decision;
    };
    const held = holdIfPaused();
    if (held) {
      // A step released from waiting for a place (#1039) that Pause holds
      // when it runs again keeps that place through the hold: its record
      // names the HOLD, so only this record's own hold keeps it live
      // (`deferred-cards.ts`), never another pass of the same step. One not
      // yet released keeps its open DEFER, which already keeps it live.
      if (record.deferral && !record.approvalId) {
        const current = record.waitpointId ? getWaitpoint(record.waitpointId) : null;
        if (!current || current.type !== 'DEFER' || current.resumedAt !== null) {
          record.waitpointId = held.approval!.waitpointId; saveWorkflowEffect(record);
        }
      }
      return held;
    }
    // Bindings first, so a stale one is refused before anyone is asked to approve it.
    try { input.revalidate?.(record); } catch (error) {
      if (error instanceof ActionOutcomeError) {
        // Authority never ran, but nothing ran either: the trail says denied, not allowed.
        record.outcome = error.outcome; record.status = 'blocked'; record.decision = 'denied'; record.error = error.message;
        record.reason = error.message; record.finishedAt = Date.now(); saveWorkflowEffect(record); log(false);
      }
      throw error;
    }
    let decision;
    try { decision = policy(); } catch (error) {
      record.status = 'blocked'; record.decision = 'denied'; record.error = String((error as Error).message);
      const outcome = error instanceof PolicyRefusal ? refused(error) : null;
      if (outcome) record.outcome = outcome;
      record.reason = record.error; record.finishedAt = Date.now(); saveWorkflowEffect(record);
      closeEffectApproval(approvals, record, 'blocked');
      log(false);
      throw outcome ? new ActionOutcomeError(outcome) : error;
    }
    record.reason = decision.reason;
    if (record.approvalId || decision.requiresApproval) {
      if (!approvals) throw new Error('Workflow approval service unavailable; execution denied');
      if (!record.approvalId) {
        if (typeof record.target.intent !== 'string' && input.intentFor) {
          record.target = { ...record.target, intent: input.intentFor(record.arguments) };
        }
        const unshowable = input.cardRefusal?.(record.arguments) ?? null;
        if (unshowable) {
          record.status = 'blocked'; record.decision = 'denied'; record.error = unshowable;
          record.outcome = refused(new PolicyRefusal('CARD_CANNOT_SHOW', unshowable));
          record.reason = record.error; record.finishedAt = Date.now(); saveWorkflowEffect(record);
          log(false); throw new ActionOutcomeError(record.outcome);
        }
        // A card waits within its flow's budget (#1012, #1017, #1039): a
        // start in the running-task cap, any other card but a stop in a
        // budget of the same size. The budget is the one the card would be
        // recorded in: keyed on `decision.actionCategory`, the category
        // `createRequest` below stores as the card's `action_category`, which
        // is what `waitingWorkflowCards` counts. Past it, or behind steps
        // already waiting for a place, the step waits with no card instead of
        // failing (owner, 2026-10-21): it parks on a DEFER waitpoint, which
        // the timer releases, oldest first, once a place frees. Its record
        // stays pending and undecided, and is judged afresh when it runs
        // again. Synchronous from the count to the card below, so two runs
        // cannot both see room for the last place.
        const budget = budgetOf(decision.actionCategory);
        if (budget) {
          const waiting = waitingWorkflowCards(record.flowId, budget);
          const ahead = deferredAhead(record, budget);
          const cap = budgetCap(budget);
          if (waiting + ahead >= cap) {
            // Its place in the queue is kept while it waits again in the same
            // budget. A decision that now lands in the other budget queues it
            // at the back of that one: it never waited there.
            const first = record.deferral?.budget !== budget;
            if (first) record.deferral = { budget, since: Date.now() };
            // A step the engine ran again before it parked keeps the waitpoint it already has.
            const current = record.waitpointId ? getWaitpoint(record.waitpointId) : null;
            getWorkflowDb().transaction(() => {
              if (!current || current.type !== 'DEFER' || current.resumedAt !== null) {
                record.waitpointId = createWaitpoint({ flowRunId: record.runId, projectId: record.projectId,
                  stepName: record.stepName, type: 'DEFER' }).id;
              }
              // A run waits at one step at a time. A DEFER of this run's that
              // is still open belongs to a step the run has gone past, so it
              // is retired and holds no place (`deferred-cards.ts`): one run
              // cannot hold several places, whatever calls reach the boundary.
              getWorkflowDb().run(`UPDATE waitpoint SET resumed_at = ? WHERE flow_run_id = ? AND type = 'DEFER'
                AND resumed_at IS NULL AND id <> ?`, [Date.now(), record.runId, record.waitpointId!]);
              saveWorkflowEffect(record);
            })();
            // Once per wait, not per tick: a flood shows in the trail as steps
            // that needed approval and were not run, with no card yet. Under
            // the decision's category, as the card it stands for will be,
            // and as the budget is counted.
            if (first) {
              audit.log({ agent_id: `workflow:${record.runId}`,
                agent_name: `Workflow ${flowLabel} / ${stepLabel} / ${record.id}${judged}`,
                tool_name: record.toolName, action_category: decision.actionCategory,
                authority_decision: 'approval_required', approval_id: null, executed: false });
            }
            const queued = !ahead ? '' : ahead >= deferredAheadLimit(budget)
              ? `, and ${ahead} or more earlier steps are waiting for a place`
              : `, and ${ahead} earlier step${ahead === 1 ? ' is' : 's are'} waiting for a place`;
            const hold = (budget === 'start'
              ? `${waiting} requests to start an agent or a workflow are already waiting for your decision (the limit is ${cap})`
              : `${waiting} requests from this workflow, other than to start or stop an agent, are already waiting for your decision (the limit is ${cap})`)
              + `${queued}. This step waits, and asks you when one of those is approved or denied in the Authority room.`;
            return { approval: { effectId: id, approvalId: '', waitpointId: record.waitpointId!, hold, code: 'APPROVALS_WAITING' } };
          }
        }
        let request!: ApprovalRequest;
        getWorkflowDb().transaction(() => {
          // A gated tool's target carries the sentence its card should show
          // ("click Send (sends email)" with the resolved values); the card
          // is labelled with the category the decision was made on.
          // A tool with no adapter target of its own still names its review
          // sentence through `confirmation`.
          const intent = typeof record.target.intent === 'string' ? record.target.intent : input.confirmation?.intent;
          request = approvals.createRequest({ agentId: `workflow:${record.runId}`,
            agentName: `Workflow: ${flowLabel}${input.principal ? ` as ${input.principal.agentRoleId}` : ''}`,
            toolName: input.toolName, toolArguments: record.arguments, actionCategory: decision.actionCategory,
            urgency: decision.actionCategory === 'make_payment' ? 'urgent' : 'normal', reason: decision.reason,
            // `stepName` here is a label too: the context is read back only for
            // `target`, `confirm` and `intent`, and nothing matches on it.
            context: canonicalJson({ effectId: id, runId: record.runId, versionId: record.versionId,
              stepName: stepLabel, executionPath: record.executionPath, target: record.target,
              // Mandatory review has to be visible in the context, not only in
              // the decision: `approvalNeedsClick` reads it, so voice and
              // auto-approval cannot satisfy this card.
              ...(input.confirmation ? { confirm: input.confirmation.confirm } : {}),
              ...(intent ? { intent } : {}),
              ...(input.approvalExpiresAt !== undefined ? { expiresAt: input.approvalExpiresAt } : {}) }), executionMode: 'workflow',
            ...(input.reviewRegistry ? { toolRegistry: input.reviewRegistry } : {}) });
          record.approvalId = request.id;
          delete record.deferral;
          record.waitpointId = createWaitpoint({ flowRunId: record.runId, projectId: record.projectId,
            stepName: record.stepName, type: 'MANUAL' }).id;
          record.decision = 'approval_required'; saveWorkflowEffect(record);
          if (input.documentReview) {
            const db = getWorkflowDb(), decisionId = `approval:${request.id}`;
            db.run(`INSERT INTO brief_decision_document VALUES (?,?,?,0,'review',?)`, [decisionId, id, request.id, request.created_at]);
            db.run('INSERT INTO brief_decision_document_revision VALUES (?,0,?,?,?)',
              [decisionId, request.id, JSON.stringify(projectDocument(input.piece, input.action, record.arguments)), request.created_at]);
          }
          log(false);
        })();
        // Delivery is retriable by the existing pending-request surfaces. Do
        // not keep a database transaction open across external notification.
        try { await this.deps.onWorkflowApproval?.(request); } catch (error) { console.error('[Workflow Authority] approval delivery failed:', error); }
        // Delivery yields to other callers. An approved duplicate may already
        // have claimed or completed this effect; never overwrite its outcome
        // with the pre-delivery pending snapshot.
        const latest = getWorkflowEffect(id);
        if (latest?.status === 'succeeded') return { result: latest.result, ...(latest.outcome ? { outcome: latest.outcome } : {}) };
        if (latest?.outcome && latest.outcome.status !== 'succeeded') throw new ActionOutcomeError(latest.outcome);
        if (latest?.status === 'dispatching') throw new Error('Workflow effect outcome is uncertain or still in flight; automatic replay is blocked');
        if (!latest || latest.status !== 'pending') throw new Error(latest?.error ?? 'Workflow effect is no longer pending');
        record = latest;
      }
      const approval = approvals.getRequest(record.approvalId!);
      if (!approval || approval.execution_mode !== 'workflow' || digest(JSON.parse(approval.tool_arguments)) !== digest(record.arguments)) {
        throw new Error('Workflow approval does not match the recorded effect');
      }
      if (input.confirmation && !approvalNeedsClick(approval)) {
        // Terminal, as the message says: this approval can never satisfy the
        // review, so the effect is blocked and a granted approval gets its
        // receipt (#845) -- the deferred executor's answer to the same case.
        // It used to throw and leave both as they were, so every replay threw
        // again and the approval stayed `approved` for good.
        record.status = 'blocked'; record.decision = 'denied';
        record.error = 'Workflow approval predates required UI review; start a new reviewed run';
        record.reason = record.error; record.finishedAt = Date.now(); saveWorkflowEffect(record);
        closeEffectApproval(approvals, record, 'blocked');
        log(false); throw new Error(record.error);
      }
      // Expired/kept supported documents remain reviewable. Only an explicit
      // rejection resumes them to a blocked receipt; expiry never destroys a draft.
      const retained = getWorkflowDb().query('SELECT disposition FROM brief_decision_document WHERE approval_id = ?').get(approval.id) as { disposition: string } | null;
      if (approval.status === 'pending' || (approval.status === 'expired' && retained && retained.disposition !== 'rejected')) return { approval: { effectId: id, approvalId: approval.id, waitpointId: record.waitpointId! } };
      if (approval.status !== 'approved') {
        record.decision = 'denied';
        record.status = 'blocked'; record.error = `Workflow approval ${approval.status}; effect was not executed`;
        // Typed (Q-19): a denied or unanswered approval ran nothing, and says so.
        record.outcome = { status: 'blocked', code: approval.status === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_DENIED',
          message: record.error, effect: 'not_started' };
        record.finishedAt = Date.now(); saveWorkflowEffect(record); log(false); throw new ActionOutcomeError(record.outcome);
      }
    } else { record.decision = 'allowed'; }
    // Recheck after delivery/approval and immediately before the synchronous
    // dispatch claim. No await separates this gate from the effect callback.
    const checkpoint = () => {
      // A run no longer running refuses first, typed (Q-19): reading the
      // context would otherwise throw an untyped error for it, and a refusal
      // before the claim would leave the record pending.
      const run = getFlowRun(record.runId);
      if (!run || run.status !== 'RUNNING') throw new PolicyRefusal('RUN_NOT_RUNNING', `Workflow effect blocked: run is ${run?.status ?? 'missing'}`);
      input.validateTarget?.(record.arguments, record.target);
      input.revalidate?.(record);
      const latest = resolveEffectContext(input.context, input.piece, input.action);
      if (latest.versionDigest !== record.versionDigest) throw new PolicyRefusal('WORKFLOW_CHANGED', 'Workflow version changed before dispatch');
      const current = policy();
      if (record.approvalId && approvals?.getRequest(record.approvalId)?.status !== 'approved') {
        throw new PolicyRefusal('APPROVAL_WITHDRAWN', 'Workflow approval is no longer approved; dispatch blocked');
      }
      if (current.requiresApproval && !record.approvalId) throw new PolicyRefusal('APPROVAL_REQUIRED', 'Workflow Authority now requires approval; effect was not dispatched');
    };
    const heldBeforeDispatch = holdIfPaused();
    if (heldBeforeDispatch) return heldBeforeDispatch;
    try { checkpoint(); } catch (error) {
      // A rejected target/session has not reached the dispatch claim. Preserve
      // that fact separately from uncertainty about already-started effects.
      if (error instanceof ActionOutcomeError || error instanceof PolicyRefusal) {
        const outcome = error instanceof PolicyRefusal ? refused(error) : error.outcome;
        record.outcome = outcome; record.status = 'blocked'; record.error = error.message;
        record.finishedAt = Date.now(); saveWorkflowEffect(record);
        closeEffectApproval(approvals, record, 'blocked');
        log(false);
        throw error instanceof PolicyRefusal ? new ActionOutcomeError(outcome) : error;
      }
      throw error;
    }
    if (!claimWorkflowEffect(record)) throw new Error('Workflow effect was already claimed; replay blocked');
    try {
      // Publish the same checkpoint into the ambient execution scope. Deep
      // dispatch points (TTS chunks, channel adapters) call
      // `checkpointExecution()` for cancellation; inside a governed effect that
      // has to mean Authority and emergency state as well. Scopes compose, so
      // this adds to the run's cancellation fence rather than replacing it.
      const { result, verification } = await collectActionVerification(input.toolName, input.toolCategory,
        () => withExecutionScope(checkpoint,
          () => input.execute(JSON.parse(canonicalJson(record.arguments)), checkpoint)));
      // The provider has not run yet. Leave the durable dispatch fence closed
      // even if this reply is lost or the engine retries the step. The trail
      // records the hand-off now, as it does for every piece authorization:
      // a lost completion receipt must not leave a send with no audit row.
      if (input.externalDispatch) { log(true); return { result }; }
      if (input.deferCompletion?.(result)) {
        record.status='pending'; record.result=null;
        saveWorkflowEffect(record); log(true); return {result};
      }
      if (verification) record.outcome = { status: 'succeeded', verification };
      // NOT bounded and NOT defanged, deliberately: this is replay and
      // idempotency state that a resumed run reads back instead of acting again,
      // its shape is pinned by #567 (`cancellation-authority.integration.test.ts`),
      // and a tool's own framed return can therefore be stored here whole, nonce
      // and all. That is the one place the rule stated on `boundedReceiptText`
      // -- a frame belongs where a model reads, drawn fresh -- is knowingly
      // broken, and `actions/tools/manage-workflow.ts` already enumerates this
      // record as a consumer that replays one complete block with one nonce.
      record.result = result ?? null; record.status = 'succeeded'; record.finishedAt = Date.now();
      saveWorkflowEffect(record);
      // `record.result` is untouched -- it is replay and idempotency state, and
      // #567 already broke that contract once by stringifying it. What is bounded
      // is only the RECEIPT string beside it, and through `boundedReceiptText`
      // rather than a bare slice (#609): a tool that frames its own return hands
      // this path a delimited block, `canonicalJson` escapes it onto one line, and
      // a prefix then kept an open delimiter with no close. The helper rewrites
      // the delimiters to their inert spelling, so no cut of this row can be half
      // of a block. This site is also why the fix cannot be a structural unwrap:
      // the block is JSON-escaped here, so there are no lines left to match.
      //
      // One assumption, stated because it is invisible: JSON escaping can also
      // put a marker beyond the defang's reach -- a marker split by a CONTROL
      // character becomes the six-character text `\u0000`, which is no longer the
      // token. Harmless only because nothing parses this column: the row is a
      // truncated, unparseable JSON prefix read as text, so the decoded form
      // never materialises. A consumer that ever `JSON.parse`d a receipt would
      // reopen it.
      if (record.approvalId) approvals!.markExecuted(record.approvalId, boundedReceiptText(canonicalJson({ effectId: id, result: record.result, ...(record.outcome ? { outcome: record.outcome } : {}) }), RECEIPT_MAX_CHARS));
      log(true);
      return { result: record.result, ...(record.outcome ? { outcome: record.outcome } : {}) };
    } catch (error) {
      // A persisted result wins over failure to write a secondary approval or
      // audit receipt. In particular, never replace success with uncertainty.
      if (getWorkflowEffect(id)?.status === 'succeeded') throw error;
      if (error instanceof ActionOutcomeError) {
        record.outcome = error.outcome;
        record.status = error.outcome.status === 'error' ? 'failed' : error.outcome.status;
        record.error = error.message;
      } else {
        // Completion/persistence failed after the adapter returned, or the
        // adapter threw without a typed outcome. Either way the effect may have
        // happened: record it as unknown (replacing any success outcome), never
        // as a plain failure an operator could read as safe to re-run.
        record.status = 'unknown'; record.error = `Effect dispatch failed; partial effects may have occurred: ${(error as Error).message}`;
        record.outcome = { status: 'unknown', code: 'DISPATCH_UNCERTAIN', message: record.error, effect: 'may_have_occurred' };
      }
      record.finishedAt = Date.now(); saveWorkflowEffect(record);
      // Dispatched and not succeeded: `blocked` only when the outcome says
      // so AND says nothing was started; `failed` for an error, an unknown
      // outcome, or a block that may have happened partway, so the receipt
      // never tells an operator nothing happened when something may have.
      closeEffectApproval(approvals, record,
        record.outcome?.status === 'blocked' && record.outcome.effect === 'not_started' ? 'blocked' : 'failed');
      // Completion was not established. The durable record retains the
      // possibility that a remote effect happened before the failure.
      log(false);
      throw error;
    }
  }
}
