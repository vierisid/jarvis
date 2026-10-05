/**
 * Q-13: qualify a prepared proposal before it says Ready.
 *
 * F-09 prepares a proposal from evidence, a goal link, a composition record and
 * an exact workflow version. Its provider may report `ready` only for a `ready`
 * qualification of that exact snapshot (F-01 `capabilities.ts`). This module
 * reads live state once (`observePreparedProposal`), judges it with a pure
 * function (`judgePreparedProposal`) and fingerprints both, so a recheck over
 * unchanged inputs returns the same answer and any relevant change produces a
 * different fingerprint. It never composes, publishes, enables or runs a
 * workflow. Contract: docs/prepared-proposal-qualification.md.
 */
import type { BriefBinding, BriefEvidenceRef, BriefRevision, BriefTimestamp } from '../brief/contracts.ts';
import { projectLegacyGoal } from '../brief/adapters.ts';
import type { ActionCategory } from '../roles/authority.ts';
import { combineDecisions, type AuthorityEngine } from '../authority/engine.ts';
import { resolveToolGate, substituteAboveLevel } from '../authority/tool-action-map.ts';
import type { ToolDefinition } from '../actions/tools/registry.ts';
import type { ExecutionTarget } from '../util/execution-environment.ts';
import { getGoal } from '../vault/goals.ts';
import { getWorkflowDb } from '../workflows/db/index.ts';
import { walkFlowNodes } from '../workflows/db/flow-graph.ts';
import { getFlow, parseFlowMetadata } from '../workflows/db/repos/flow.ts';
import { getFlowVersion, type FlowTriggerNode } from '../workflows/db/repos/flow-version.ts';
import { getFlowRun } from '../workflows/db/repos/flow-run.ts';
import { versionReadiness } from '../workflows/db/repos/flow-readiness.ts';
import { getWorkflowComposition } from '../workflows/db/repos/workflow-composition.ts';
import { listWorkflowEffects } from '../workflows/db/repos/workflow-effect.ts';
import type { CredentialResolver } from '../workflows/credentials/adapter.ts';
import { digest } from '../workflows/runtime/effect-context.ts';
import { GATED_TOOL_NAMES, toolEffectCapability } from '../workflows/runtime/effect-capabilities.ts';
import { governedPieceToolDefinition, PIECE_TOOL_CATEGORY, resolveGovernedPieceAction } from '../workflows/runtime/piece-effects.ts';
import type { WorkflowReadiness } from '../workflows/runtime/workflow-readiness.ts';
import type { JobKind } from './opportunity-types.ts';

export const QUALIFIER = 'prepared-qualification-v1';
/** Identifies samples produced by `prepared-dry-run.ts`; nothing else may claim it. */
export const DRY_RUNNER = 'prepared-dry-run-v1';

/** Constraints a job states that can be checked against the graph. */
export type JobConstraint =
  /** Anything that reaches another person or cannot be undone asks the user first. */
  | { kind: 'review_before_effects' }
  /** No step may reach these Authority categories (for example a draft-only job forbids send_email). */
  | { kind: 'forbid'; categories: ActionCategory[] }
  /** Deliveries go only to these literal recipients. */
  | { kind: 'recipients'; allowed: string[] }
  /** A stated constraint no check here can verify; a person reviews it. */
  | { kind: 'unverified'; text: string };

/** Each opportunity kind promises drafts or checked output for approval (job-hypotheses.ts), never a direct send. */
export const JOB_CONSTRAINTS: Record<JobKind, JobConstraint[]> = {
  invoice_review: [{ kind: 'review_before_effects' }],
  lead_followup: [{ kind: 'review_before_effects' }],
  recurring_report: [{ kind: 'review_before_effects' }],
};

/** What a preview tells the user. Every effect step appears once; read steps do not. */
export interface PreparedPreview {
  basis: 'illustrative_template' | 'sandbox_sample' | 'verified_output';
  /** verified_output only: the real run whose output the preview shows. */
  runId: string | null;
  effects: Array<{
    step: string;
    /** Whether the preview says this step asks the user before it acts. */
    approval: 'asks_first' | 'runs_automatically';
    /** What the preview says happened to this step in its sample. */
    sample: 'none' | 'simulated' | 'completed';
  }>;
}

/** One execution of a version with every service simulated (`prepared-dry-run.ts`). */
export interface DrySample {
  runner: typeof DRY_RUNNER;
  flowId: string;
  versionId: string;
  versionDigest: string;
  fixtureId: string;
  fixtureDigest: string;
  status: string;
  error: string | null;
  /** Steps whose daemon service was called and simulated, in call order. Nothing else is reachable. */
  simulated: Array<{ step: string; service: 'llm' | 'notify' | 'tool' | 'context' }>;
  /** Step outputs, each cut to a bounded size. */
  outputs: Record<string, unknown>;
}

