/**
 * The authority gate for starting and stopping agents (#932, #963).
 *
 * Called from the two SINKS, `orchestrator.spawnSubAgent` and
 * `orchestrator.terminateAgent`, rather than from each path that reaches them.
 * Four paths were found reaching a governed action without passing the gate
 * (#908, #932, #969, #973); gating where the act happens covers the ones we
 * know -- the tool layer, the dashboard, the pebble's voice fast path, a
 * workflow step -- and the next one by default.
 *
 * What it decides, in order:
 *   1. Emergency state. A spawn under Pause or Kill is refused: the agent's
 *      model loop would otherwise start and spend tokens with only its tools
 *      refused. A STOP is never refused for emergency state.
 *   2. The engine's decision for the category, for the acting agent. Any
 *      deny (override, context rule, profile cap, the level check) throws, as
 *      it does at the tool layer: an approval in hand never lifts one. The one
 *      exception mirrors the tool layer: a stop's level shortfall asks.
 *   3. Approval. Satisfied by an unspent approval for the category in the
 *      ambient scope (`approved-action-scope.ts`): the tool layer's card, the
 *      realtime gate's documented auto-approval (never for a stop), a
 *      workflow boundary's approved delegation. Otherwise a card is raised when the caller
 *      said what call would redo the act once approved (`via.toolArguments`),
 *      and the act is refused either way with `AgentLifecycleRefusal`.
 *   4. An audit row, for every outcome. Nothing recorded a spawn before.
 *
 * The acting agent is the sub-agent whose tool call reached the sink when one
 * did (`acting-agent.ts`, #1014), judged under its restrictions and taint;
 * otherwise the primary, for a model turn or the person.
 */

import type { ActionCategory } from '../roles/authority.ts';
import type { AuthorityDecision, AuthorityEngine, AuthorityProfile } from '../authority/engine.ts';
import type { ApprovalManager, ApprovalRequest } from '../authority/approval.ts';
import type { AuditTrail } from '../authority/audit.ts';
import type { EmergencyController } from '../authority/emergency.ts';
import type { ToolRegistry } from '../actions/tools/registry.ts';
import { gateContext, resolveToolGate, substituteAboveLevel } from '../authority/tool-action-map.ts';
import { spendApproval, type ApprovalSource } from '../authority/approved-action-scope.ts';
import { TAINT_PROFILE_LABEL } from '../authority/taint-gating.ts';
import type { AgentInstance } from './agent.ts';
import { MAX_RUNNING_TASKS } from './task-manager.ts';

export type LifecycleAction = Extract<ActionCategory, 'spawn_agent' | 'terminate_agent'>;

/**
 * The call that asked for the act. `toolName` is what context rules are
 * matched against (a rule written against `manage_agents`, the tool the
 * person sees, now matches on every path that names it). `toolArguments`,
 * when given, is the registered call that redoes the act once approved; it is
 * what the card runs.
 */
export type LifecycleVia = { toolName: string; toolArguments?: Record<string, unknown> };

export type LifecycleRefusalKind = 'halted' | 'denied' | 'approval_required' | 'too_many_waiting';

/**
 * How many requests to START an agent may wait on cards at once from one
 * source (#989). Identical requests already share one card; this bounds
 * distinct ones, a varied `POST /api/agents` or repeated ambient speech.
 *
 * The number is the running-task cap, not a new one: at most that many tasks
 * can run, so cards past it could never all be carried out together, and the
 * cap's own reasoning ("well past what a person follows at once") is the
 * approval-fatigue argument this bound exists for. A function, not a copy, so
 * the two cannot drift.
 */
export function maxWaitingSpawnCards(): number {
  return MAX_RUNNING_TASKS;
}

/** The act was not carried out. `approvalId` is set when a card is now waiting for it. */
export class AgentLifecycleRefusal extends Error {
  constructor(
    readonly action: LifecycleAction,
    readonly kind: LifecycleRefusalKind,
    message: string,
    readonly approvalId: string | null = null,
  ) {
    super(message);
    this.name = 'AgentLifecycleRefusal';
  }
}

export type LifecycleGateDeps = {
  engine: AuthorityEngine | null;
  approvalManager: ApprovalManager | null;
  auditTrail: AuditTrail | null;
  emergency: EmergencyController | null;
  toolRegistry: ToolRegistry | null;
  temporaryGrants: Map<string, ActionCategory[]>;
  profile: AuthorityProfile | null;
  onApprovalNeeded: ((request: ApprovalRequest) => void) | null;
  auditName: (roleName: string) => string;
};

export type LifecycleRequest = {
  action: LifecycleAction;
  /** Who is acting: the spawning parent, or the agent asking for the stop. */
  actor: AgentInstance;
  /** The role id the act is about, for the audit row and the refusal text. */
  subject: string;
  via?: LifecycleVia;
};

const DEFAULT_TOOL: Record<LifecycleAction, string> = {
  spawn_agent: 'spawn_sub_agent',
  terminate_agent: 'terminate_agent',
};

const VERB: Record<LifecycleAction, string> = {
  spawn_agent: 'starting',
  terminate_agent: 'stopping',
};

