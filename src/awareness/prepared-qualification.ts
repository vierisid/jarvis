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
import { BOUNDED_TOOL_NAMES, GATED_TOOL_NAMES, boundedToolCapability, toolEffectCapability } from '../workflows/runtime/effect-capabilities.ts';
import { governedPieceToolDefinition, PIECE_TOOL_CATEGORY, resolveGovernedPieceAction } from '../workflows/runtime/piece-effects.ts';
import type { WorkflowReadiness } from '../workflows/runtime/workflow-readiness.ts';
import type { JobKind } from './opportunity-types.ts';

export const QUALIFIER = 'prepared-qualification-v1';
/** Identifies samples produced by `prepared-dry-run.ts`; nothing else may claim it. */
export const DRY_RUNNER = 'prepared-dry-run-v1';

/** Constraints a job states that can be checked against the graph. */
export type JobConstraint =
  /** Sends, deletions and other external or irreversible effects ask the user first; shared writes get a person's review. */
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
  /** Step outputs, each cut to a bounded size. A loop step keeps its last iteration. */
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
  | 'recipient_missing' | 'authority_denied' | 'effect_unavailable' | 'effect_ungoverned' | 'effect_unreviewable'
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

/** A machine a tool step can name, as the sidecar inventory reports it. */
export type QualificationTarget = ExecutionTarget & { unavailableCapabilities?: string[] };

export interface StepFact {
  step: string;
  piece: string | null;
  action: string | null;
  /** Steps that only read are sources; anything else is an effect. */
  role: 'source' | 'effect';
  /** The most severe category, and every category the step reaches, most severe first. */
  category: ActionCategory | null;
  categories: ActionCategory[];
  /**
   * What the effect boundary would do for the workflow principal. `unknown`:
   * decided at run time. `unavailable`: refused before Authority is asked.
   */
  decision: 'auto' | 'approval' | 'denied' | 'ungoverned' | 'unknown' | 'unavailable';
  reason: string;
  /** What this step decides only at run time, so no one can confirm it now. */
  unreviewable: string[];
  /** Deliveries to people other than the owner. */
  recipients: { state: 'ok' | 'missing' | 'placeholder' | 'runtime'; literals: string[] } | null;
  /** The service of a write that may reach whoever shares that space. */
  shared: string | null;
}

export interface QualificationFacts {
  goal: { revision: BriefRevision; active: boolean } | null;
  composition: { state: 'COMPOSING' | 'VALIDATED' | 'FAILED'; linked: boolean } | null;
  version: { digest: string; state: 'DRAFT' | 'LOCKED'; readiness: WorkflowReadiness; dry: string | null } | null;
  bindings: BindingFact[];
  steps: StepFact[];
  /** The preview's real run, when it claims verified output. */
  run: { flowId: string; versionId: string; status: string; partial: boolean; proven: boolean; completed: string[] } | null;
}

export interface QualificationServices {
  now(): number;
  goal(goalId: string): { revision: BriefRevision; active: boolean } | null;
  composition(id: string): { state: 'COMPOSING' | 'VALIDATED' | 'FAILED' } | null;
  flowMetadata(flowId: string): Record<string, unknown> | null;
  /** The version's graph and live readiness, or null when it is missing or belongs to another flow. */
  version(flowId: string, versionId: string): {
    projectId: string; trigger: FlowTriggerNode; state: 'DRAFT' | 'LOCKED'; updated: number; readiness: WorkflowReadiness;
  } | null;
  /** Project-scoped and metadata only; never decrypts or refreshes a credential. */
  connection(projectId: string, externalId: string, pieceName: string): { revision: BriefRevision | null; reason: string | null };
  targets(): QualificationTarget[];
  tool(name: string): ToolDefinition | null;
  authority: AuthorityEngine | null;
  /** A run's identity and outcome: effect records and each step's status, never step payloads. */
  run(runId: string): {
    flowId: string; versionId: string; status: string; created: number; partial: boolean;
    effects: Array<{ stepName: string; versionDigest: string; status: string }>;
    steps: Record<string, string | null>;
  } | null;
}

/** The identity the effect boundary pins an execution to (`effect-context.ts`). */
export const versionDigest = (trigger: unknown) => digest(trigger);