export interface QualificationRequest {
  proposalId: string;
  revision: BriefRevision;
  evidence: BriefEvidenceRef[];
  goal: { goalId: string; revision: BriefRevision } | null;
  /** The `workflow_composition` record the version came from. */
  compositionId: string | null;
  /** The exact version, pinned when it was prepared by `versionDigest(trigger)`. */
  workflow: { flowId: string; versionId: string; versionDigest: string } | null;
  /** The bindings the proposal shows: `briefBindings(requiredBindings(...))`. */
  bindings: BriefBinding[];
  constraints: JobConstraint[];
  preview: PreparedPreview | null;
  /** The dry fixture run of this version. Required when `drySupport` accepts its graph. */
  sample: DrySample | null;
}

export type QualificationCode =
  | 'incomplete' | 'goal_changed' | 'goal_inactive' | 'composition_unlinked'
  | 'version_missing' | 'version_changed' | 'version_not_ready'
  | 'binding_unavailable' | 'binding_undeclared' | 'binding_changed'
  | 'recipient_missing' | 'authority_denied' | 'effect_ungoverned' | 'effect_unreviewable'
  | 'constraint_violated' | 'constraint_unverified'
  | 'sample_missing' | 'sample_failed' | 'sample_mismatch' | 'sample_unsafe'
  | 'preview_missing' | 'preview_unsupported' | 'preview_misstated';

export interface QualificationReason {
  code: QualificationCode;
  /** blocked: something must change. review_needed: nothing here is wrong, but a person must check what this cannot. */
  severity: 'blocked' | 'review_needed';
  step?: string;
  message: string;
}

export interface Qualification {
  qualifier: typeof QUALIFIER;
  verdict: 'ready' | 'blocked' | 'review_needed';
  reasons: QualificationReason[];
  /** The exact snapshot judged. Same fingerprint, same inputs, same verdict. */
  snapshot: {
    proposalId: string; revision: BriefRevision;
    flowId: string | null; versionId: string | null; versionDigest: string | null;
    bindings: BriefBinding[];
    fingerprint: string;
  };
  checkedAt: BriefTimestamp;
}

export interface BindingFact {
  kind: 'connection' | 'target';
  id: string;
  /** Identity of what the binding resolves to; a token refresh does not change it. */
  revision: BriefRevision | null;
  availability: 'ready' | 'unavailable' | 'unknown';
  reason: string | null;
  steps: string[];
}

export interface StepFact {
  step: string;
  piece: string | null;
  action: string | null;
  /** read_data steps read sources; every other category is an effect. */
  role: 'source' | 'effect';
  category: ActionCategory | null;
  /** The decision the effect boundary would make for the workflow principal. */
  decision: 'auto' | 'approval' | 'denied' | 'ungoverned';
  reason: string;
  /** Set when part of what this step does is decided only at run time. */
  unreviewable: string | null;
  /** Deliveries to people other than the owner. */
  recipients: { state: 'ok' | 'missing' | 'placeholder' | 'runtime'; literals: string[] } | null;
}

export interface QualificationFacts {
  goal: { revision: BriefRevision; active: boolean } | null;
  composition: { state: 'COMPOSING' | 'VALIDATED' | 'FAILED'; linked: boolean } | null;
  version: { digest: string; state: 'DRAFT' | 'LOCKED'; readiness: WorkflowReadiness; dry: string | null } | null;
  bindings: BindingFact[];
  steps: StepFact[];
  /** The preview's real run, when it claims verified output. */
  run: { flowId: string; versionId: string; status: string; proven: boolean; succeeded: string[] } | null;
}

export interface QualificationServices {
  now(): number;
  goal(goalId: string): { revision: BriefRevision; active: boolean } | null;
  composition(id: string): { state: 'COMPOSING' | 'VALIDATED' | 'FAILED' } | null;
  flowMetadata(flowId: string): Record<string, unknown> | null;
  /** The version's graph and live readiness, or null when it is missing or belongs to another flow. */
  version(flowId: string, versionId: string): { projectId: string; trigger: FlowTriggerNode; state: 'DRAFT' | 'LOCKED'; readiness: WorkflowReadiness } | null;
  /** Project-scoped and metadata only; never decrypts or refreshes a credential. */
  connection(projectId: string, externalId: string, pieceName: string): { revision: BriefRevision | null; reason: string | null };
  targets(): ExecutionTarget[];
  tool(name: string): ToolDefinition | null;
  authority: AuthorityEngine | null;
  run(runId: string): { flowId: string; versionId: string; status: string;
    effects: Array<{ stepName: string; versionDigest: string; status: string }> } | null;
}

/** The identity the effect boundary pins an execution to (`effect-context.ts`). */
export const versionDigest = (trigger: unknown) => digest(trigger);