/** The engine's decision for `req`, or null when no engine is wired. */
export function lifecycleDecision(deps: LifecycleGateDeps, req: LifecycleRequest): AuthorityDecision | null {
  if (!deps.engine) return null;
  const { actor, action } = req;
  const decision = deps.engine.checkAuthority({
    agentId: actor.id,
    agentAuthorityLevel: actor.agent.authority.max_authority_level,
    agentRoleId: actor.agent.role.id,
    toolName: req.via?.toolName ?? DEFAULT_TOOL[action],
    toolCategory: 'delegation',
    actionCategory: action,
    temporaryGrants: deps.temporaryGrants,
    profile: deps.profile,
  });
  if (action !== 'terminate_agent') return decision;
  // A stop needs level 9, which no shipped role has, and the person can always
  // approve stopping their own agent: a pure level shortfall asks instead of
  // refusing, exactly as `manage_agents terminate` does at the tool layer
  // (its gate declares `confirm: 'above_level'` over the spawn_agent floor).
  return substituteAboveLevel(decision, { confirm: 'above_level', floorCategory: 'spawn_agent' }, (category) =>
    deps.engine!.checkAuthority({
      agentId: actor.id,
      agentAuthorityLevel: actor.agent.authority.max_authority_level,
      agentRoleId: actor.agent.role.id,
      toolName: req.via?.toolName ?? DEFAULT_TOOL[action],
      toolCategory: 'delegation',
      actionCategory: category,
      temporaryGrants: deps.temporaryGrants,
      profile: deps.profile,
    }));
}

function audit(
  deps: LifecycleGateDeps,
  req: LifecycleRequest,
  decision: 'allowed' | 'denied' | 'approval_required',
  executed: boolean,
  approvalId: string | null = null,
  source: ApprovalSource | null = null,
): void {
  try {
    deps.auditTrail?.log({
      agent_id: req.actor.id,
      agent_name: deps.auditName(req.actor.agent.role.name),
      tool_name: `${req.action}(${req.subject})`,
      action_category: req.action,
      authority_decision: decision,
      approval_id: approvalId,
      executed,
      // Which decision a satisfied approval was: a voice session's documented
      // auto-approval, or a workflow boundary's authorisation. A card's own
      // resolution channel is on the card's rows.
      ...(source === 'realtime_auto' ? { channel: 'voice' as const }
        : source === 'workflow_effect' ? { channel: 'system' as const } : {}),
    });
  } catch (err) {
    // The decision stands without its row; an audit failure must not turn a
    // refusal into an act or an act into a crash.
    console.warn(`[Lifecycle] could not audit ${req.action}(${req.subject}):`, err instanceof Error ? err.message : err);
  }
}

/**
 * Raise a deferred card for `via`, the registered call that redoes the act.
 * Null when there is nobody to ask or nothing to run.
 */
export function raiseLifecycleCard(
  deps: LifecycleGateDeps,
  req: LifecycleRequest,
  reason: string,
): ApprovalRequest | null {
  const via = req.via;
  if (!via?.toolArguments || !deps.approvalManager || !deps.toolRegistry?.has(via.toolName)) return null;
  // The same request already waiting is the same question: answered with
  // that card, not a second one. Repeated speech or a retried dashboard
  // request must not bury the queue (#932).
  const args = JSON.stringify(via.toolArguments);
  const pending = deps.approvalManager.getPending();
  const waiting = pending.find((r) => r.tool_name === via.toolName
    && r.tool_arguments === args && r.action_category === req.action && r.execution_mode === 'deferred');
  if (waiting) return waiting;
  // The source is the acting agent as the card names it (`agent_name`), not
  // its id: pending cards outlive a restart and the primary's id does not, so
  // an id would hand every restart a fresh budget. Only starts are capped. A
  // stop is the safety lever and must never be refused for a flood of
  // starts; stop cards are already one per agent and task.
  if (req.action === 'spawn_agent') {
    const source = deps.auditName(req.actor.agent.role.name);
    const cap = maxWaitingSpawnCards();
    // Only cards for this same registered call: a `request_approval` card the
    // model raised under spawn_agent is not a start, and must not use up the
    // owner's budget.
    const queued = pending.filter((r) => r.action_category === 'spawn_agent' && r.tool_name === via.toolName
      && r.execution_mode === 'deferred' && r.agent_name === source).length;
    if (queued >= cap) {
      throw new AgentLifecycleRefusal(req.action, 'too_many_waiting',
        `${queued} requests to start an agent are already waiting for your decision (the limit is ${cap}). Approve or deny those in the Authority room first.`);
    }
  }
  const tool = deps.toolRegistry.get(via.toolName);
  const gate = resolveToolGate(tool, via.toolName, via.toolArguments);
  const request = deps.approvalManager.createRequest({
    agentId: req.actor.id,
    agentName: deps.auditName(req.actor.agent.role.name),
    toolName: via.toolName,
    toolArguments: via.toolArguments,
    actionCategory: req.action,
    urgency: 'normal',
    reason,
    context: gateContext(gate, via.toolName, via.toolArguments),
    executionMode: 'deferred',
    toolRegistry: deps.toolRegistry,
    principal: {
      agentRoleId: req.actor.agent.role.id,
      agentAuthorityLevel: req.actor.agent.authority.max_authority_level,
      profile: deps.profile,
    },
  });
  try {
    deps.onApprovalNeeded?.(request);
  } catch (err) {
    console.warn('[Lifecycle] approval delivery failed:', err instanceof Error ? err.message : err);
  }
  return request;
}