const JARVIS = '@jarvispieces/piece-jarvis-';
/** Jarvis pieces that compute locally: no daemon service, connection or store. */
const PURE_PIECES = new Set(['regex']);
/** Jarvis pieces whose every daemon call the dry runner simulates. */
const DRY_PIECES = new Set([...PURE_PIECES, 'ask', 'notify', 'context', 'tool']);
const EXPRESSION = /\{\{[\s\S]*?\}\}/;
/** The binding grammar readiness parses inside each `{{...}}` (`workflow-readiness.ts`). */
const CONNECTION_SOURCE = /^connections(?:\.([\w:-]+)|\['([^']+)'\])$/;
const DELIVERY: ReadonlySet<ActionCategory> = new Set(['send_email', 'send_message']);
/** Effects a "for approval" job must not run unasked: deliveries, and anything external or irreversible. */
const REVIEWED: ReadonlySet<ActionCategory> = new Set(['send_email', 'send_message', 'access_browser',
  'delete_data', 'modify_settings', 'make_payment', 'install_software', 'execute_command', 'terminate_agent']);

/**
 * Who each verified delivery action reaches, from its manifest props
 * (`pieces-library/verified-manifests-generated.ts`); a test keeps it in step
 * with the adapters. `to`: at least one must name a recipient. `cc`: more
 * recipients, checked but not enough alone. `continues`: the action continues
 * a message, thread or draft that already has recipients. `none`: published,
 * not addressed.
 */
type Delivery = { to?: string[]; cc?: string[]; continues?: string[]; none?: true };
const MAIL: Delivery = { to: ['receiver'], cc: ['cc', 'bcc'] };
export const DELIVERIES: Readonly<Record<string, Delivery>> = {
  'gmail:send_email': MAIL, 'gmail:gmail_send_email': MAIL, 'gmail:request_approval_in_mail': MAIL,
  // A forward carries an existing message to new people: the message is content, not an address.
  'gmail:gmail_forward_message': MAIL,
  'gmail:reply_to_email': { continues: ['message_id'] }, 'gmail:gmail_reply_to_thread': { continues: ['message_id'] },
  'gmail:gmail_send_draft': { continues: ['draft_id'] },
  'slack:send_direct_message': { to: ['userId'] }, 'slack:request_approval_direct_message': { to: ['userId'] },
  'slack:request_action_direct_message': { to: ['userId'] }, 'slack:slack_send_direct_message': { to: ['userId'] },
  'slack:send_channel_message': { to: ['channel'] }, 'slack:request_approval_message': { to: ['channel'] },
  'slack:request_action_message': { to: ['channel'] }, 'slack:slack_post_message': { to: ['channel'] },
  'slack:slack_schedule_message': { to: ['channel'] }, 'slack:slack_send_ephemeral_message': { to: ['user'], cc: ['channel'] },
  'slack:send_message_to_multiple_users': { to: ['recipients'] },
  'slack:updateMessage': { continues: ['ts'] }, 'slack:slack_update_message': { continues: ['ts'] },
  'discord:sendMessageWithBot': { to: ['channel_id'] }, 'discord:discord_send_message': { to: ['channel_id'] },
  'discord:send_message_webhook': { to: ['webhook_url'] }, 'discord:request_approval_message': { to: ['channel'] },
  'discord:discord_edit_message': { continues: ['message_id'] },
  'telegram-bot:send_text_message': { to: ['chat_id'] }, 'telegram-bot:send_media': { to: ['chat_id'] },
  'telegram-bot:request_approval_message': { to: ['chat_id'] },
  'github:github_create_gist': { none: true },
  'google-calendar:google-calendar-add-attendees': { to: ['attendees'] },
  'google-calendar:google_calendar_remove_attendee': { to: ['attendee_email'] },
};
/** Third-party writes that stay with the user: mailbox drafts, labels and archive. */
const PRIVATE_WRITES = new Set(['create_draft_reply', 'gmail_create_draft', 'gmail_update_draft', 'gmail_create_label',
  'gmail_add_label_to_email', 'gmail_remove_label_from_email', 'gmail_archive_email', 'gmail_archive_message',
  'gmail_get_or_create_label', 'gmail_update_label', 'gmail_untrash_message'].map(action => `gmail:${action}`));