const JARVIS = '@jarvispieces/piece-jarvis-';
/** Pieces that compute locally and call no daemon service. */
const PURE_PIECES = new Set(['regex', 'validate']);
const EXPRESSION = /\{\{[\s\S]*?\}\}/;
/** The binding grammar readiness parses inside each `{{...}}` (`workflow-readiness.ts`). */
const CONNECTION_SOURCE = /^connections(?:\.([\w:-]+)|\['([^']+)'\])$/;
const DELIVERY: ReadonlySet<ActionCategory> = new Set(['send_email', 'send_message']);
/** Effects a "for approval" job must not run unasked: deliveries, and anything external or irreversible. */
const REVIEWED: ReadonlySet<ActionCategory> = new Set(['send_email', 'send_message', 'access_browser',
  'delete_data', 'modify_settings', 'make_payment', 'install_software', 'execute_command', 'terminate_agent']);
/** Input names that address a person or a conversation, across the governed adapters' target props. */
const RECIPIENT_PROPS = ['receiver', 'to', 'cc', 'bcc', 'recipients', 'email', 'channel', 'channel_id',
  'user', 'userId', 'user_id', 'chat_id', 'username', 'handle', 'attendees'];
/** A reply, forward or saved draft is addressed by the message it continues. */
const THREAD_PROPS = ['message_id', 'message_ids', 'thread_id', 'draft_id', 'ts', 'threadTs'];
const PLACEHOLDERS = [
  /^<[^<>]*>$/, /^\[[^[\]]*\]$/,
  /\b(?:tbd|todo|fixme|placeholder|changeme|change[ _-]me|x{3,})\b/i,
  // RFC 2606 reserves these names; nothing real is delivered to them.
  /@(?:[\w-]+\.)*example(?:\.(?:com|org|net))?$/i, /@(?:[\w-]+\.)*invalid$/i,
];

const bindingKey = (b: { kind: string; id: string }) => `${b.kind}:${b.id}`;
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExpression = (value: unknown): boolean => typeof value === 'string' ? EXPRESSION.test(value)
  : Array.isArray(value) ? value.some(hasExpression) : object(value) ? Object.values(value).some(hasExpression) : false;
const present = (value: unknown) => value !== undefined && value !== null
  && !(typeof value === 'string' && !value.trim()) && !(Array.isArray(value) && value.length === 0);

/**
 * Why the dry runner cannot execute this graph without reaching a real
 * service, or null. A community piece calls its API from inside the engine and
 * CODE runs arbitrary code; neither passes through the simulated services.
 * Agents and nested workflows start work this qualification cannot see.
 */
export function drySupport(trigger: unknown): string | null {
  if (!object(trigger)) return 'The workflow graph is unreadable';
  for (const node of walkFlowNodes(trigger as FlowTriggerNode)) {
    if (node === trigger || node.type === 'ROUTER' || node.type === 'LOOP_ON_ITEMS') continue;
    if (node.type !== 'PIECE') return `${node.name} is a ${node.type} step`;
    const piece = String(node.settings?.pieceName ?? '');
    const name = piece.startsWith(JARVIS) ? piece.slice(JARVIS.length) : null;
    if (!name || !(PURE_PIECES.has(name) || ['ask', 'notify', 'context', 'tool'].includes(name))) {
      return `${node.name} uses ${piece || 'an unknown piece'}, which the dry runner cannot simulate`;
    }
  }
  return null;
}