/**
 * `raiseLifecycleCard`, writing the row when it refuses to raise one. A cap
 * refusal is recorded as `denied`, so a flood is visible in the audit and not
 * mistaken for a card that could not be delivered.
 */
function raiseOrAudit(deps: LifecycleGateDeps, req: LifecycleRequest, reason: string): ApprovalRequest | null {
  try {
    return raiseLifecycleCard(deps, req, reason);
  } catch (err) {
    audit(deps, req, err instanceof AgentLifecycleRefusal && err.kind === 'too_many_waiting' ? 'denied' : 'approval_required', false);
    throw err;
  }
}

/**
 * Decide `req`. Returns the function that writes the row for the act once it
 * has happened; throws `AgentLifecycleRefusal` (row written) when it may not.
 *
 * `fallback` is the answer when no engine is wired (tests, embedded use): the
 * role-derived capability for a spawn, and allowed for a stop. Its refusal
 * message is the caller's, since it names the role's configuration.
 */
export function gateLifecycle(
  deps: LifecycleGateDeps,
  req: LifecycleRequest,
  fallback: { allowed: boolean; message: string },
): () => void {
  const { action } = req;

  if (action === 'spawn_agent' && deps.emergency && !deps.emergency.canExecute()) {
    const state = deps.emergency.getState();
    audit(deps, req, 'denied', false);
    throw new AgentLifecycleRefusal(action, 'halted',
      `[SYSTEM ${state.toUpperCase()}] No agent can be started while the system is ${state}.`);
  }

  // Spent by this decision whatever it is: the approved call's first lifecycle
  // act uses the grant up, so an unused one cannot cover a later act (#932).
  const grant = spendApproval(action);
  const decision = lifecycleDecision(deps, req);
  if (!decision) {
    if (!fallback.allowed) {
      audit(deps, req, 'denied', false);
      throw new AgentLifecycleRefusal(action, 'denied', fallback.message);
    }
    return () => audit(deps, req, 'allowed', true);
  }

  if (!decision.allowed) {
    audit(deps, req, 'denied', false);
    throw new AgentLifecycleRefusal(action, 'denied', `Authority denied ${VERB[action]} an agent: ${decision.reason}`);
  }

  if (decision.requiresApproval) {
    // Only a card covers an approval the taint gate asked for: a voice
    // session's auto-approval and a workflow's authorisation never judged the
    // outside content this turn read (the realtime gate refuses it itself).
    const tainted = decision.profileLabel?.includes(TAINT_PROFILE_LABEL) ?? false;
    // A stop is never auto-approved by a voice session (#963): only a real
    // card counts for it.
    const acceptable = grant && (grant.source === 'approval' || (!tainted && action !== 'terminate_agent'));
    if (acceptable) {
      return () => audit(deps, req, 'approval_required', true, grant!.approvalId, grant!.source);
    }
    const card = raiseOrAudit(deps, req, decision.reason);
    audit(deps, req, 'approval_required', false, card?.id ?? null);
    throw new AgentLifecycleRefusal(action, 'approval_required', card
      ? `${VERB[action][0]!.toUpperCase()}${VERB[action].slice(1)} the agent needs your approval (${decision.reason}). Request #${card.id.slice(0, 8)} is waiting on the dashboard.`
      : `${VERB[action][0]!.toUpperCase()}${VERB[action].slice(1)} the agent needs your approval (${decision.reason}), and there is no way to ask for it from here.`,
    card?.id ?? null);
  }

  return () => audit(deps, req, 'allowed', true);
}

/**
 * Raise a card for `req` WITHOUT acting, whatever the engine would allow: for
 * the voice cancel, which may stop an agent only through a card (#963). A hard
 * deny still refuses, since the card could never be carried out.
 */
export function askLifecycleApproval(deps: LifecycleGateDeps, req: LifecycleRequest): ApprovalRequest {
  const decision = lifecycleDecision(deps, req);
  if (decision && !decision.allowed) {
    audit(deps, req, 'denied', false);
    throw new AgentLifecycleRefusal(req.action, 'denied', `Authority denied ${VERB[req.action]} an agent: ${decision.reason}`);
  }
  const reason = decision?.requiresApproval ? decision.reason : `${req.action} asked for by voice requires user approval`;
  const card = raiseOrAudit(deps, req, reason);
  audit(deps, req, 'approval_required', false, card?.id ?? null);
  if (!card) {
    throw new AgentLifecycleRefusal(req.action, 'approval_required',
      `${VERB[req.action][0]!.toUpperCase()}${VERB[req.action].slice(1)} the agent needs your approval, and there is no way to ask for it from here.`);
  }
  return card;
}