/** Model providers: what a step writes goes to the provider, not to people. */
const PRIVATE_SERVICES = new Set(['openai', 'claude']);
/** The inputs a tool's own Authority gate reads, where it reads fewer than all (`builtin.ts` write_file). */
const GATE_INPUTS: Readonly<Record<string, readonly string[]>> = { write_file: ['path'] };
/** Whole values that stand in for a recipient. */
const PLACEHOLDERS = [
  /^<[^<>]*>$/, /^\[[^[\]]*\]$/, /^\{[^{}]*\}$/,
  /^(?:tbd|todo|fixme|placeholder|changeme|change[ _-]me|x{3,})$/i,
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

/** A tool step's params as readiness and the engine read them: an object, or the JSON text of one. */
function toolParams(raw: unknown): { params: Record<string, unknown>; known: boolean } {
  if (raw === undefined || raw === null) return { params: {}, known: true };
  if (object(raw)) return { params: raw, known: true };
  if (typeof raw === 'string' && !hasExpression(raw)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (object(parsed)) return { params: parsed, known: true };
    } catch { /* not JSON; readiness reports it */ }
  }
  return { params: {}, known: false };
}

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
    if (!name || !DRY_PIECES.has(name)) return `${node.name} uses ${piece || 'an unknown piece'}, which the dry runner cannot simulate`;
  }
  return null;
}

/** The runtime's lookup (`machine-binding.ts` identify): sidecars only, by id, then name, then a unique partial name, ignoring case. */
function identifyTarget(selector: string, targets: QualificationTarget[]): QualificationTarget | 'ambiguous' | null {
  const sidecars = targets.filter(t => !t.isHost);
  const exact = sidecars.find(t => t.id === selector);
  if (exact) return exact;
  const wanted = selector.toLowerCase();
  const named = sidecars.filter(t => t.name.toLowerCase() === wanted);
  const matches = named.length ? named : sidecars.filter(t => t.name.toLowerCase().includes(wanted));
  return matches.length === 1 ? matches[0]! : matches.length ? 'ambiguous' : null;
}

const AVAILABILITY_RANK = { ready: 0, unknown: 1, unavailable: 2 } as const;

/** Connections and machines the graph binds, with live availability. F-09 shows these as its `BriefBinding`s. */
export function requiredBindings(trigger: FlowTriggerNode, projectId: string, targets: QualificationTarget[],
  connection: QualificationServices['connection']): BindingFact[] {
  const found = new Map<string, BindingFact>();
  const add = (fact: Omit<BindingFact, 'steps'>, step: string) => {
    const existing = found.get(bindingKey(fact));
    if (!existing) { found.set(bindingKey(fact), { ...fact, steps: [step] }); return; }
    if (!existing.steps.includes(step)) existing.steps.push(step);
    // One machine can serve one step and not another (a missing capability): keep the worst.
    if (AVAILABILITY_RANK[fact.availability] > AVAILABILITY_RANK[existing.availability]) {
      existing.availability = fact.availability;
      existing.reason = fact.reason;
    }
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
    if (pieceName !== JARVIS + 'tool') continue;
    const { params, known } = toolParams(node.settings?.input?.params);
    const selector = known && typeof params.target === 'string' && !hasExpression(params.target) ? params.target.trim() : '';
    if (!selector) continue;
    const toolName = node.settings?.input?.toolName;
    const capability = typeof toolName === 'string' && BOUNDED_TOOL_NAMES.has(toolName) ? boundedToolCapability(toolName) : null;
    const target = identifyTarget(selector, targets);
    if (!target || target === 'ambiguous') {
      add({ kind: 'target', id: selector, revision: null, availability: 'unavailable',
        reason: target ? `several machines match "${selector}"` : `no enrolled machine matches "${selector}"` }, node.name);
      continue;
    }
    // Dispatch refuses a machine that does not offer the capability (`machine-binding.ts` assertDispatch).
    const lacks = capability !== null && (!target.capabilities?.includes(capability) || !!target.unavailableCapabilities?.includes(capability));
    const availability = lacks || target.connected === false ? 'unavailable' : target.connected === true ? 'ready' : 'unknown';
    add({ kind: 'target', id: target.id, availability,
      revision: digest({ id: target.id, name: target.name, os: target.os, capabilities: [...(target.capabilities ?? [])].sort(),
        unavailable: [...(target.unavailableCapabilities ?? [])].sort() }),
      reason: lacks ? `${target.name} cannot run ${capability} tools`
        : availability === 'ready' ? null : `${target.name} is ${availability === 'unavailable' ? 'offline' : 'not reporting its state'}` }, node.name);
  }
  // Code-point order, so the fingerprint never depends on the host's locale.
  return [...found.values()].sort((a, b) => bindingKey(a) < bindingKey(b) ? -1 : bindingKey(a) > bindingKey(b) ? 1 : 0);
}