/** Connections and targets the graph binds, with live availability. F-09 shows these as its `BriefBinding`s. */
export function requiredBindings(trigger: FlowTriggerNode, projectId: string, targets: ExecutionTarget[],
  connection: QualificationServices['connection']): BindingFact[] {
  const found = new Map<string, BindingFact>();
  const add = (fact: Omit<BindingFact, 'steps'>, step: string) => {
    const key = `${fact.kind}:${fact.id}`;
    const existing = found.get(key);
    if (existing) { if (!existing.steps.includes(step)) existing.steps.push(step); return; }
    found.set(key, { ...fact, steps: [step] });
  };
  for (const node of walkFlowNodes(trigger)) {
    const pieceName = String(node.settings?.pieceName ?? '');
    const visit = (value: unknown) => {
      if (typeof value === 'string') {
        for (const [, source] of value.matchAll(/\{\{(.*?)\}\}/g)) {
          const match = source === source!.trim() ? CONNECTION_SOURCE.exec(source!) : null;
          if (!match) continue;
          const id = (match[1] ?? match[2])!;
          const live = connection(projectId, id, pieceName);
          add({ kind: 'connection', id, revision: live.revision, availability: live.reason ? 'unavailable' : 'ready', reason: live.reason }, node.name);
        }
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (object(value)) Object.values(value).forEach(visit);
    };
    visit(node.settings?.input);
    const params = node.settings?.input?.params;
    if (pieceName === JARVIS + 'tool' && object(params) && present(params.target) && !hasExpression(params.target)) {
      const name = String(params.target);
      const target = targets.find(t => t.name === name || (t.id && t.id === name));
      if (!target) add({ kind: 'target', id: name, revision: null, availability: 'unavailable', reason: `No machine named ${name} is enrolled` }, node.name);
      else {
        const id = target.isHost ? 'host' : target.id;
        const availability = target.isHost || target.connected === true ? 'ready' : target.connected === false ? 'unavailable' : 'unknown';
        add({ kind: 'target', id, revision: digest({ id, name: target.name, os: target.os, capabilities: [...(target.capabilities ?? [])].sort() }),
          availability, reason: availability === 'ready' ? null : `${target.name} is ${availability === 'unavailable' ? 'offline' : 'not reporting its state'}` }, node.name);
      }
    }
  }
  // Code-point order, so the fingerprint never depends on the host's locale.
  return [...found.values()].sort((a, b) => bindingKey(a) < bindingKey(b) ? -1 : bindingKey(a) > bindingKey(b) ? 1 : 0);
}

/** Who a delivery reaches. Null when the step is not a delivery. */
function recipientsOf(input: Record<string, unknown>, props: readonly string[]): NonNullable<StepFact['recipients']> {
  const supplied = props.filter(p => present(input[p]));
  if (!supplied.length) {
    return { state: THREAD_PROPS.some(p => present(input[p])) ? 'ok' : 'missing', literals: [] };
  }
  const literals: string[] = [];
  let runtime = false, placeholder = false;
  for (const prop of supplied) {
    for (const value of (Array.isArray(input[prop]) ? input[prop] as unknown[] : [input[prop]])) {
      if (hasExpression(value)) { runtime = true; continue; }
      for (const part of String(value).split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
        if (PLACEHOLDERS.some(p => p.test(part))) placeholder = true;
        else literals.push(part);
      }
    }
  }
  return { state: placeholder ? 'placeholder' : literals.length ? 'ok' : runtime ? 'runtime' : 'missing', literals: literals.sort() };
}

type Judged = Pick<StepFact, 'decision' | 'reason'>;
/** The effect boundary's own fold (`effect-boundary.ts` policy()), without its run, emergency or cancellation fences. */
function decide(authority: AuthorityEngine | null, effect: {
  toolName: string; toolCategory: string; category: ActionCategory; categories?: ActionCategory[];
  aboveLevelFloor?: ActionCategory; confirmation?: boolean;
}): Judged {
  if (!authority) return { decision: 'denied', reason: 'Workflow Authority is unavailable; execution denied' };
  const check = (actionCategory: ActionCategory) => authority.checkAuthority({ agentId: 'workflow:qualification',
    agentRoleId: 'workflow-default', agentAuthorityLevel: 0, toolName: effect.toolName, toolCategory: effect.toolCategory,
    actionCategory, temporaryGrants: new Map(), profile: null });
  const folded = combineDecisions((effect.categories?.length ? effect.categories : [effect.category]).map(check));
  const decision = effect.aboveLevelFloor
    ? substituteAboveLevel(folded, { confirm: 'above_level', floorCategory: effect.aboveLevelFloor }, check) : folded;
  if (!decision.allowed) return { decision: 'denied', reason: decision.reason };
  if (effect.confirmation || decision.requiresApproval) return { decision: 'approval', reason: decision.reason };
  return { decision: 'auto', reason: decision.reason };
}

function judgeStep(node: FlowTriggerNode, services: Pick<QualificationServices, 'tool' | 'authority'>): StepFact | null {
  const step = node.name;
  if (node.type === 'CODE') return { step, piece: null, action: null, role: 'effect', category: null, decision: 'ungoverned',
    reason: 'Code steps run without Authority', unreviewable: null, recipients: null };
  if (node.type !== 'PIECE') return null;
  const piece = String(node.settings?.pieceName ?? ''), action = String(node.settings?.actionName ?? '');
  const input = object(node.settings?.input) ? node.settings!.input! : {};
  const fact = (category: ActionCategory, judged: Judged, extra: Partial<StepFact> = {}): StepFact => ({
    step, piece, action, role: category === 'read_data' ? 'source' : 'effect', category, ...judged,
    unreviewable: null, recipients: null, ...extra });
  if (piece.startsWith(JARVIS)) {
    const name = piece.slice(JARVIS.length);
    if (PURE_PIECES.has(name)) return null;
    // The routes below mirror `service-backends.ts`; the parity test runs both.
    if (name === 'notify') return fact('send_message', decide(services.authority,
      { toolName: 'workflow_notify', toolCategory: 'notification', category: 'send_message' }));
    if (name === 'ask') return fact('read_data', decide(services.authority,
      { toolName: 'workflow_ask', toolCategory: 'llm', category: 'read_data' }));
    if (name === 'context') return fact('read_data', decide(services.authority,
      { toolName: `workflow_${action}`, toolCategory: 'context', category: 'read_data' }));
    if (name === 'agent') return fact('spawn_agent', decide(services.authority,
      { toolName: 'workflow_delegate', toolCategory: 'delegation', category: 'spawn_agent' }),
      { unreviewable: 'The delegated agent chooses its actions at run time' });
    if (name === 'trigger') return fact('spawn_agent', decide(services.authority,
      { toolName: 'workflow_start', toolCategory: 'delegation', category: 'spawn_agent' }),
      { unreviewable: 'The workflow it starts is not part of this proposal' });
    if (name === 'tool') {
      const toolName = input.toolName, params = object(input.params) ? input.params : {};
      if (typeof toolName !== 'string' || hasExpression(toolName)) return fact('execute_command',
        { decision: 'denied', reason: 'the tool is chosen at run time, so it cannot be qualified' });
      const tool = services.tool(toolName);
      if (!tool) return fact('execute_command', { decision: 'denied', reason: `tool ${toolName} is not installed` });
      let capability: ReturnType<typeof toolEffectCapability>;
      try { capability = toolEffectCapability(tool, params); }
      catch (error) { return fact('execute_command', { decision: 'denied', reason: (error as Error).message }); }
      const gate = resolveToolGate(tool, toolName, params);
      const judged = fact(capability.category, decide(services.authority, { toolName: tool.name, toolCategory: tool.category,
        category: capability.category, categories: capability.categories,
        ...(gate.confirm ? { aboveLevelFloor: gate.floorCategory } : {}), confirmation: gate.confirm === 'always' }));
      // A per-call gate judges the resolved arguments; with runtime values the
      // decision here could be stricter than the one made at dispatch.
      if ((tool.authorityGate || GATED_TOOL_NAMES.has(tool.name)) && hasExpression(params)) {
        judged.unreviewable = `${toolName}'s Authority decision depends on values known only at run time`;
      }
      if (present(params.target) && hasExpression(params.target)) judged.unreviewable = 'The machine is chosen at run time';
      if (DELIVERY.has(capability.category)) judged.recipients = recipientsOf(params, RECIPIENT_PROPS);
      return judged;
    }
    return { step, piece, action, role: 'effect', category: null, decision: 'ungoverned',
      reason: `${piece} has no workflow Authority route`, unreviewable: null, recipients: null };
  }
  const resolved = resolveGovernedPieceAction(piece, action);
  if (!resolved) return { step, piece, action, role: 'effect', category: null, decision: 'ungoverned',
    reason: `${piece} is not a governed piece; its actions run without Authority`, unreviewable: null, recipients: null };
  const tool = governedPieceToolDefinition(resolved);
  let category: ActionCategory;
  try { category = toolEffectCapability(tool).category; }
  catch (error) { return fact('execute_command', { decision: 'denied', reason: (error as Error).message }); }
  const judged = fact(category, decide(services.authority, { toolName: tool.name, toolCategory: PIECE_TOOL_CATEGORY, category }));
  if (DELIVERY.has(category)) judged.recipients = recipientsOf(input, resolved.adapter.targetProps.filter(p => RECIPIENT_PROPS.includes(p)));
  return judged;
}

/** Read everything the verdict depends on. Reads only. */
export function observePreparedProposal(request: QualificationRequest, services: QualificationServices): QualificationFacts {
  const goal = request.goal ? services.goal(request.goal.goalId) : null;
  const record = request.compositionId ? services.composition(request.compositionId) : null;
  const metadata = request.workflow ? services.flowMetadata(request.workflow.flowId) : null;
  const composition = record ? { state: record.state, linked: metadata?.compositionRecordId === request.compositionId } : null;
  const live = request.workflow ? services.version(request.workflow.flowId, request.workflow.versionId) : null;
  if (!live) return { goal, composition, version: null, bindings: [], steps: [], run: null };
  const nodes = walkFlowNodes(live.trigger);
  const steps = nodes.map(node => judgeStep(node, services)).filter((s): s is StepFact => s !== null);
  const bindings = requiredBindings(live.trigger, live.projectId, services.targets(), services.connection);
  let run: QualificationFacts['run'] = null;
  if (request.preview?.basis === 'verified_output' && request.preview.runId) {
    const found = services.run(request.preview.runId);
    if (found) {
      const current = versionDigest(live.trigger);
      // A LOCKED version cannot change. A draft is edited in place, so only
      // effect records, which carry the digest they ran under, prove the run.
      const proven = live.state === 'LOCKED' || (found.effects.length > 0 && found.effects.every(e => e.versionDigest === current));
      run = { flowId: found.flowId, versionId: found.versionId, status: found.status, proven,
        succeeded: [...new Set(found.effects.filter(e => e.status === 'succeeded').map(e => e.stepName))].sort() };
    }
  }
  return { goal, composition, bindings, steps, run,
    version: { digest: versionDigest(live.trigger), state: live.state, readiness: live.readiness, dry: drySupport(live.trigger) } };
}

/** The bindings a proposal shows, exactly as qualification compares them. */
export const briefBindings = (facts: BindingFact[]): BriefBinding[] =>
  facts.map(({ kind, id, revision, availability }) => ({ kind, id, revision: revision ?? '', availability }));

/** Pure: the same request and facts always give the same verdict. */
export function judgePreparedProposal(request: QualificationRequest, facts: QualificationFacts, checkedAt: BriefTimestamp): Qualification {
  const reasons: QualificationReason[] = [];
  const block = (code: QualificationCode, message: string, step?: string) => reasons.push({ code, severity: 'blocked', message, ...(step ? { step } : {}) });
  const review = (code: QualificationCode, message: string, step?: string) => reasons.push({ code, severity: 'review_needed', message, ...(step ? { step } : {}) });

  // F-01 requires these for a ready opportunity, so their absence is never Ready.
  if (!request.evidence.length) block('incomplete', 'The proposal cites no evidence');
  if (!request.goal) block('incomplete', 'The proposal has no goal link');
  if (!request.compositionId) block('incomplete', 'The proposal has no composition record');
  if (!request.workflow) block('incomplete', 'The proposal has no workflow version');
  if (!request.preview) block('preview_missing', 'The proposal has no preview');

  if (request.goal) {
    if (!facts.goal) block('goal_inactive', 'The linked goal no longer exists');
    else if (!facts.goal.active) block('goal_inactive', 'The linked goal is no longer active');
    else if (facts.goal.revision !== request.goal.revision) block('goal_changed', 'The linked goal changed after this proposal was prepared');
  }
  if (request.compositionId && (!facts.composition || facts.composition.state !== 'VALIDATED' || !facts.composition.linked)) {
    block('composition_unlinked', 'The workflow is not the validated result of the cited composition');
  }

  // Everything below is about the version's graph, so it needs the version.
  const workflow = request.workflow, version = facts.version;
  if (!workflow) return verdictOf(request, facts, reasons, checkedAt);
  if (!version) {
    block('version_missing', 'The workflow version no longer exists in this workflow');
    return verdictOf(request, facts, reasons, checkedAt);
  }
  if (version.digest !== workflow.versionDigest) block('version_changed', 'The workflow changed after this proposal was prepared');
  for (const issue of version.readiness.issues.slice(0, 5)) block('version_not_ready', `${issue.node}: ${issue.message}`, issue.node);
  if (version.readiness.issues.length > 5) block('version_not_ready', `${version.readiness.issues.length - 5} more readiness issues`);

  // Bindings: every required one is shown, current and ready; nothing else is shown.
  const declared = new Map(request.bindings.map(b => [bindingKey(b), b]));
  for (const binding of facts.bindings) {
    const shown = declared.get(bindingKey(binding));
    const label = binding.kind === 'connection' ? `Account ${binding.id}` : `Machine ${binding.id}`;
    if (binding.availability !== 'ready') block('binding_unavailable', `${label} is unavailable: ${binding.reason ?? binding.availability}`, binding.steps[0]);
    if (!shown) block('binding_undeclared', `${label} is used by ${binding.steps.join(', ')} but not shown on the proposal`, binding.steps[0]);
    else if (shown.revision !== (binding.revision ?? '') || shown.availability !== binding.availability) {
      block('binding_changed', `${label} changed after this proposal was prepared`, binding.steps[0]);
    }
  }
  for (const shown of request.bindings) {
    if (!facts.bindings.some(b => bindingKey(b) === bindingKey(shown))) block('binding_undeclared', `${shown.kind} ${shown.id} is shown but the workflow does not use it`);
  }

  const effects = facts.steps.filter(s => s.role === 'effect');
  for (const step of facts.steps) {
    if (step.decision === 'denied') block('authority_denied', `${step.step} would be refused: ${step.reason}`, step.step);
    if (step.decision === 'ungoverned') review('effect_ungoverned', `${step.step} runs without Authority: ${step.reason}`, step.step);
    if (step.unreviewable) review('effect_unreviewable', `${step.step}: ${step.unreviewable}`, step.step);
    if (step.recipients?.state === 'missing') block('recipient_missing', `${step.step} has no recipient`, step.step);
    if (step.recipients?.state === 'placeholder') block('recipient_missing', `${step.step} is addressed to a placeholder, not a real recipient`, step.step);
  }

  for (const constraint of request.constraints) {
    if (constraint.kind === 'unverified') review('constraint_unverified', `Check by hand: ${constraint.text}`);
    if (constraint.kind === 'review_before_effects') {
      for (const step of effects) {
        if (step.decision === 'ungoverned') block('constraint_violated', `${step.step} cannot ask first: it runs without Authority`, step.step);
        else if (step.decision === 'auto' && step.category && REVIEWED.has(step.category) && step.piece !== JARVIS + 'notify') {
          block('constraint_violated', `${step.step} would ${step.category.replace('_', ' ')} without asking first`, step.step);
        }
      }
    }
    if (constraint.kind === 'forbid') {
      for (const step of facts.steps) {
        if (step.category && constraint.categories.includes(step.category)) block('constraint_violated', `${step.step} reaches ${step.category}, which this job rules out`, step.step);
        else if (step.decision === 'ungoverned') review('constraint_unverified', `${step.step} may reach ${constraint.categories.join(' or ')}; its effect is not classified`, step.step);
      }
    }
    if (constraint.kind === 'recipients') {
      const allowed = new Set(constraint.allowed.map(r => r.toLowerCase()));
      for (const step of effects) {
        if (!step.recipients) continue;
        const outside = step.recipients.literals.filter(r => !allowed.has(r.toLowerCase()));
        if (outside.length) block('constraint_violated', `${step.step} delivers to ${outside.join(', ')}, outside this job's recipients`, step.step);
        if (step.recipients.state === 'runtime') review('constraint_unverified', `${step.step} chooses its recipient at run time`, step.step);
      }
    }
  }

  // Executed evidence: the dry run is the only sample that may say "simulated".
  const sample = request.sample;
  if (sample) {
    if (sample.runner !== DRY_RUNNER) block('sample_unsafe', 'The sample was not produced by the dry runner, which simulates every service');
    else if (sample.flowId !== workflow.flowId || sample.versionId !== workflow.versionId || sample.versionDigest !== version.digest) {
      block('sample_mismatch', 'The sample ran a different workflow version');
    } else if (sample.status !== 'SUCCEEDED') block('sample_failed', `The workflow did not complete on its sample input: ${sample.error ?? sample.status}`);
  } else if (!version.dry) block('sample_missing', 'Run the dry fixture before presenting this workflow');

  const preview = request.preview;
  if (preview) {
    if (preview.basis === 'sandbox_sample' && version.dry) block('preview_unsupported', `The preview claims a sandbox sample, but ${version.dry}`);
    if (preview.basis === 'sandbox_sample' && !sample) block('preview_unsupported', 'The preview claims a sandbox sample that does not exist');
    if (preview.basis === 'verified_output') {
      const run = facts.run;
      if (!run || run.flowId !== workflow.flowId || run.versionId !== workflow.versionId || run.status !== 'SUCCEEDED') {
        block('preview_unsupported', 'The preview claims verified output without a successful run of this version');
      } else if (!run.proven) block('preview_unsupported', 'No record proves the run used this exact version');
    }
    const shown = new Map<string, PreparedPreview['effects'][number]>();
    for (const entry of preview.effects) {
      if (shown.has(entry.step)) block('preview_misstated', `The preview describes ${entry.step} twice`, entry.step);
      shown.set(entry.step, entry);
      if (!effects.some(e => e.step === entry.step)) block('preview_misstated', `The preview describes an effect for ${entry.step}, which has none`, entry.step);
    }
    for (const step of effects) {
      const entry = shown.get(step.step);
      if (!entry) { block('preview_misstated', `The preview leaves out ${step.step}`, step.step); continue; }
      if (entry.approval === 'asks_first' && step.decision !== 'approval') {
        block('preview_misstated', `The preview says ${step.step} asks first, but it would ${step.decision === 'auto' ? 'run without asking' : 'not run'}`, step.step);
      }
      if (entry.approval === 'runs_automatically' && step.decision === 'approval') {
        block('preview_misstated', `The preview says ${step.step} runs automatically, but it asks first`, step.step);
      }
      if (entry.sample === 'completed' && !(preview.basis === 'verified_output' && facts.run?.succeeded.includes(step.step))) {
        block('preview_misstated', `The preview says ${step.step} already happened, and no record shows it did`, step.step);
      }
      if (entry.sample === 'simulated' && !(preview.basis === 'sandbox_sample' && sample?.simulated.some(s => s.step === step.step))) {
        block('preview_misstated', `The preview says ${step.step} was simulated, and the sample did not reach it`, step.step);
      }
    }
  }

  return verdictOf(request, facts, reasons, checkedAt);
}

function verdictOf(request: QualificationRequest, facts: QualificationFacts, reasons: QualificationReason[], checkedAt: BriefTimestamp): Qualification {
  const blocked = reasons.some(r => r.severity === 'blocked');
  return {
    qualifier: QUALIFIER,
    verdict: blocked ? 'blocked' : reasons.length ? 'review_needed' : 'ready',
    reasons,
    snapshot: {
      proposalId: request.proposalId, revision: request.revision,
      flowId: request.workflow?.flowId ?? null, versionId: request.workflow?.versionId ?? null,
      versionDigest: facts.version?.digest ?? null,
      bindings: briefBindings(facts.bindings),
      // The verdict is a pure function of exactly this input.
      fingerprint: digest({ qualifier: QUALIFIER, request, facts }),
    },
    checkedAt,
  };
}

export function qualifyPreparedProposal(request: QualificationRequest, services: QualificationServices): Qualification {
  return judgePreparedProposal(request, observePreparedProposal(request, services), services.now());
}

/**
 * Check a qualification again. Unchanged inputs give the same fingerprint and
 * verdict; a changed version, binding, goal, Authority decision or anything
 * else the verdict depends on gives a new fingerprint, and the earlier result
 * is stale whatever the new verdict is.
 */
export function recheckQualification(previous: Qualification, request: QualificationRequest, services: QualificationServices):
  { current: Qualification; stale: boolean } {
  const current = qualifyPreparedProposal(request, services);
  return { current, stale: current.snapshot.fingerprint !== previous.snapshot.fingerprint };
}

/** F-01's readiness for a prepared opportunity. Only a current ready qualification is ready. */
export function briefReadiness(qualification: Qualification, stale = false):
  { state: 'ready'; checkedAt: BriefTimestamp } | { state: 'blocked' | 'stale'; checkedAt: BriefTimestamp } {
  if (stale) return { state: 'stale', checkedAt: qualification.checkedAt };
  return { state: qualification.verdict === 'ready' ? 'ready' : 'blocked', checkedAt: qualification.checkedAt };
}

/** Live reads for the daemon. Metadata only: no credential is decrypted and nothing is written. */
export function liveQualificationServices(options: {
  authority: AuthorityEngine | null;
  tool: (name: string) => ToolDefinition | null;
  targets: () => ExecutionTarget[];
  credentials?: CredentialResolver;
  now?: () => number;
}): QualificationServices {
  return {
    now: options.now ?? Date.now,
    authority: options.authority,
    tool: options.tool,
    targets: options.targets,
    goal(goalId) {
      const goal = getGoal(goalId);
      return goal ? { revision: projectLegacyGoal(goal).revision, active: goal.status === 'active' } : null;
    },
    composition(id) {
      const record = getWorkflowComposition(id);
      return record ? { state: record.state } : null;
    },
    flowMetadata(flowId) {
      const flow = getFlow(flowId);
      return flow ? parseFlowMetadata(flow) : null;
    },
    version(flowId, versionId) {
      const flow = getFlow(flowId), version = getFlowVersion(versionId);
      if (!flow || !version || version.flowId !== flowId) return null;
      return { projectId: flow.project_id, trigger: version.trigger, state: version.state, readiness: versionReadiness(flowId, versionId) };
    },
    connection(projectId, externalId, pieceName) {
      // The rules readiness applies (`flow-readiness.ts` contextFor), plus the
      // row's identity. `updated` is left out: a token refresh rewrites it
      // without changing which account the binding reaches.
      if (externalId.startsWith('jarvis:')) {
        const ready = options.credentials?.list().some(source => source.canResolve(externalId)) ?? false;
        return { revision: ready ? externalId : null, reason: ready ? null : 'Managed connection source is unavailable' };
      }
      const rows = getWorkflowDb().query<{ id: string; piece_name: string; status: string }, [string, string]>(
        'SELECT id, piece_name, status FROM app_connection WHERE project_id = ? AND external_id = ? LIMIT 2').all(projectId, externalId);
      if (rows.length !== 1) return { revision: null, reason: rows.length ? 'Connection external ID is ambiguous in this project' : 'Connection is missing in this project' };
      const row = rows[0]!;
      const revision = digest({ id: row.id, piece: row.piece_name, status: row.status });
      if (row.piece_name !== pieceName) return { revision, reason: 'Connection belongs to a different piece' };
      return { revision, reason: row.status === 'ACTIVE' ? null : 'Connection is not active' };
    },
    run(runId) {
      const run = getFlowRun(runId);
      if (!run) return null;
      return { flowId: run.flowId, versionId: run.flowVersionId, status: run.status,
        effects: listWorkflowEffects(runId).map(e => ({ stepName: e.stepName, versionDigest: e.versionDigest, status: e.status })) };
    },
  };
}