/** Who a delivery reaches. */
function recipientsFor(delivery: Delivery, input: Record<string, unknown>): NonNullable<StepFact['recipients']> {
  if (delivery.none) return { state: 'ok', literals: [] };
  const to = (delivery.to ?? []).filter(prop => present(input[prop]));
  if (!to.length) return { state: (delivery.continues ?? []).some(prop => present(input[prop])) ? 'ok' : 'missing', literals: [] };
  const literals: string[] = [];
  let reached = false, runtime = false, placeholder = false;
  const read = (prop: string, addressing: boolean) => {
    for (const value of Array.isArray(input[prop]) ? input[prop] as unknown[] : [input[prop]]) {
      if (hasExpression(value)) { runtime = true; reached ||= addressing; continue; }
      for (const part of String(value).split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
        if (PLACEHOLDERS.some(p => p.test(part))) placeholder = true;
        else { literals.push(part); reached ||= addressing; }
      }
    }
  };
  to.forEach(prop => read(prop, true));
  (delivery.cc ?? []).filter(prop => present(input[prop])).forEach(prop => read(prop, false));
  return { state: placeholder ? 'placeholder' : !reached ? 'missing' : runtime ? 'runtime' : 'ok', literals: literals.sort() };
}

type Judged = { decision: 'auto' | 'approval' | 'denied'; reason: string; timed: boolean };
/** The effect boundary's own fold (`effect-boundary.ts` policy()), without its run, emergency or cancellation fences. */
function decide(authority: AuthorityEngine | null, effect: {
  toolName: string; toolCategory: string; category: ActionCategory; categories?: ActionCategory[];
  aboveLevelFloor?: ActionCategory; confirmation?: boolean;
}): Judged {
  if (!authority) return { decision: 'denied', reason: 'Workflow Authority is unavailable; execution denied', timed: false };
  const categories = effect.categories?.length ? effect.categories : [effect.category];
  const check = (actionCategory: ActionCategory) => authority.checkAuthority({ agentId: 'workflow:qualification',
    agentRoleId: 'workflow-default', agentAuthorityLevel: 0, toolName: effect.toolName, toolCategory: effect.toolCategory,
    actionCategory, temporaryGrants: new Map(), profile: null });
  const folded = combineDecisions(categories.map(check));
  const decision = effect.aboveLevelFloor
    ? substituteAboveLevel(folded, { confirm: 'above_level', floorCategory: effect.aboveLevelFloor }, check) : folded;
  // A time-window rule decides by the hour of dispatch, not the hour of qualification.
  const judged = [...categories, ...(effect.aboveLevelFloor ? [effect.aboveLevelFloor] : [])];
  const timed = authority.getConfig().context_rules.some(rule => rule.condition === 'time_range' && judged.includes(rule.action));
  if (!decision.allowed) return { decision: 'denied', reason: decision.reason, timed };
  if (effect.confirmation || decision.requiresApproval) return { decision: 'approval', reason: decision.reason, timed };
  return { decision: 'auto', reason: decision.reason, timed };
}

function judgeStep(node: FlowTriggerNode, services: Pick<QualificationServices, 'tool' | 'authority'>): StepFact | null {
  const step = node.name;
  if (node.type === 'CODE') return { step, piece: null, action: null, role: 'effect', category: null, categories: [],
    decision: 'ungoverned', reason: 'Code steps run without Authority', unreviewable: [], recipients: null, shared: null };
  if (node.type !== 'PIECE') return null;
  const piece = String(node.settings?.pieceName ?? ''), action = String(node.settings?.actionName ?? '');
  const input = object(node.settings?.input) ? node.settings!.input! : {};
  const unjudged = (decision: 'ungoverned' | 'unknown' | 'unavailable', reason: string, unreviewable: string[] = []): StepFact => ({
    step, piece, action, role: 'effect', category: null, categories: [], decision, reason, unreviewable, recipients: null, shared: null });
  const fact = (categories: ActionCategory[], judged: Judged): StepFact => ({
    step, piece, action, role: categories.every(c => c === 'read_data') ? 'source' : 'effect',
    category: categories[0] ?? null, categories, decision: judged.decision, reason: judged.reason,
    unreviewable: judged.timed ? [`Authority decides ${categories.join(' and ')} by the time of day`] : [], recipients: null, shared: null });
  if (piece.startsWith(JARVIS)) {
    const name = piece.slice(JARVIS.length);
    if (PURE_PIECES.has(name)) return null;
    // The routes below mirror `service-backends.ts`; the parity test runs both.
    if (name === 'notify') return fact(['send_message'], decide(services.authority,
      { toolName: 'workflow_notify', toolCategory: 'notification', category: 'send_message' }));
    if (name === 'ask') return fact(['read_data'], decide(services.authority,
      { toolName: 'workflow_ask', toolCategory: 'llm', category: 'read_data' }));
    if (name === 'context') return fact(['read_data'], decide(services.authority,
      { toolName: `workflow_${action}`, toolCategory: 'context', category: 'read_data' }));
    if (name === 'agent' || name === 'trigger') {
      const judged = fact(['spawn_agent'], decide(services.authority, name === 'agent'
        ? { toolName: 'workflow_delegate', toolCategory: 'delegation', category: 'spawn_agent' }
        : { toolName: 'workflow_start', toolCategory: 'delegation', category: 'spawn_agent' }));
      judged.unreviewable.push(name === 'agent' ? 'The delegated agent chooses its actions at run time'
        : 'The workflow it starts is not part of this proposal');
      return judged;
    }
    if (name !== 'tool') return unjudged('ungoverned', `${piece} has no workflow Authority route`);
    const toolName = input.toolName;
    if (typeof toolName !== 'string' || hasExpression(toolName)) {
      return unjudged('unknown', 'the tool is chosen at run time', ['The tool is chosen at run time']);
    }
    const tool = services.tool(toolName);
    if (!tool) return unjudged('unavailable', `tool ${toolName} is not installed`);
    const { params, known } = toolParams(input.params);
    let capability: ReturnType<typeof toolEffectCapability>;
    try { capability = toolEffectCapability(tool, params); }
    catch (error) { return unjudged('unavailable', (error as Error).message); }
    const gate = resolveToolGate(tool, toolName, params);
    const judged = fact(capability.categories, decide(services.authority, { toolName: tool.name, toolCategory: tool.category,
      category: capability.category, categories: capability.categories,
      ...(gate.confirm ? { aboveLevelFloor: gate.floorCategory } : {}), confirmation: gate.confirm === 'always' }));
    // A per-call gate judges the resolved arguments, so a value it reads that
    // is only known at run time can change the decision either way.
    const gateInputs = GATE_INPUTS[tool.name];
    if (!known) judged.unreviewable.push('Its parameters are computed at run time, and with them its Authority decision and machine');
    else {
      if ((tool.authorityGate || GATED_TOOL_NAMES.has(tool.name))
        && (gateInputs ? gateInputs.some(key => hasExpression(params[key])) : hasExpression(params))) {
        judged.unreviewable.push(`${toolName}'s Authority decision depends on values known only at run time`);
      }
      if (present(params.target) && hasExpression(params.target)) judged.unreviewable.push('The machine is chosen at run time');
    }
    if (capability.categories.some(c => DELIVERY.has(c))) judged.unreviewable.push(`Who ${toolName} reaches is not modeled`);
    return judged;
  }
  const resolved = resolveGovernedPieceAction(piece, action);
  if (!resolved) return unjudged('ungoverned', `${piece} is not a governed piece; its actions run without Authority`);
  const tool = governedPieceToolDefinition(resolved);
  let category: ActionCategory;
  try { category = toolEffectCapability(tool).category; }
  catch (error) { return unjudged('unavailable', (error as Error).message); }
  const judged = fact([category], decide(services.authority, { toolName: tool.name, toolCategory: PIECE_TOOL_CATEGORY, category }));
  const service = resolved.adapter.catalogId, key = `${service}:${action}`;
  if (DELIVERY.has(category)) {
    const delivery = DELIVERIES[key];
    if (delivery) judged.recipients = recipientsFor(delivery, input);
    else judged.unreviewable.push(`Who ${action} reaches is not modeled`);
  } else if (category === 'write_data' && !PRIVATE_WRITES.has(key) && !PRIVATE_SERVICES.has(service)) judged.shared = service;
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
  const current = versionDigest(live.trigger);
  let run: QualificationFacts['run'] = null;
  if (request.preview?.basis === 'verified_output' && request.preview.runId) {
    const found = services.run(request.preview.runId);
    if (found) {
      // Effect records carry the digest they ran under, and one that differs
      // disproves the run even on a LOCKED version: publishing locks the draft
      // in place. With no records, only a LOCKED version unchanged since the
      // run started proves it.
      const proven = found.effects.length
        ? found.effects.every(e => e.versionDigest === current)
        : live.state === 'LOCKED' && found.created >= live.updated;
      // A governed piece's effect record means dispatch was authorized; the
      // step's own status says whether the call then completed.
      const completed = found.effects.filter(e => e.status === 'succeeded' && found.steps[e.stepName] === 'SUCCEEDED');
      run = { flowId: found.flowId, versionId: found.versionId, status: found.status, partial: found.partial, proven,
        completed: [...new Set(completed.map(e => e.stepName))].sort() };
    }
  }
  return { goal, composition, bindings, steps, run,
    version: { digest: current, state: live.state, readiness: live.readiness, dry: drySupport(live.trigger) } };
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
    if (step.decision === 'denied') block('authority_denied', `Authority would refuse ${step.step}: ${step.reason}`, step.step);
    if (step.decision === 'unavailable') block('effect_unavailable', `${step.step} cannot run: ${step.reason}`, step.step);
    if (step.decision === 'ungoverned') review('effect_ungoverned', `${step.step} runs without Authority: ${step.reason}`, step.step);
    for (const why of step.unreviewable) review('effect_unreviewable', `${step.step}: ${why}`, step.step);
    if (step.recipients?.state === 'missing') block('recipient_missing', `${step.step} has no recipient`, step.step);
    if (step.recipients?.state === 'placeholder') block('recipient_missing', `${step.step} is addressed to a placeholder, not a real recipient`, step.step);
  }

  for (const constraint of request.constraints) {
    if (constraint.kind === 'unverified') review('constraint_unverified', `Check by hand: ${constraint.text}`);
    if (constraint.kind === 'review_before_effects') {
      for (const step of effects) {
        if (step.decision === 'ungoverned') {
          block('constraint_violated', `${step.step} cannot ask first: it runs without Authority`, step.step);
          continue;
        }
        // The owner's own notification is how a prepared draft reaches the person who approves it.
        if (step.decision !== 'auto' || step.piece === JARVIS + 'notify') continue;
        const reviewed = step.categories.find(c => REVIEWED.has(c));
        if (reviewed) block('constraint_violated', `${step.step} would ${reviewed.replace('_', ' ')} without asking first`, step.step);
        else if (step.shared) review('constraint_unverified', `${step.step} writes to ${step.shared} without asking; check that it reaches no one else`, step.step);
      }
    }
    if (constraint.kind === 'forbid') {
      for (const step of facts.steps) {
        const hit = step.categories.find(c => constraint.categories.includes(c));
        if (hit) block('constraint_violated', `${step.step} reaches ${hit}, which this job rules out`, step.step);
        else if (step.decision === 'ungoverned' || step.decision === 'unknown') {
          review('constraint_unverified', `${step.step} may reach ${constraint.categories.join(' or ')}; what it does is not known`, step.step);
        }
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
      } else if (run.partial) block('preview_unsupported', 'The preview shows a single-step test run, not a run of the workflow');
      else if (!run.proven) block('preview_unsupported', 'No record proves the run used this exact version');
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
      if (entry.sample === 'completed' && !(preview.basis === 'verified_output' && facts.run?.completed.includes(step.step))) {
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
  /** The sidecar inventory, with each machine's unavailable capabilities. */
  targets: () => QualificationTarget[];
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
      return { projectId: flow.project_id, trigger: version.trigger, state: version.state, updated: version.updated,
        readiness: versionReadiness(flowId, versionId) };
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
      // Each streamed step is { output: <engine step record> }; only its status is read.
      const steps = (run.steps ?? {}) as Record<string, { output?: { status?: unknown } } | undefined>;
      return { flowId: run.flowId, versionId: run.flowVersionId, status: run.status, created: run.created,
        partial: run.stepNameToTest !== null,
        effects: listWorkflowEffects(runId).map(e => ({ stepName: e.stepName, versionDigest: e.versionDigest, status: e.status })),
        steps: Object.fromEntries(Object.entries(steps).map(([name, record]) =>
          [name, typeof record?.output?.status === 'string' ? record.output.status : null])) };
    },
  };
}
