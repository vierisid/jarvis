import { requestHumanInput } from './human-input';
import { machinePinForRun } from '../db/repos/binding-pins';
import {createSubflowService,returnSubflowResult} from './subflow-service';
import { MEETING_ACCOUNTS, meetingSetup, meetingSetupMatches, parseMeetingGuard, prepareMeetingBriefs, meetingStillCurrent, meetingNotificationKey, meetingTransport, type MeetingSetup } from './meeting-briefs';
import { createLeadBatchService } from './batch-service';
import { createOnboardingService } from './onboarding-service';
import { createSalesFollowupsService } from './sales-service';
import { createWeeklyReportService } from './report-service';
import { createQuarterlyReportService } from './quarterly-report-service';
import { createRefundService } from './refund-service';
import { createContactImportService } from './import-service';
import type { ImportRequest } from './contact-import';
import { connectionBindings, enforceRunConnectionBinding, recordRunCredentialOutcome } from '../db/repos/binding-pins';
import { walkFlowNodes } from '../db/flow-graph';
import { isMeetingBriefsStep, MANAGED_HUBSPOT_REFUSAL, MEETING_ACCOUNT_LABELS } from '../meeting-accounts';
import { withWorkflowMemory } from '../../vault/memory-use-context';
import { documentInput, projectDocument } from './decision-document';
/**
 * Glue layer: wraps existing Jarvis adapters into the function-shape that the
 * SandboxApi service-backend slots expect. Each `/v1/jarvis/*` route takes a
 * function or object on `SandboxApiServices`; the legacy adapters expose
 * different signatures that grew before this engine wiring landed. This
 * module lives here (not in the daemon) so the wiring is testable + reused
 * by the L gmail smoke test.
 *
 * Lives outside `adapters/` so the eventual K3 deletion of the legacy
 * adapters doesn't have to thread through this file.
 */
import { HUBSPOT_CLAIM_WAIT_MS, HubspotNotStartedError, HubspotWriteRefusedError, hubspotContactInput, isHubspotContact, upsertHubspotContact } from './hubspot-contact';
import { getConnection } from '../db/repos/app-connection';
import { claimIdentity, completeIdentity, identityCompleted, IdentityUnresolvedError, releaseIdentity } from '../db/repos/effect-identity';
import { workflowUiRead, workflowUiReview } from '../../authority/ui-intent';
import { runAsReviewed } from '../../actions/tools/reviewed-call-scope';
import { newSnapshotReadLog, withSnapshotReadLog, type SnapshotReadLog } from '../../actions/tools/snapshot-read-log';
import type { ApprovalManager } from '../../authority/approval';

import type { LLMManager } from "../../llm/manager";
import type { ToolRegistry } from "../../actions/tools/registry";
import type { ChannelDeliveryReport, ChannelService } from "../../daemon/channel-service";
import type { WebSocketService } from "../../daemon/ws-service";
import type { AgentOrchestrator } from "../../agents/orchestrator";
import type { AuthorityEngine } from "../../authority/engine";
import type { AuditTrail } from "../../authority/audit";
import type { EmergencyController } from "../../authority/emergency";
import type { RoleDefinition } from "../../roles/types";
import { JarvisLlmClient } from "../adapters/llm-client";
import { assertWorkflowUiCardCurrent, directToolAboveLevelFloor, DESKTOP_ELEMENT_ID_REFUSAL, remoteKeyPressRefusal, workflowUiCardDeadline } from './workflow-ui-tools';
import { JarvisToolRegistryAdapter, frameComputerStepResult } from "../adapters/tool-registry";
import { JarvisNotifierAdapter, type NotifierDeps } from "../adapters/notifier";
import { JarvisContextProviderAdapter } from "../adapters/context-provider";
import { LlmOnlyAgentDelegator } from "../adapters/agent-delegator";
import { DEFAULT_MAX_ITERATIONS, M7AgentDelegator, type DelegationContinuation } from "../adapters/m7-agent-delegator";
import { getChildRun } from '../db/repos/child-run';
import { delegationId, getDelegation, saveDelegation } from "../db/repos/delegation";
import { JarvisWorkflowRunnerAdapter, WorkflowRunnerError } from "../adapters/workflow-runner";
import { childTurnedOffOutcome, isTurnedOff } from "../db/repos/flow-turn-off";
import type { LlmChatFn, LlmChatRequest, LlmChatResponse } from "../sandbox-api/routes/jarvis-llm";
import type { SystemPromptParts } from "../../roles/prompt-builder";
import type { ToolsInvokeFn } from "../sandbox-api/routes/jarvis-tools";
import type { PieceAuthorizeFn } from "../sandbox-api/routes/jarvis-pieces";
import { DeliveryFailedError, type NotifyFn } from "../sandbox-api/routes/jarvis-notify";
import type { ContextReply, JarvisContextProvider } from "../sandbox-api/routes/jarvis-context";
import type { AgentDelegateFn } from "../sandbox-api/routes/jarvis-agent";
import type { EventsPollFn } from "../sandbox-api/routes/jarvis-events";
import type { WorkflowsStartFn } from "../sandbox-api/routes/jarvis-workflows";
import type { SandboxApiServices } from "../sandbox-api/server";
import { managedConnectionMisuse, managedSourceFor, type CredentialResolver } from "../credentials/adapter";
import { ConnectionCredentialError, OAUTH2_TYPES } from "../credentials/pasted-oauth2";
import { WorkflowEventBuffer } from "./event-buffer";
import { cancellableWorkflowService } from "./cancellation";
import { closeEffectApproval, WorkflowEffectBoundary, workflowEffectId, type WorkflowAuthorityDependencies } from './effect-boundary';
import { getWorkflowEffect, saveWorkflowEffect, listWorkflowEffects, type WorkflowEffect } from '../db/repos/workflow-effect';
import { resolveToolGate, severityRank } from '../../authority/tool-action-map';
import { assertDesktopAllowed } from '../../actions/tools/desktop-guard.ts';
import { GATED_TOOL_NAMES, OPAQUE_TOOL_NAMES, refusedEffectCategory, surfaceBoundRefusal, toolEffectCapability, uiCallComputer } from './effect-capabilities';
import { desktopSubjectFromRun, uiCardRefusal, uiCardSentence, workflowUiCard, type UiCard } from './ui-card';
import { ActionOutcomeError, type ActionOutcome } from '../../actions/action-outcome';
import { governedPieceToolDefinition, governedPieceToolName, isWellFormedPieceActionName, reprojectPieceInput,
  resolveGovernedPieceAction, sanitizePieceInput, tracksPieceCompletion, PIECE_ABOVE_LEVEL_ASKS, PIECE_ABOVE_LEVEL_FLOOR,
  HTTP_PIECE, httpReadHostListed } from './piece-effects';
import { assertRecipientFactsCurrent, recipientAddresses, recipientFactPins, type FactPin } from './fact-bindings';
import { captureProviderBinding, providerBindingHolds } from './provider-reconciliation';
import { recordPieceCompletion, recordPieceNotSent } from './piece-completion';
import { defangPieceProjection } from './piece-effect-receipt';
import { getFlowInProject } from '../db/repos/flow';
import { getFlowVersion, getLatestDraft } from '../db/repos/flow-version';
import { canonicalJson, digest, resolveEffectContext, pinnedStepParams, stepTargetIsLiteral, type WorkflowEffectContext } from './effect-context';
import { isCommunityAction } from './step-admission';
import { CODE_STEP_PIECE, type PieceAuthorizeRequest, type PieceAuthorizeResponse } from './piece-effect-guard';
import { holdStep, KILLED_REASON, PAUSED_REASON } from './emergency-hold';
import { getFlowRun } from '../db/repos/flow-run';
import { recordDashboardNotification } from '../../vault/dashboard-notifications';
import { getFlowReadHosts } from '../db/repos/flow-read-hosts';
import { boundedReceiptText } from '../../roles/untrusted';
import { evaluateLlmOutput } from './llm-output-contract';
import { assertUiComputerPinned, withWorkflowMachineBinding } from './machine-binding';
import { getMachineScope } from '../../actions/machine-scope';
import type { SidecarCapability } from '../../sidecar/types';
import { toolReturnText } from '../../roles/untrusted.ts';
import { withoutTemplateDelivery } from '../../actions/tools/template-delivery-scope.ts';
import { outsideApprovalScope, runAsApproved } from '../../authority/approved-action-scope.ts';
import type { ActionCategory } from '../../roles/authority';
import { isOwnerOnlyNotify } from '../jarvis-pieces/types';
import { sendMayHaveArrived } from '../../comms/delivery.ts';
import { providerOutcome } from '../../failures/evidence.ts';
import { escapedLiteralForCard, forCard, withoutCardInvisibles } from '../../util/card-text.ts';
import { AGENT_TASK_MAX_CHARS, checkSpecialistId, SPECIALIST_ID_MAX_CHARS } from '../../actions/tools/agents.ts';
import { boundedApprovalLabel } from '../../authority/approval-delivery';

/** A refusal raised before anything was sent, typed as not started. The
 * boundary records an untyped error from inside an effect as uncertain, so a
 * checkpoint refusal (run stopped, approval withdrawn, Authority changed) that
 * provably came first is retyped here, keeping its own code where it has one. */
function notStartedOutcome(error: unknown): ActionOutcomeError {
  if (error instanceof ActionOutcomeError && error.outcome.effect === 'not_started') return error;
  const code = (error as { code?: unknown } | null)?.code;
  return new ActionOutcomeError({ status: 'blocked', code: typeof code === 'string' && code ? code : 'DISPATCH_BLOCKED',
    message: error instanceof Error ? error.message : String(error), effect: 'not_started' });
}

/** A notification owner only fans out to channels; its key is consumed once,
 * so a waiter that gives up loses no delivery. */
const NOTIFY_CLAIM_WAIT_MS = 2_000;

/** Claim a cross-run identity, waiting while a competing claim is still
 * dispatching. Never steals an unresolved claim: a crash can leave an
 * uncertain provider effect behind. A claim that stays unresolved stops this
 * effect before it starts, typed as not started. */
async function claimSettledIdentity(identity: string, owner: string, once: boolean, checkpoint: () => void, waitMs: number): Promise<'claimed' | 'duplicate'> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    // Nothing is claimed or sent yet: a refusal here started nothing.
    try { checkpoint(); } catch (error) { throw notStartedOutcome(error); }
    try { return claimIdentity(identity, owner, once); }
    catch (error) {
      if (!(error instanceof IdentityUnresolvedError)) throw error;
      const ownerEffect = getWorkflowEffect(error.owner);
      if (ownerEffect?.status !== 'dispatching' || Date.now() >= deadline)
        throw new ActionOutcomeError({ status: 'blocked', code: 'IDENTITY_UNRESOLVED', effect: 'not_started',
          message: ownerEffect && ownerEffect.status !== 'dispatching'
            ? `An earlier write for this identity is unresolved: effect ${error.owner} in run ${ownerEffect.runId}. Check the provider, then resolve it (manage_workflow resolve_effect, or POST /api/workflow-runs/${ownerEffect.runId}/effects/${error.owner}/identity): mark_done if it happened, release if it did not.`
            : error.message });
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

export interface BuildServiceBackendsOptions extends WorkflowAuthorityDependencies {
  /** Test transport injection; production always uses the fixed HubSpot host. */
  hubspotFetch?: typeof fetch;
  meetingFetch?: typeof fetch;
  meetingNow?: () => number;
  reportFetch?: typeof fetch;
  reportNow?: () => number;
  refundFetch?: typeof fetch;
  refundNow?: () => number;
  importRequest?: ImportRequest;
  importNow?: () => number;
  importBudget?: () => import('./import-service').ImportCallBudget;
  batchFetch?: typeof fetch;
  subflowNow?: () => number;
  batchNow?: () => number;
  onboardingFetch?: typeof fetch;
  salesFetch?: typeof fetch;
  salesNow?: () => number;
  /** F-14 enrollment is explicitly enabled only with the F-12 queue. */
  decisionDocumentsEnabled?: boolean;
  credentialResolver: CredentialResolver;
  llmManager: LLMManager;
  toolRegistry?: ToolRegistry;
  channelService: ChannelService;
  wsService: WebSocketService;
  /**
   * Optional desktop-notification sender. Receives `(title, body)` and resolves
   * whether the desktop showed it, or `'unknown'` when the sender timed out and
   * the toast may already be up. The daemon passes the desktop receipt.
   */
  sendDesktop?: (title: string, body: string) => Promise<boolean | 'unknown'>;
  /**
   * Where a dashboard notification is saved; defaults to the vault's table.
   * Fixtures that must not write the owner's list pass their own, and one that
   * throws is a notification that was not stored.
   */
  recordDashboardNotification?: typeof recordDashboardNotification;
  /** Recent-events buffer for `jarvis-trigger:on_event` polling. */
  eventBuffer: WorkflowEventBuffer;
  /**
   * URL prefix used to mint resumeUrl values for waitpoints. Should be a
   * publicly reachable URL of the daemon. Default: empty string -- the
   * waitpoint route will mint relative URLs that callers must concatenate.
   */
  resumeUrlPrefix?: string;
  /**
   * M7 sub-agent dependencies. When all of these are supplied, `jarvis-agent.delegate`
   * runs the full LLM + tool loop via `runSubAgent`. When any are missing,
   * the backend falls back to the single-shot `LlmOnlyAgentDelegator`.
   *
   * The fallback exists so:
   *   - tests that don't care about agent delegation can omit the wiring,
   *   - the workflow runtime stays usable in early-boot windows before the
   *     daemon's agent-service has finished initializing.
   *
   * Production wiring supplies orchestrator, specialists, Authority, audit and
   * emergency components. Direct effects fail closed without governance;
   * delegated execution falls back to an LLM-only response with no tool loop.
   */
  agentOrchestrator?: AgentOrchestrator;
  agentSpecialists?: Map<string, RoleDefinition>;
  /**
   * Builds the tool registry a delegated sub-agent may call, from its role's
   * allowed categories. Production leaves this unset and gets the builtin
   * tools; tests supply synthetic ones so an approved call has no real effect.
   */
  agentScopedRegistry?: (allowedCategories: string[]) => ToolRegistry;
  authorityEngine?: AuthorityEngine;
  auditTrail?: AuditTrail;
  emergencyController?: EmergencyController;
  /**
   * Optional callback that builds the Jarvis-flavoured system prompt for
   * a workflow LLM call. When set, the `jarvis-ask` piece will pass this
   * prompt to the LLM so the model knows it's Jarvis (role, personality,
   * vault context). Skipped when the piece's `system` field is set --
   * that's the user's explicit override.
   *
   * Returned split at the prompt-cache boundary (static role prompt vs
   * per-call context) so the provider can cache the static prefix across
   * workflow LLM calls.
   *
   * Production wiring passes `AgentService.buildFullSystemPromptParts`.
   */
  buildJarvisSystemPrompt?: (userMessage: string) => SystemPromptParts;
  /**
   * Why nothing on this Jarvis could answer a new workflow input or approval
   * request, or null (#1266): they are answered in Needs you, which is the
   * Brief decisions feature. Asked when a step would create one. Absent: asking
   * is allowed, as before.
   */
  humanInputUnavailable?: () => string | null;
}

/**
 * The role a workflow delegation runs when its step names none. Passed to the
 * delegator explicitly for a delegation whose card named it, so the card and
 * `M7AgentDelegator`'s own default cannot drift apart.
 */
const WORKFLOW_DEFAULT_ROLE = 'workflow-default';
/** A flow name on a card: the 512 the HTTP routes cap a `displayName` at, as `effect-boundary.ts` labels one. */
const START_CARD_NAME_MAX_CHARS = 512;

/**
 * The card sentence for a workflow delegation (#1040): which specialist, and
 * the goal it will be given. Before, the card read only "Workflow delegate",
 * although the role and the goal can be wired from trigger data, so a person
 * approved without seeing either. `delegateTaskGate`'s wording and budgets:
 * the role short, in the middle; the goal quoted with its quotes escaped and
 * last, so nothing after it can be forged. `workflowDelegateCardRefusal`
 * keeps any value this would cut or could not display off a card.
 */
export function workflowDelegateIntent(args: Record<string, unknown>): string {
  const role = typeof args.role === 'string' ? args.role : WORKFLOW_DEFAULT_ROLE;
  // A step may ask for up to 200 iterations, each an LLM call: a cost the
  // person approving should see, stated whether the step set it or the
  // delegator's default applies. The route holds it to a positive integer.
  const n = typeof args.maxIterations === 'number' ? args.maxIterations : DEFAULT_MAX_ITERATIONS;
  const steps = `, for at most ${n} iteration${n === 1 ? '' : 's'},`;
  return `Delegate to a ${forCard(role, SPECIALIST_ID_MAX_CHARS) || 'specialist'} specialist${steps} the goal ${JSON.stringify(forCard(args.goal, AGENT_TASK_MAX_CHARS))}`;
}

/**
 * Why a delegation's card could not show it as it would run (#1040), the
 * bounds `delegate_task` holds its own card to: a role that is not a
 * specialist (a card naming one would start nothing, and trigger data could
 * use the role to write words into the sentence), a role id the card cannot
 * show exactly (#1019), or a goal longer than the card shows in full once the
 * characters a card cannot display are gone (they are dropped from the goal
 * an approved delegation runs, below). Asked only when a card is needed, so a
 * delegation nobody has to approve runs as it did.
 */
function workflowDelegateCardRefusal(args: Record<string, unknown>, specialists: ReadonlyMap<string, unknown>): string | null {
  const role = typeof args.role === 'string' ? args.role : WORKFLOW_DEFAULT_ROLE;
  if (!specialists.has(role)) {
    return `Unknown specialist ${escapedLiteralForCard(role.slice(0, SPECIALIST_ID_MAX_CHARS + 20))}, so no card is raised for it. Available: ${[...specialists.keys()].join(', ')}`;
  }
  try { checkSpecialistId(role); }
  catch (error) { return error instanceof Error ? error.message : String(error); }
  const goal = withoutCardInvisibles(String(args.goal ?? ''));
  if (goal.length > AGENT_TASK_MAX_CHARS) {
    return `The goal is ${goal.length} characters; the limit is ${AGENT_TASK_MAX_CHARS}, so the approval card can show all of it. Shorten it.`;
  }
  return null;
}

/**
 * The card sentence for a step that starts a workflow (#1040): the target's
 * id and its name, the name one line, bounded, quoted and last. Before, the
 * card read only "Workflow start". The id is the flow's own (the lookup that
 * pinned the version found it in the caller's project); the name is the
 * pinned version's.
 */
function workflowStartIntent(flowId: string, name: string, waitForCompletion: boolean, input: string | null): string {
  const head = `${waitForCompletion ? 'Start and wait for' : 'Start'} the workflow ${forCard(flowId, 128)} named `;
  return head + startCardName(name, START_CARD_SENTENCE_MAX_CHARS - head.length - START_INPUT_SHOWN_MAX_CHARS) + (input === null ? '' : input);
}

/**
 * Most characters a start card's sentence may take: the Needs you title
 * (`brief/decisions.ts`) shows the first 1000 of an approval's intent and
 * cuts the rest without a mark, so a sentence never runs past it.
 */
const START_CARD_SENTENCE_MAX_CHARS = 1000;
/** `, with the input ` and the most input a card shows (`workflowStartCardRefusal`). */
const START_INPUT_SHOWN_MAX_CHARS = ', with the input '.length + AGENT_TASK_MAX_CHARS;

/**
 * The flow's name as a start card shows it, quoted, in at most `budget`
 * characters: cut with a visible "..." (`boundedApprovalLabel`) when the whole
 * name does not fit beside the most input the card can show, since the flow
 * id before it still says which flow starts. Measured as shown, so JSON's
 * escaping of quotes and backslashes and the bidi isolates count.
 */
function startCardName(name: string, budget: number): string {
  // A name shorter than the cap is not cut by the label above it, so start there.
  let max = Math.min(START_CARD_NAME_MAX_CHARS, Math.max(1, name.length));
  for (;;) {
    const shown = isolateJsonStrings(JSON.stringify(boundedApprovalLabel(name, max)));
    if (shown.length <= budget || max <= 1) return shown;
    max = Math.max(1, max - Math.max(1, Math.ceil((shown.length - budget) / 2)));
  }
}

/** FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE (Unicode bidi isolates). */
const FSI = '\u2068';
const PDI = '\u2069';
/** A JSON string token: its quotes and everything between, escapes included. */
const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;

/** Any character outside ASCII: the only kind that can be right-to-left text. */
const NON_ASCII = /[^\x00-\x7f]/;

/**
 * `json` with the text of each string in it (keys and values) that holds a
 * character outside ASCII wrapped in a bidi isolate, inside its quotes.
 * Right-to-left text in a value otherwise reorders the punctuation around it
 * on the dashboard: in `{"<rtl key>":"<rtl value>"}` the colon between two
 * right-to-left runs takes their direction, and the pair reads with key and
 * value swapped. An isolate keeps such a string to itself, so the card reads
 * in the order it is written, in any script, without escaping anyone's
 * language. A string of ASCII alone cannot hold right-to-left text, so it is
 * left as it was and an ASCII card is unchanged. Only for text whose own
 * format characters are already gone or escaped (`START_INPUT_HIDDEN`, a
 * label's reduction), so a string cannot close or open an isolate of its own.
 * The isolates are display only: what the child receives is the payload.
 * They are shown characters for the card's length budget, so they count.
 */
function isolateJsonStrings(json: string): string {
  return json.replace(JSON_STRING, (token) => NON_ASCII.test(token) ? `"${FSI}${token.slice(1, -1)}${PDI}"` : token);
}

/**
 * What a start card cannot show as written (#1152): format and invisible
 * characters (the set `forCard` drops from every card, `util/card-text.ts`),
 * C1 controls and DEL, and any whitespace but a plain space (a no-break space
 * or a line separator reads as a space and is not one). JSON already escapes
 * C0 controls, line breaks and tabs.
 */
const START_INPUT_HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}\x7f-\x9f]|[^\S ]/gu;
const unitEscapes = (character: string) => [...Array(character.length).keys()]
  .map((i) => `\\u${character.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`).join('');

/**
 * The input a started workflow is given, as a start card shows it (#1152), or
 * null when the step passes none. One line of JSON with every character a
 * card cannot show as written escaped, so the card holds exactly what the
 * child receives: nothing dropped, collapsed or cut, and no string inside it
 * can close its own quotes. Other text, Cyrillic or CJK say, is shown as it
 * is. Last in the sentence, so nothing after it can be forged. A payload is
 * often trigger data, which is why the person approving has to see it.
 */
function startInputJson(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 0) return null;
  return canonicalJson(payload).replace(START_INPUT_HIDDEN, unitEscapes);
}
/** The input exactly as the dashboard card shows it, isolates included. */
function startInputShown(payload: unknown): string | null {
  const json = startInputJson(payload);
  return json === null ? null : isolateJsonStrings(json);
}
function startInputForCard(payload: unknown): string | null {
  const shown = startInputShown(payload);
  return shown === null ? null : `, with the input ${shown}`;
}

/** How many of a payload's field names a chat card lists before "and N more" (#1152). The card's own length budget still applies. */
export const START_CHAT_FIELD_NAMES_MAX = 10;
/** A field name a chat card shows; any other is only counted, since a key can itself be data (an address, an order id). */
const PLAIN_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/**
 * The input as a Telegram or Discord start card shows it (owner, 2026-11-06,
 * #1152): never values, which are often trigger data and land in a chat
 * history, only what the payload is. An object shows its top-level field
 * names, sorted, at most `START_CHAT_FIELD_NAMES_MAX` and then how many more;
 * a name that is not a plain identifier is only counted, never shown, so it
 * can neither forge the list nor carry data a key holds. A list or a single value
 * shows only its kind. The dashboard card shows the whole payload. A card
 * this makes too long to show whole is deny-only in chat, with a pointer to
 * the dashboard (`approvalChannelCard`).
 */
function startInputForChat(payload: unknown): string | null {
  if (startInputJson(payload) === null) return null;
  if (Array.isArray(payload)) return `, passing a list of ${payload.length} item${payload.length === 1 ? '' : 's'}`;
  if (typeof payload === 'object') {
    const keys = Object.keys(payload as object).sort();
    const plain = keys.filter((name) => PLAIN_FIELD_NAME.test(name));
    const shown = plain.slice(0, START_CHAT_FIELD_NAMES_MAX);
    const more = keys.length - shown.length;
    const list = shown.length ? `the fields {${shown.join(', ')}}${more > 0 ? ` and ${more} more` : ''}` : `${keys.length} field${keys.length === 1 ? '' : 's'}`;
    return `, passing ${list} (open the dashboard to see ${shown.length ? 'their values' : 'them'})`;
  }
  const kind = typeof payload === 'string' ? 'a text value' : typeof payload === 'number' ? 'a number'
    : typeof payload === 'boolean' ? 'a true/false value' : 'a value';
  return `, passing ${kind} (open the dashboard to see it)`;
}

/** A start card's chat sentence: as `workflowStartIntentOf`, with the input described, never shown (#1152). */
export function workflowStartChannelIntentOf(args: Record<string, unknown>): string {
  const pinned = args.pinned as { versionId?: unknown } | undefined;
  const name = typeof pinned?.versionId === 'string' ? getFlowVersion(pinned.versionId)?.displayName ?? '' : '';
  return workflowStartIntent(String(args.flowId ?? ''), name, args.waitForCompletion === true, startInputForChat(args.payload));
}

/**
 * Why a start card could not show its input in full (#1152), or null: past
 * the budget a delegation's goal is held to (`AGENT_TASK_MAX_CHARS`), the one
 * other trigger-fed value a start-of-work card shows whole. Measured on the
 * text the card shows. Asked only when a card is needed, so a start nobody
 * has to approve runs as it did.
 */
function workflowStartCardRefusal(args: Record<string, unknown>): string | null {
  const input = startInputShown(args.payload);
  return input !== null && input.length > AGENT_TASK_MAX_CHARS
    ? `The input passed to the workflow is ${input.length} characters as the approval card shows it; the limit is ${AGENT_TASK_MAX_CHARS}, so the card can show all of it. Pass fewer or shorter fields, or let the started workflow read the rest itself.`
    : null;
}

/** A start card's sentence from its frozen arguments: the flow, the version it pinned and the input it passes. */
export function workflowStartIntentOf(args: Record<string, unknown>): string {
  const pinned = args.pinned as { versionId?: unknown } | undefined;
  const name = typeof pinned?.versionId === 'string' ? getFlowVersion(pinned.versionId)?.displayName ?? '' : '';
  return workflowStartIntent(String(args.flowId ?? ''), name, args.waitForCompletion === true, startInputForCard(args.payload));
}

export function buildSandboxServiceBackends(
  opts: BuildServiceBackendsOptions,
): SandboxApiServices {
  const llmClient = new JarvisLlmClient(opts.llmManager);
  const effects = new WorkflowEffectBoundary(opts);
  // Browser reads and review capture must share a reader, independent of the
  // adapter's playbook suppression. Keep live generations only, never restore
  // them from durable receipts. A restart/eviction requires a fresh read.
  // Bounded per backend so completed or abandoned runs cannot leak logs.
  const toolSnapshotReads = new Map<string, SnapshotReadLog>();
  const withToolSnapshots = <T>(runId: string, execute: () => T): T => {
    const log = toolSnapshotReads.get(runId) ?? newSnapshotReadLog({ isolatedReader: `workflow-direct:${runId}` });
    toolSnapshotReads.delete(runId);
    toolSnapshotReads.set(runId, log);
    while (toolSnapshotReads.size > 256) toolSnapshotReads.delete(toolSnapshotReads.keys().next().value!);
    return withSnapshotReadLog(log, execute);
  };
  const callLlm = async (req: LlmChatRequest): Promise<LlmChatResponse> => {
    // System-prompt composition:
    //   - overrideSystem=true       : use `req.system` only. Jarvis
    //                                 context (role, personality, vault
    //                                 knowledge) is dropped. Picked when
    //                                 the user wants generic LLM behaviour
    //                                 (text transforms, summarisation of
    //                                 inputs that shouldn't be coloured
    //                                 by Jarvis's identity).
    //   - `req.system` set, default : Jarvis prompt + "\n\n" + req.system.
    //                                 Lets the user steer the reply (e.g.
    //                                 "respond in JSON") while keeping the
    //                                 Jarvis identity.
    //   - no `req.system`           : Jarvis prompt alone. Default for
    //                                 plain "ask Jarvis" steps.
    //   - no prompt builder wired   : whatever the piece sent (or nothing).
    //                                 Defensive fallback for tests / pre-
    //                                 agent-service bootstrap windows.
    const jarvisParts = !req.overrideSystem && opts.buildJarvisSystemPrompt
      ? opts.buildJarvisSystemPrompt(req.prompt)
      : undefined;
    let system: string | undefined;
    let systemParts: { static: string; dynamic?: string } | undefined;
    if (req.overrideSystem) {
      system = req.system;
    } else if (jarvisParts) {
      // Static Jarvis prefix stays cacheable; per-call context and the
      // piece's steering prompt ride on the dynamic half. Rendered text is
      // identical to the old `jarvis + '\n\n' + req.system` join.
      const dynamic = [jarvisParts.dynamic, req.system].filter(Boolean).join('\n\n');
      systemParts = { static: jarvisParts.static, ...(dynamic ? { dynamic } : {}) };
    } else {
      system = req.system;
    }
    const reply = await llmClient.chat({
      prompt: req.prompt,
      ...(system !== undefined ? { system } : {}),
      ...(systemParts !== undefined ? { systemParts } : {}),
    });
    // The provider has answered, so the contract check qualifies a completed
    // call rather than blocking one: `parsed` exists only when the reply met
    // the request, and the outcome names the contract that failed otherwise.
    const evaluated = evaluateLlmOutput({ text: reply.text, ...(req.parseJson ? { parseJson: true } : {}),
      ...(req.outputSchema ? { outputSchema: req.outputSchema } : {}) });
    return 'parsed' in evaluated ? { text: reply.text, parsed: evaluated.parsed, outcome: evaluated.outcome }
      : { text: reply.text, outcome: evaluated.outcome };
  };
  const llmChat: LlmChatFn = async (req, ctx) => {
    // requireSuccess controls how the caller handles the receipt, not what
    // leaves the device. Keeping it out of the effect identity lets an
    // approval granted to an older piece resume once the upgraded piece
    // starts sending the default explicitly.
    const { requireSuccess: _handled, ...effectRequest } = req;
    const reply = await effects.invoke({ context: ctx, piece: '@jarvispieces/piece-jarvis-ask', action: 'ask',
      route: 'llm', toolName: 'workflow_ask', category: 'read_data', toolCategory: 'llm',
      request: { ...effectRequest },
      // The prompt is the payload that leaves the device, so it is what gets
      // frozen and reviewed -- not the daemon-composed system prompt above.
      prepare: () => ({ arguments: { ...effectRequest }, target: { destination: 'llm-provider', overrideSystem: req.overrideSystem === true } }),
      execute: async (args, checkpoint) => {
        checkpoint();
        const run = getFlowRun(ctx.runId);
        if (!run) throw new Error('Workflow run unavailable');
        try {
          return await withWorkflowMemory(run.id, run.flowId, digest([ctx.stepName, ctx.executionPath]),
            () => callLlm(args as unknown as LlmChatRequest));
        } catch (error) {
          // Q-19: keep the provider's typed code on the record, so a failed run
          // says what the provider said instead of "may have taken effect".
          const outcome = providerOutcome(error);
          throw outcome ? new ActionOutcomeError(outcome) : error;
        }
      },
    });
    return reply.approval ? { text: '', approval: reply.approval } : reply.result as LlmChatResponse;
  };

  const toolAdapter = opts.toolRegistry
    ? new JarvisToolRegistryAdapter(opts.toolRegistry)
    : null;
  const toolsInvoke: ToolsInvokeFn | undefined = toolAdapter
    ? async (req, ctx) => {
        // The step's own tool first (#1152): a templated step is refused typed,
        // and a call for another tool is refused before any lookup names it.
        resolveEffectContext(ctx, '@jarvispieces/piece-jarvis-tool', 'invoke', { toolName: req.toolName });
        if (!toolAdapter.has(req.toolName)) {
          throw new Error(`tool not found: ${req.toolName}`);
        }
        const tool = opts.toolRegistry!.get(req.toolName)!;
        // A reviewed UI call is held to the params its step states (#1314):
        // the step-name header alone would let any holder of the run's token
        // raise this step's card with params of its own. The computer is never
        // run data's to choose.
        // A forged call is a tamper signal, so the refusal is audited (#1314 review).
        let fromRunData = new Set<string>();
        // A skill replays recorded clicks and typing, so it is a computer action too (#1314 review).
        const uiStep = workflowUiReview(tool, req.toolName, req.params);
        const computerAction = uiStep || tool.name === 'run_skill';
        try { if (uiStep) fromRunData = pinnedStepParams(ctx, req.params, ['target']); }
        catch (error) {
          effects.auditRefusal({ context: ctx, toolName: tool.name, category: refusedEffectCategory(tool) });
          throw error;
        }
        // desktop.enabled: false (#905). Typed and not started, before any
        // effect record or approval card exists for the step; audited like a
        // capability refusal.
        try { assertDesktopAllowed(tool, req.params); }
        catch (error) {
          // Labelled by the switch that refused it (#1314 review).
          const which = error instanceof ActionOutcomeError && error.outcome.code === 'SCREEN_CAPTURE_DISABLED' ? 'screen_capture_disabled' : 'desktop_disabled';
          effects.auditRefusal({ context: ctx, toolName: `${which}(${tool.name})`, category: refusedEffectCategory(tool) });
          throw error;
        }
        const capability = (() => {
          try { return toolEffectCapability(tool, req.params); }
          catch (error) {
            // Refusing a capability is a governance decision, so it is audited
            // even though no durable effect record exists for it yet.
            effects.auditRefusal({ context: ctx, toolName: tool.name, category: refusedEffectCategory(tool) });
            throw error;
          }
        })();
        const gate = resolveToolGate(tool, req.toolName, req.params);
        const uiReview = workflowUiReview(tool, req.toolName, req.params);
        const remoteKey = !uiReview ? null : remoteKeyPressRefusal(tool.name, req.params, machinePinForRun(ctx.runId))
          ?? (tool.name === 'desktop_click' && !fromRunData.has('element_id') ? DESKTOP_ELEMENT_ID_REFUSAL : null);
        if (remoteKey) {
          effects.auditRefusal({ context: ctx, toolName: tool.name, category: refusedEffectCategory(tool) });
          throw new ActionOutcomeError({ status: 'blocked', code: 'WORKFLOW_TOOL_UNSUPPORTED', effect: 'not_started', message: `WORKFLOW_TOOL_UNSUPPORTED: ${remoteKey}` });
        }
        let uiExecution: ReturnType<ApprovalManager['getUiExecution']> = null;
        let dispatched = false;
        // The card shows every frozen value, where each came from, the
        // computer and the screen (#1314), or the step is refused unseen.
        const subject = uiReview ? tool.reviewSubject?.(req.params) ?? {} : {};
        let uiCard: UiCard | null = null;
        // A computer that cannot be resolved is refused, typed and recorded,
        // by `prepare` below; no card is raised without one.
        // Written in the step, never resolved from run data: a UI step's params
        // are held to the graph above; a skill's target is read from the graph.
        const literalTarget = typeof req.params.target === 'string' && req.params.target.trim() !== ''
          && (uiStep || stepTargetIsLiteral(ctx, req.params.target));
        if (uiReview) {
          try {
            // Nothing resolves a computer before the pin check (#1314 review): a refused call binds none.
            assertUiComputerPinned(ctx.runId, literalTarget);
            uiCard = workflowUiCard(tool.name, req.params, {
              computer: uiCallComputer(tool.name, req.params.target).name,
              source: name => fromRunData.has(name) ? 'run_data' : 'workflow', declared: Object.keys(tool.parameters ?? {}),
              page: subject.origin, element: subject.element, ...desktopSubjectFromRun(listWorkflowEffects(ctx.runId), tool.name, req.params) });
          } catch { uiCard = null; }
        }
        const reply = await effects.invoke({ context: ctx, piece: '@jarvispieces/piece-jarvis-tool', action: 'invoke',
          // The tool the step names, not only the step (#1152).
          pinnedInput: { toolName: req.toolName },
          ...(gate.confirm === 'always' ? { confirmation: { confirm: 'always' as const, intent: uiCard ? uiCardSentence(uiCard) : gate.intent ?? 'Review this UI effect' } } : {}),
          ...(uiReview ? { reviewRegistry: opts.toolRegistry!, reviewSubject: subject, ...(uiCard ? { uiCard } : {}),
            cardRefusal: () => uiCard ? uiCardRefusal(uiCard) : 'The approval card could not name the computer this action would run on.',
            approvalExpiresAt: workflowUiCardDeadline(tool.name) } : {}),
          // As at the chat gate: a gated call over the workflow's level asks
          // instead of failing the step.
          ...(gate.confirm ? { aboveLevelFloor: directToolAboveLevelFloor(tool, req.params, gate) } : {}),
          route: 'tool', toolName: tool.name, category: capability.category, categories: capability.categories, toolCategory: tool.category,
          // Spelled out rather than spread: the request is what the effect's
          // identity digest is taken over, so only the two fields that decide
          // WHAT is dispatched belong in it. A reply-handling flag added to
          // the route's body must never invalidate a pending approval.
          request: { toolName: req.toolName, params: req.params }, prepare: () => {
            // On a computer a person chose (#1314 M2): the pin, or the step's own written target.
            if (computerAction) assertUiComputerPinned(ctx.runId, literalTarget);
            const args = capability.prepareArguments(req.params);
            return { arguments: args, target: capability.target(args) };
          },
          validateTarget: (args, target) => {
            if (digest(capability.target(args)) !== digest(target)) throw new Error('Workflow execution target changed after review; dispatch blocked');
            if (target.machineBinding) getMachineScope()?.assertDispatch(target.sidecarId as string | null, target.capability as SidecarCapability);
            if (uiReview && !dispatched) {
              const effect = getWorkflowEffect(workflowEffectId(ctx.runId, ctx.stepName!, ctx.executionPath ?? [], 'tool'));
              const approval = effect?.approvalId ? opts.approvalManager?.getRequest(effect.approvalId) : null;
              assertWorkflowUiCardCurrent(approval);
              uiExecution = approval ? opts.approvalManager?.getUiExecution(approval) ?? null : null;
              if (!uiExecution) throw new ActionOutcomeError({ status: 'blocked', code: 'WORKFLOW_UI_REVIEW_STALE', effect: 'not_started',
                message: 'The reviewed app or browser session changed, or Jarvis restarted. Start a new run and review the current screen.' });
            }
          },
          execute: async (args, checkpoint) => {
            checkpoint(); dispatched = true;
            return uiReview ? runAsReviewed(uiExecution!.reviewed,
              () => new JarvisToolRegistryAdapter(uiExecution!.registry).execute(req.toolName, args))
              : toolAdapter.execute(req.toolName, args);
          } });
        // Computer reads and navigation reach the flow framed (#1314), never as raw page or window text.
        const computer = /^(browser|desktop)_/.test(tool.name);
        // The page a navigate landed on is the page's to choose (a redirect,
        // pushState), so its URL in the receipt is framed too (#1314 review).
        if (reply.approval) return { result: null, toolName: req.toolName, approval: reply.approval };
        const verification = reply.outcome?.status === 'succeeded' ? reply.outcome.verification : undefined;
        const outcome: ActionOutcome | undefined = computer && verification?.status === 'verified' && verification.postcondition === 'page_observed'
          ? { status: 'succeeded', verification: { ...verification, pageUrl: String(frameComputerStepResult(tool.name, tool.category, verification.pageUrl)) } }
          : reply.outcome;
        return { result: computer ? frameComputerStepResult(tool.name, tool.category, reply.result) : reply.result,
          toolName: req.toolName, ...(outcome ? { outcome } : {}) };
      }
    : undefined;

  const notifierDeps: NotifierDeps = {
    broadcastToDashboard: (text, priority, storedId) =>
      opts.wsService.broadcastNotificationToDashboard(text, priority, storedId),
    // Real per-channel routing: tryBroadcastToChannels iterates the requested
    // names, dispatches each to its adapter, and reports delivered/failed
    // independently. A flow that says "telegram" only goes to telegram (with
    // a clear error when the adapter isn't connected or no recipient is
    // known yet). Replaces the previous broadcastToAll fan-out which sent
    // every notification to every connected channel.
    broadcastToChannels: (channels, text) =>
      opts.channelService.tryBroadcastToChannels(channels, text),
    // Voice channel = TTS over the same WS path used by awareness
    // suggestions. Nothing is spoken when no client is connected or no TTS
    // provider is configured, and then it reports failed, not delivered.
    sendVoice: async (text) => (await opts.wsService.broadcastProactiveVoice(text)) > 0,
    // Drives `auto`-channel expansion so unconfigured external channels
    // don't surface as failures on every notification. Explicit
    // `["telegram"]` still bypasses this and attempts delivery either way.
    getConnectedExternalChannels: () => {
      const status = opts.channelService.getChannelStatus();
      const live = new Set<string>();
      for (const [name, connected] of Object.entries(status)) {
        if (connected) live.add(name);
      }
      return live;
    },
    ...(opts.sendDesktop ? { sendDesktop: opts.sendDesktop } : {}),
  };
  /**
   * The fixed read transport for one meeting step. `providers` limits which
   * saved accounts it resolves, refreshes and pin-checks: the freshness
   * recheck before delivery reads Calendar only.
   */
  const meetingRequest = async (setup: MeetingSetup, ctx: WorkflowEffectContext, checkpoint: () => void,
    providers: ReadonlyArray<'calendar'|'gmail'|'hubspot'> = ['calendar','gmail','hubspot']) => {
    const run = getFlowRun(ctx.runId);
    const version = run && getFlowVersion(run.flowVersionId);
    const step = version && walkFlowNodes(version.trigger).find(node =>
      isMeetingBriefsStep(node.type, node.settings) && meetingSetupMatches(node.settings?.input as any ?? {}, setup));
    if (!version || !step) throw Error('Meeting configuration must match a saved meeting preparation step');
    const fields = (Object.keys(MEETING_ACCOUNTS) as Array<keyof typeof MEETING_ACCOUNTS>)
      .filter(field => providers.includes(field.replace('Connection','') as 'calendar'));
    const tokens = {} as Record<'calendar'|'gmail'|'hubspot',string>;
    for (const field of fields) {
      const pieceName = MEETING_ACCOUNTS[field], externalId = setup[field];
      if (!connectionBindings(version.trigger).has(externalId)) throw Error('Meeting account is not bound to this workflow');
      // The readiness rule, before the binding is checked or anything is
      // resolved: a managed connection only by the meeting exemption
      // (jarvis:google for Calendar and Gmail), so a refused id writes nothing.
      if (externalId.startsWith('jarvis:')) {
        if (field === 'hubspotConnection') throw Error(MANAGED_HUBSPOT_REFUSAL);
        const source = managedSourceFor(opts.credentialResolver.list(), externalId);
        const misuse = source ? managedConnectionMisuse(source, pieceName, `settings.input.${field}`, step.settings, step.type) : 'Managed connection source is unavailable';
        if (misuse) throw Error(misuse);
      }
      const refusal = enforceRunConnectionBinding(ctx.runId, ctx.projectId, externalId, opts.credentialResolver);
      if (refusal) throw Error(refusal);
      let resolved = await opts.credentialResolver.resolve({projectId:ctx.projectId,pieceName,externalId});
      if (resolved?.pieceName && resolved.pieceName !== pieceName) throw Error('Meeting account belongs to a different provider');
      if (!resolved || resolved.type !== 'OAUTH2' || resolved.status && resolved.status !== 'ACTIVE')
        throw Error('Connect the selected meeting account securely before running');
      // A stored OAuth2 token is refreshed when it is about to expire, only
      // after the run's binding check passed (as the engine's connection route does).
      try { resolved = await opts.credentialResolver.fresh(resolved); }
      catch (error) {
        if (!(error instanceof ConnectionCredentialError)) throw error;
        // Typed on the run's binding, as the engine's connection route records it, for the failure card.
        recordRunCredentialOutcome(ctx.runId, externalId, { code: error.code, message: error.message });
        // Only an expired or refused credential needs a person to reconnect; the others pass.
        const account = `the selected ${MEETING_ACCOUNT_LABELS[field]} account (${externalId})`;
        throw Error(error.code === 'CONNECTION_EXPIRED' ? `Reconnect ${account}: ${error.message}`
          : error.code === 'CONNECTION_REFRESH_UNREACHABLE' ? `Nothing was read: Jarvis could not refresh ${account} just now, which is usually temporary. Start a new run later. ${error.message}`
          : `Nothing was read: ${account} changed while Jarvis refreshed it. Start a new run. ${error.message}`);
      }
      if (resolved.stored && OAUTH2_TYPES.has(resolved.type)) recordRunCredentialOutcome(ctx.runId, externalId, null);
      if (typeof resolved.value.access_token !== 'string') throw Error('Connect the selected meeting account securely before running');
      tokens[field.replace('Connection','') as keyof typeof tokens] = resolved.value.access_token;
    }
    return meetingTransport(tokens, () => {
      checkpoint();
      for (const field of fields) {
        const refusal = enforceRunConnectionBinding(ctx.runId,ctx.projectId,setup[field],opts.credentialResolver);
        if (refusal) throw Error(refusal);
      }
    }, opts.meetingFetch);
  };
  const meetingBriefs: NonNullable<SandboxApiServices['meetingBriefs']> = async (input, ctx) => {
    const setup = meetingSetup(input);
    const reply = await effects.invoke({context:ctx,piece:'@jarvispieces/piece-jarvis-context',action:'meeting_briefs',
      route:'meeting-briefs',toolName:'workflow_meeting_briefs',category:'read_data',toolCategory:'context',request:{...setup},
      prepare:()=>({arguments:{...setup},target:{calendar:setup.calendarId,accounts:Object.keys(MEETING_ACCOUNTS).map(k=>setup[k as keyof typeof MEETING_ACCOUNTS])}}),
      execute:async(args,checkpoint)=>prepareMeetingBriefs(meetingSetup(args),await meetingRequest(meetingSetup(args),ctx,checkpoint),opts.meetingNow?.() ?? Date.now())});
    return reply.approval ? {approval:reply.approval} : reply.result;
  };
  const notify: NotifyFn = async (req, ctx) => {
    const guard = req.meetingGuard == null ? null : parseMeetingGuard(req.meetingGuard);
    if (guard) {
      if (req.channels.length !== 1 || req.channels[0] !== 'dashboard') throw Error('Meeting briefs only notify the dashboard');
      req = {...req, meetingGuard:guard, idempotencyKey:meetingNotificationKey(guard)};
    }
    // A notification that reaches only the owner's own surfaces is not a
    // message to anyone else, so it is judged as `read_data` and raises no
    // card. It is still an effect row, an audit row, and stopped by Pause,
    // Kill and cancellation. Anything that can reach another person (`auto`
    // included, which may fan out to Telegram or Discord, and `voice`, spoken
    // aloud in the room) stays `send_message`.
    const ownerOnly = isOwnerOnlyNotify(req.channels);
    const reply = await effects.invoke({ context: ctx, piece: '@jarvispieces/piece-jarvis-notify', action: 'notify',
      route: 'notify', toolName: 'workflow_notify', category: ownerOnly ? 'read_data' : 'send_message', toolCategory: 'notification', request: { ...req },
      reuseCompleted: record => {
        const key = record.arguments.idempotencyKey;
        const identity = typeof key === 'string' && key ? digest(['workflow-notify-v1', record.projectId, record.flowId, key]) : null;
        return identity && identityCompleted(identity)
          ? { result: { delivered: [], failed: [], unknown: [], deduplicated: true } } : null;
      },
      prepare: () => {
        const requested = req.channels.length ? req.channels : ['auto'];
        const channels = new Set<string>();
        for (const channel of requested) {
          if (channel !== 'auto') channels.add(channel);
          else {
            channels.add('dashboard');
            for (const external of notifierDeps.getConnectedExternalChannels!()) channels.add(external);
          }
        }
        const recipients = Object.fromEntries([...channels].map(channel => [channel,
          ['telegram', 'discord'].includes(channel) ? opts.channelService.getBroadcastRecipient(channel) : null]));
        // Q-19: a dashboard `auto` chose is skipped when nobody is watching and
        // the desktop shows it instead. Frozen with the rest, so the review
        // covers the desktop too.
        const autoDashboard = requested.includes('auto') && !requested.includes('dashboard');
        const fallback = autoDashboard && opts.sendDesktop ? { autoDashboard: true, fallback: 'desktop' } : autoDashboard ? { autoDashboard: true } : {};
        return { arguments: { ...req, channels: [...channels], recipients, ...fallback },
          target: { channels: [...channels], recipients, ...(fallback.fallback ? { fallback: fallback.fallback } : {}) } };
      },
      execute: async (args, checkpoint) => {
        // Re-read after any approval wait and immediately before claiming delivery.
        // A stale result must not consume the key, so a later poll can prepare it anew.
        if (args.meetingGuard) {
          const currentGuard = parseMeetingGuard(args.meetingGuard);
          if (!await meetingStillCurrent(currentGuard, await meetingRequest(currentGuard.setup,ctx,checkpoint,['calendar']),opts.meetingNow?.() ?? Date.now()))
            return {delivered:[],failed:[],unknown:[],skipped:'Meeting changed, cancelled, declined or outside the upcoming window'};
        }
        const notifyKey = typeof args.idempotencyKey === 'string' ? args.idempotencyKey : null;
        const currentRun = getFlowRun(ctx.runId);
        const identity = notifyKey && currentRun ? digest(['workflow-notify-v1',ctx.projectId,currentRun.flowId,notifyKey]) : null;
        const owner = workflowEffectId(ctx.runId,ctx.stepName!,ctx.executionPath ?? [],'notify');
        checkpoint();
        if (identity && await claimSettledIdentity(identity,owner,true,checkpoint,NOTIFY_CLAIM_WAIT_MS) === 'duplicate') return { delivered: [], failed: [], unknown: [], deduplicated: true };
        // The notifier reports a thrown dashboard, voice or desktop send as
        // failed, but it may have reached someone: such a key stays consumed.
        let mayHaveArrived = false;
        const sent = <T>(send: () => T): T => {
          try { const result = send(); if (result instanceof Promise) result.catch(() => { mayHaveArrived = true; }); return result; }
          catch (error) { mayHaveArrived = true; throw error; }
        };
        try {
          const recipients = args.recipients as Record<string, string | null>;
          const guardedNotifier = new JarvisNotifierAdapter({ ...notifierDeps,
            recordDashboard: (text, priority) => {
              checkpoint();
              const id = (opts.recordDashboardNotification ?? recordDashboardNotification)({ message: text, priority, workflowId: currentRun?.flowId ?? null, runId: ctx.runId }).id;
              // Saved: it is in the owner's list now. A Pause, Kill or cancel
              // that stops the live toast after this must not report it as
              // never sent, nor release the key for a later run to save again.
              mayHaveArrived = true;
              return id;
            },
            broadcastToDashboard: (text, priority, storedId) => { checkpoint(); return sent(() => opts.wsService.broadcastNotificationToDashboard(text, priority, storedId)); },
            broadcastToChannels: async (channels, text) => {
              const report: ChannelDeliveryReport = { delivered: [], failed: [], unknown: [] };
              for (const channel of channels) {
                try { checkpoint(); } catch (error) { report.failed.push({ channel, error: (error as Error).message }); continue; }
                try {
                  await opts.channelService.sendWorkflowNotification(channel, recipients[channel] ?? null, text);
                  report.delivered.push(channel);
                } catch (error) {
                  // Q-19: a send that may have arrived is reported unknown, never as not sent.
                  (sendMayHaveArrived(error) ? report.unknown : report.failed).push({ channel, error: (error as Error).message });
                }
              }
              return report;
            },
            sendVoice: async text => { checkpoint(); return (await sent(() => opts.wsService.broadcastProactiveVoice(text))) > 0; },
            ...(opts.sendDesktop ? { sendDesktop: async (title: string, body: string) => { checkpoint(); return sent(() => opts.sendDesktop!(title, body)); } } : {}),
          });
          const report = await guardedNotifier.notify({ message: args.message as string, channels: args.channels as any, priority: args.priority as any,
            ...(args.autoDashboard === true ? { autoDashboard: true } : {}) });
          // Q-19, owner decision: the step reports each channel and fails only
          // when nothing was sent anywhere. A channel that may have taken it
          // counts as sent: failing would invite a resend that could repeat it.
          if (report.delivered.length === 0 && report.unknown.length === 0) {
            const failures = report.failed.map(f => `${f.channel} (${f.error})`).join('; ');
            // A thrown dashboard, voice or desktop send may have reached
            // someone, so its key stays consumed below; the outcome says so
            // too, rather than telling an operator nothing was sent.
            throw new DeliveryFailedError(mayHaveArrived
              ? { status: 'unknown', code: 'DELIVERY_UNCERTAIN', effect: 'may_have_occurred', message: `Not confirmed on any channel; it may have arrived: ${failures}` }
              : { status: 'error', code: 'DELIVERY_FAILED', effect: 'not_started', message: `Not sent on any channel: ${failures}` }, report);
          }
          if (identity) completeIdentity(identity,owner);
          return report;
        } catch (error) {
          // Definitely sent on no channel: the key was not consumed, so a later run may alert.
          if (identity && error instanceof DeliveryFailedError && !mayHaveArrived) releaseIdentity(identity,owner);
          throw error;
        }
      },
    });
    return reply.approval ? { delivered: [], failed: [], unknown: [], approval: reply.approval } : reply.result as Awaited<ReturnType<NotifyFn>>;
  };

  const contextAdapter = new JarvisContextProviderAdapter();
  /**
   * Vault entities, commitments and screen-capture history are the most
   * sensitive things a workflow can read, and a read is the first half of an
   * exfiltration. Each one is a governed `read_data` effect, so a user who puts
   * `read_data` under Authority governs both this and `jarvis-ask` -- the source
   * and the sink of that path -- with a single setting.
   */
  const contextEffect = async <T>(
    ctx: WorkflowEffectContext,
    action: string,
    store: string,
    request: Record<string, unknown>,
    run: (args: Record<string, unknown>) => Promise<T>,
  ): Promise<ContextReply<T>> => {
    const reply = await effects.invoke({ context: ctx, piece: '@jarvispieces/piece-jarvis-context', action,
      route: `context:${action}`, toolName: `workflow_${action}`, category: 'read_data', toolCategory: 'context',
      request: { ...request }, prepare: () => ({ arguments: { ...request }, target: { store } }),
      execute: async (args, checkpoint) => { checkpoint(); return run(args); },
    });
    return reply.approval ? { approval: reply.approval } : { result: reply.result as T };
  };
  // Wrapped like `llmChat` and `notify`: a canceled run must not read either.
  const contextProvider: JarvisContextProvider = {
    vaultSearch: cancellableWorkflowService((input, ctx) =>
      contextEffect(ctx, 'vault_search', 'vault', { ...input }, (args) =>
        contextAdapter.vaultSearch(
          args as Parameters<typeof contextAdapter.vaultSearch>[0],
        ),
      ),
    ),
    vaultGetEntity: cancellableWorkflowService((id: string, ctx) =>
      contextEffect(ctx, 'vault_get_entity', 'vault', { id }, (args) =>
        contextAdapter.vaultGetEntity(args.id as string),
      ),
    ),
    awarenessRecent: cancellableWorkflowService((input, ctx) =>
      contextEffect(ctx, 'awareness_recent', 'awareness', { ...input }, (args) =>
        contextAdapter.awarenessRecent(args),
      ),
    ),
    commitmentsList: cancellableWorkflowService((input, ctx) =>
      contextEffect(ctx, 'commitments_list', 'commitments', { ...input }, (args) =>
        contextAdapter.commitmentsList(
          args as Parameters<typeof contextAdapter.commitmentsList>[0],
        ),
      ),
    ),
  };

  // Prefer the full M7 loop when the daemon supplied an orchestrator +
  // specialist registry. Fall back to the single-shot LLM delegator
  // otherwise -- workflow runs still get *some* answer instead of a 503.
  const m7Ready =
    opts.agentOrchestrator !== undefined && opts.agentSpecialists !== undefined
    && opts.authorityEngine !== undefined && opts.auditTrail !== undefined && opts.emergencyController !== undefined;
  const m7 = m7Ready
    ? new M7AgentDelegator({
        orchestrator: opts.agentOrchestrator!,
        llmManager: opts.llmManager,
        specialists: opts.agentSpecialists!,
        // The bound a delegation card states when the step sets none
        // (`workflowDelegateIntent`), passed explicitly so the card and the
        // run cannot drift (#1040).
        defaultMaxIterations: DEFAULT_MAX_ITERATIONS,
        ...(opts.authorityEngine ? { authorityEngine: opts.authorityEngine } : {}),
        ...(opts.auditTrail ? { auditTrail: opts.auditTrail } : {}),
        ...(opts.emergencyController ? { emergencyController: opts.emergencyController } : {}),
        ...(opts.agentScopedRegistry ? { scopedRegistry: opts.agentScopedRegistry } : {}),
      })
    : null;
  const llmOnlyDelegator = new LlmOnlyAgentDelegator(llmClient);
  const AGENT_PIECE = '@jarvispieces/piece-jarvis-agent';
  const agentDelegate: AgentDelegateFn = async (req, ctx) => {
    if (!m7) return llmOnlyDelegator.delegate(req); // LLM-only fallback has no tool effects.
    // How the caller handles the outcome is not part of what is dispatched.
    const { requiredTools: _required, requireSuccess: _handled, ...effectRequest } = req;
    // The decision to delegate at all. The sub-agent's governed tool calls
    // each pass the boundary below as their own effects; this record only
    // says delegation was allowed, so a step the engine runs again resumes
    // the conversation instead of asking to delegate a second time.
    const reply = await effects.invoke({ context: ctx, piece: AGENT_PIECE, action: 'delegate',
      route: 'agent', toolName: 'workflow_delegate', category: 'spawn_agent', toolCategory: 'delegation',
      request: { ...effectRequest },
      prepare: () => ({ arguments: { ...effectRequest },
        target: { role: req.role ?? WORKFLOW_DEFAULT_ROLE, intent: workflowDelegateIntent(effectRequest) } }),
      intentFor: workflowDelegateIntent,
      cardRefusal: (args) => workflowDelegateCardRefusal(args, opts.agentSpecialists!),
      // What runs is what the card showed (#1040), the rule the delegated
      // calls below follow: the sentence recomputed from the frozen request
      // must still be the one approved. A record from before cards carried
      // one has nothing to hold.
      validateTarget: (args, target) => {
        if (typeof target.intent === 'string' && workflowDelegateIntent(args) !== target.intent) {
          throw new ActionOutcomeError({ status: 'blocked', code: 'EFFECT_CHANGED_AFTER_REVIEW', effect: 'not_started',
            message: `What this delegation would do changed after approval (approved: ${JSON.stringify(target.intent)}); dispatch blocked` });
        }
      },
      execute: async (_args, checkpoint) => { checkpoint(); return { dispatch: 'authorized' }; },
    });
    if (reply.approval) return { finalMessage: '', toolCalls: [], status: 'approval_required', approval: reply.approval };
    const resolved = resolveEffectContext(ctx, AGENT_PIECE, 'delegate');
    const id = delegationId(resolved.run.id, resolved.stepName, resolved.executionPath);
    const continuation: DelegationContinuation = {
      identity: { id, runId: resolved.run.id, stepName: resolved.stepName, executionPath: resolved.executionPath,
        versionDigest: resolved.versionDigest },
      load: () => getDelegation(id),
      save: saveDelegation,
      // A governed call inside the sub-agent is a workflow effect of its own:
      // bound to the run, version, step and loop position by the boundary,
      // to the tool and its frozen arguments by the request digest, parked on
      // an approval when the category is governed, dispatched once, and
      // answered from its record when the resumed conversation asks again.
      dispatch: async (registry, call) => {
        // Every refusal below goes through here, so each one is audited under
        // the RUN as well (#672). A call this route parks or dispatches gets a
        // `workflow:<runId>` row from the boundary; one it refused got only the
        // sub-agent gate's row, which before #730 was under the spawned
        // child's id and named neither the run nor the step -- so the run's
        // own audit showed the delegation allowed and then nothing.
        // `toolsInvoke` and `pieceAuthorize` audit their refusals the same way.
        //
        // On a first pass `sub-agent-runner.ts` also writes the gate's row.
        // On a RESUME it does not: it hands the parked call straight back here
        // without re-running its gate or writing a row, so for a refusal on
        // resume this row is the only one -- before #672 there was none. The
        // `confirm: 'always'` refusal below is reachable in practice only that
        // way (on a first pass the runner's gate denies it first, short of a
        // stateful gate changing its answer in the microseconds between the
        // two calls), when the tool's gate changed while the call was parked.
        //
        // The category is the worse of the parked call's (the runner's gate at
        // park time, which is what the gate's row says) and the gate recomputed
        // now, which is what the last refusal decides on. On a first pass the
        // two are the same; on resume the parked one alone could record a
        // write that was refused as a command.
        //
        // What the runner decides itself never reaches here -- any denial by
        // its gate (level, profile, taint, override, context rule), an
        // off-list refusal, any call it allows outright, an emergency
        // suspension. Those rows are under the run too since #730, not here:
        // `m7-agent-delegator.ts` hands the runner `runScopedAuditTrail`,
        // which writes them as `workflow:<runId>` with the step and the child
        // in the name. An unknown tool name still writes no row anywhere, on
        // purpose: it is not a governance decision and has no category.
        // #731. A call refused HERE on a resume was parked by the first pass,
        // so it has an `agent-tool:N` record, `pending`, whose approval was
        // then granted. The boundary never sees the refusal, so nothing moved
        // that record: it stayed pending with its approval approved for good,
        // and the run's effects gave an operator no way to tell it had been
        // refused. It is marked `blocked`, denied, with the refusal as its
        // reason -- what the boundary writes for its own refusals -- which is
        // terminal: `invoke` throws a non-pending record's error rather than
        // dispatching it, and the approval scheduler resumes only `pending`.
        //
        // Only THIS call's record: the same route, still pending, with the
        // request digest the dispatch below would have bound. A refusal on a
        // first pass has no record and gets none. Since #845 the approval gets
        // its `blocked` receipt too, as every boundary refusal's does: it was
        // granted and will never be acted on, and leaving it `approved` showed
        // the approvals surface a granted call that never ran. The effect
        // record is still where the detail lives; the receipt names it.
        // Synchronous from the read to the write, so nothing can claim the
        // record in between.
        const blockParkedEffect = (reason: string): void => {
          const parked = getWorkflowEffect(
            workflowEffectId(resolved.run.id, resolved.stepName, resolved.executionPath, `agent-tool:${call.sequence}`));
          if (!parked || parked.status !== 'pending') return;
          if (parked.requestDigest !== digest({ toolName: call.toolCall.name, arguments: call.toolCall.arguments })) return;
          const blocked: WorkflowEffect = { ...parked, status: 'blocked', decision: 'denied', error: reason, reason, finishedAt: Date.now() };
          saveWorkflowEffect(blocked);
          // The approval that parked it was granted and is now never acted on
          // (#845): its receipt, as the boundary gives its own refusals.
          closeEffectApproval(opts.approvalManager, blocked, 'blocked', opts.onWorkflowCardClosed);
        };
        const gate = resolveToolGate(registry.get(call.toolCall.name), call.toolCall.name, call.toolCall.arguments);
        const refusedCategory = severityRank(gate.actionCategory) > severityRank(call.actionCategory)
          ? gate.actionCategory : call.actionCategory;
        const refuse = (reason: string) => {
          effects.auditRefusal({ context: ctx, toolName: call.toolCall.name, category: refusedCategory });
          blockParkedEffect(reason);
          return { kind: 'denied' as const, reason };
        };
        // Supported UI actions keep the same click-only, live-surface review as
        // chat. Other opaque code/UI capabilities remain unsupported here.
        const uiReview = workflowUiReview(registry.get(call.toolCall.name), call.toolCall.name, call.toolCall.arguments);
        if (OPAQUE_TOOL_NAMES.has(call.toolCall.name) && !uiReview && !workflowUiRead(call.toolCall.name, call.toolCall.arguments)) {
          return refuse(`Unsupported workflow capability: ${call.toolCall.name} has opaque code/UI effects; use a typed governed adapter.`);
        }
        if (GATED_TOOL_NAMES.has(call.toolCall.name)) {
          return refuse(`Unsupported workflow capability: ${call.toolCall.name} is only approvable through its typed adapter; call it as a flow step, not from a delegated agent.`);
        }
        const unboundable = surfaceBoundRefusal(registry.get(call.toolCall.name), call.toolCall.name, call.toolCall.arguments);
        if (unboundable && !uiReview) return refuse(unboundable);
        const remoteKey = uiReview ? remoteKeyPressRefusal(call.toolCall.name, call.toolCall.arguments, machinePinForRun(resolved.run.id)) : null;
        if (remoteKey) return refuse(remoteKey);
        if (gate.confirm === 'always' && !uiReview) {
          return refuse(`Unsupported workflow capability: ${call.toolCall.name} requires the user's explicit confirmation, which a delegated agent cannot ask for; call it as a flow step so the approval is raised by the step that names it.`);
        }
        let uiExecution: ReturnType<ApprovalManager['getUiExecution']> = null;
        // What the card shows (#1314): every value the agent sent, marked as
        // the agent's, the computer, and the screen as this run last read it.
        const subject = uiReview ? registry.get(call.toolCall.name)?.reviewSubject?.(call.toolCall.arguments) ?? {} : {};
        let uiCard: UiCard | null = null;
        if (uiReview) {
          try {
            assertUiComputerPinned(resolved.run.id, false);
            uiCard = workflowUiCard(call.toolCall.name, call.toolCall.arguments, {
              computer: uiCallComputer(call.toolCall.name, call.toolCall.arguments.target).name, source: () => 'agent',
              declared: Object.keys(registry.get(call.toolCall.name)?.parameters ?? {}),
              page: subject.origin, element: subject.element,
              ...desktopSubjectFromRun(listWorkflowEffects(resolved.run.id), call.toolCall.name, call.toolCall.arguments) });
          } catch { uiCard = null; /* `prepare` refuses it typed and recorded; no card is raised without a computer. */ }
        }
        // Set once the call is dispatched; read by `validateTarget` below.
        let dispatched = false;
        try {
          const inner = await effects.invoke({ context: ctx, piece: AGENT_PIECE, action: 'delegate',
            route: `agent-tool:${call.sequence}`, toolName: call.toolCall.name, category: call.actionCategory,
            ...(uiReview || workflowUiRead(call.toolCall.name, call.toolCall.arguments) ? { categories: gate.categories } : {}),
            toolCategory: call.toolCategory, request: { toolName: call.toolCall.name, arguments: call.toolCall.arguments },
            // Judged as the sub-agent the gate judged it for, and never
            // concluded to need less than the gate required.
            principal: call.principal, approvalRequired: true,
            // The sub-agent's gate may have substituted an approval for a
            // level shortfall; judge it here the same way, or the approval it
            // asked for could never be granted.
            //
            // Every UI action needs a dashboard click and the originating
            // registry's live guard; Authority overrides cannot auto-approve it.
            ...(uiReview ? { confirmation: { confirm: 'always' as const, intent: uiCard ? uiCardSentence(uiCard) : gate.intent ?? 'Review UI action' }, reviewRegistry: registry,
              reviewSubject: subject, ...(uiCard ? { uiCard } : {}),
              cardRefusal: () => uiCard ? uiCardRefusal(uiCard) : 'The approval card could not name the computer this action would run on.',
              approvalExpiresAt: workflowUiCardDeadline(call.toolCall.name) } : {}),
            ...(gate.confirm || workflowUiRead(call.toolCall.name, call.toolCall.arguments)
              ? { aboveLevelFloor: uiReview || workflowUiRead(call.toolCall.name, call.toolCall.arguments) ? 'read_data' as const : gate.floorCategory } : {}),
            // The target names who asked, so the card and the record are bound
            // to the principal and not only to the tool.
            //
            // And what the call does, when its gate says (#988): the card
            // shows `target.intent` as its sentence. Before, it read only the
            // tool's name -- "Manage agents" for a spawn that also starts a
            // task -- which was harmless while the spawn sink asked again on
            // its own card. That approval now answers the sink (`execute`
            // below), so the card it buys has to say what it buys.
            prepare: () => {
              // A delegated UI call runs only on the computer the workflow was
              // enabled against (#1314 M2), never one the agent named itself.
              // Every read of the screen is held the same way by the machine
              // scope (`withWorkflowMachineBinding`, delegated): a snapshot shows
              // the agent a computer as much as a click acts on one.
              if (uiReview) assertUiComputerPinned(resolved.run.id, false);
              if (uiReview) uiCallComputer(call.toolCall.name, call.toolCall.arguments.target);
              return { arguments: { ...call.toolCall.arguments }, target: { tool: call.toolCall.name, sequence: call.sequence,
              principal: { agentId: call.principal.agentId, agentRoleId: call.principal.agentRoleId, agentAuthorityLevel: call.principal.agentAuthorityLevel },
              ...(gate.intent ? { intent: gate.intent } : {}) } };
            },
            // The arguments are frozen but a path in them is resolved only
            // when the tool runs, possibly long after review. A write that now
            // reaches a stricter category than the gate judged (a relative
            // path under a different cwd, a file that became a shell rc or a
            // hook, #522) is not the call that was approved.
            validateTarget: (args, target) => {
              if (uiReview && !dispatched) {
                const effect = getWorkflowEffect(workflowEffectId(resolved.run.id, resolved.stepName, resolved.executionPath, `agent-tool:${call.sequence}`));
                const approval = effect?.approvalId ? opts.approvalManager?.getRequest(effect.approvalId) : null;
                assertWorkflowUiCardCurrent(approval);
                uiExecution = approval ? opts.approvalManager?.getUiExecution(approval) ?? null : null;
                if (!uiExecution) throw new ActionOutcomeError({ status: 'blocked', code: 'WORKFLOW_UI_REVIEW_STALE', effect: 'not_started',
                  message: 'The reviewed app or browser session changed, or Jarvis restarted. Start a new run to review the current screen.' });
              }
              const now = resolveToolGate(registry.get(call.toolCall.name), call.toolCall.name, args);
              if (severityRank(now.actionCategory) > severityRank(call.actionCategory)) {
                throw new ActionOutcomeError({ status: 'blocked', code: 'EFFECT_CHANGED_AFTER_REVIEW', effect: 'not_started',
                  message: `${call.toolCall.name} now reaches ${now.actionCategory}, not the ${call.actionCategory} it was reviewed as; dispatch blocked` });
              }
              // A card that carried a sentence was an approval of THAT
              // sentence, the deferred executor's rule (#988): a stop whose
              // agent is now on a different task is not the stop approved.
              // A record from before cards carried one has nothing to hold.
              // Before dispatch only: this fence also runs at every checkpoint
              // inside the call, where a sentence the call's own effect
              // changed is not a change after approval.
              const approved = typeof target.intent === 'string' ? target.intent.trim() : null;
              if (!dispatched && approved !== null && (now.intent?.trim() ?? '') !== approved) {
                throw new ActionOutcomeError({ status: 'blocked', code: 'EFFECT_CHANGED_AFTER_REVIEW', effect: 'not_started',
                  message: `${call.toolCall.name}: what it would do changed after approval (approved: ${JSON.stringify(approved)}; now: ${JSON.stringify(now.intent?.trim() ?? '')}); dispatch blocked` });
              }
            },
            execute: async (args, checkpoint) => {
              checkpoint();
              dispatched = true;
              try {
                // Delivery off (#586): the collapse below cannot keep a trusted
                // trailer out of band, and a delivery is recorded when the tool
                // offers one. Recording here spent a playbook slot on a copy
                // that arrives disclaimed -- and, because this dispatch belongs
                // to the sub-agent whose scope the runner entered, it spent that
                // sub-agent's. Suppressing nests inside that scope, which is the
                // right way round: the innermost caller knows what happens to
                // the value.
                const run = () => withoutTemplateDelivery(() => uiReview
                  ? runAsReviewed(uiExecution!.reviewed, () => uiExecution!.registry.execute(call.toolCall.name, args))
                  : registry.execute(call.toolCall.name, args));
                // Inside the approval this call was dispatched under (#988),
                // as the deferred executor runs an approved card: a spawn or
                // stop sink the call reaches reads it instead of asking a
                // second time. Without it an approved `manage_agents spawn`
                // raised another card and an approved `delegate_task` was
                // refused. Only a card that named the act (`target.intent`,
                // checked unchanged by `validateTarget` just before this),
                // for the category it was approved as, spent by the first
                // lifecycle decision and closed when this call settles.
                //
                // Source 'approval', not 'workflow_effect': this is a card a
                // person approved for exactly this call, through the same
                // surfaces as a deferred card, now naming the act. So it
                // answers a taint-driven decision or a stop at the sink, as an
                // approved deferred card does. Like one, it was judged for its
                // own principal (the sub-agent), and the sink judges that same
                // sub-agent, under its restrictions and taint (#1014).
                //
                // Otherwise outside any approval: this runs inside the
                // delegation's own scope (`m7.delegate` below), whose grant
                // was for starting THIS sub-agent and is not one for a call
                // the sub-agent makes. Its spawn spends it today; this does
                // not depend on that.
                const record = getWorkflowEffect(workflowEffectId(resolved.run.id, resolved.stepName, resolved.executionPath, `agent-tool:${call.sequence}`));
                const approval = record?.approvalId && typeof record.target.intent === 'string'
                  ? opts.approvalManager?.getRequest(record.approvalId) ?? null : null;
                const raw = approval?.status === 'approved' && approval.execution_mode === 'workflow'
                  ? await runAsApproved({ categories: [approval.action_category as ActionCategory], approvalId: approval.id, source: 'approval' }, run)
                  : await outsideApprovalScope(run);
                // One string only: this crosses the durable effect boundary, so a
                // carrier would not survive it anyway. Collapsing puts any
                // repo-authored trailer back in band, where the sub-agent runner
                // frames it as data with the rest -- see the note in
                // authority/deferred-executor.ts for why that direction is safe.
                return toolReturnText(raw);
              } catch (error) {
                // A tool that failed under its approval is a typed failure, so
                // the boundary records the outcome and answers the same way
                // when the resumed conversation asks again.
                if (error instanceof ActionOutcomeError) throw error;
                throw new ActionOutcomeError({ status: 'error', code: 'TOOL_FAILED', effect: 'may_have_occurred',
                  message: `Error executing ${call.toolCall.name}: ${error instanceof Error ? error.message : String(error)}` });
              }
            } });
          if (inner.approval) return { kind: 'paused', approval: inner.approval };
          return { kind: 'executed', result: String(inner.result ?? '') };
        } catch (error) {
          // The record the boundary left decides what the agent sees, never
          // the message: a blocked effect (the user's decision, an Authority
          // refusal for this principal, emergency state, a refused target) is
          // a denial, a failed one a failure the agent continues from. A
          // refusal that left no final record (a changed version, an
          // uncertain or already claimed earlier attempt) is this run's
          // error, not the delegation's.
          const message = error instanceof Error ? error.message : String(error);
          const recorded = getWorkflowEffect(workflowEffectId(resolved.run.id, resolved.stepName, resolved.executionPath, `agent-tool:${call.sequence}`));
          if (recorded?.status === 'blocked') return { kind: 'denied', reason: recorded.error ?? message };
          if (recorded?.status === 'failed') return { kind: 'failed', result: recorded.error ?? message };
          throw error;
        }
      },
    };
    // When the boundary above parked this delegation on a card and the person
    // approved it, the spawn sink inside must not ask again (#932). Only then:
    // the boundary judged the workflow's principal, not the primary the sink
    // judges, so an authorisation that was never an approval cannot answer an
    // approval the sink asks for. Spent by that one spawn.
    const delegation = getWorkflowEffect(workflowEffectId(resolved.run.id, resolved.stepName, resolved.executionPath, 'agent'));
    // A delegation approved on a card that named its goal runs that goal
    // without the characters the card could not display (#1040), as
    // `delegate_task` does: tag characters spell hidden ASCII. One whose card
    // named nothing (raised before cards did) runs exactly what it ran
    // before, so a paused conversation resumes on the goal it began with.
    // The role the card named is the role run, passed explicitly.
    const shown = delegation?.approvalId && typeof delegation.target.intent === 'string'
      ? { ...req, role: req.role ?? WORKFLOW_DEFAULT_ROLE, goal: withoutCardInvisibles(req.goal) } : req;
    const result = delegation?.approvalId
      ? await runAsApproved({ categories: ['spawn_agent'], approvalId: delegation.approvalId, source: 'workflow_effect' },
        () => m7.delegate(shown, continuation))
      : await m7.delegate(shown, continuation);
    const uncertain = listWorkflowEffects(ctx.runId).find(effect => effect.stepName === resolved.stepName
      && digest(effect.executionPath) === digest(resolved.executionPath) && effect.route.startsWith('agent-tool:')
      && (effect.status === 'unknown' || effect.status === 'dispatching'));
    // Never let a conversational ending or required-tools check downgrade an
    // uncertain child dispatch to success or an ordinary retriable failure.
    return { ...result, delegation: continuation.identity, ...(uncertain ? { status: 'error' as const,
      outcome: { status: 'unknown' as const, code: 'DELEGATED_EFFECT_UNCERTAIN', effect: 'may_have_occurred' as const,
        message: `Delegation ${id} has an uncertain effect ${uncertain.id}; inspect its receipt before any new run` } } : {}) };
  };

  const eventsPoll: EventsPollFn = async (req) => {
    const reply = opts.eventBuffer.poll(req);
    // The route's `JarvisEvent` types `id` as a string (consistent with all
    // other engine ids); the buffer assigns monotonic numbers internally.
    // Stringify at the boundary so the wire shape stays uniform.
    return {
      events: reply.events.map((ev) => ({
        id: String(ev.id),
        eventType: ev.eventType,
        payload: ev.payload,
        timestamp: ev.timestamp,
      })),
      cursor: reply.cursor,
    };
  };

  const runnerAdapter = new JarvisWorkflowRunnerAdapter();
  // The target flow is looked up in the CALLER's project only (#843 review).
  // `ctx.projectId` is the engine token's, which `resolveEffectContext` has
  // already checked against the caller run before `prepare` runs. Before #843
  // this mattered less: every child run was put in the default project
  // whatever its flow's was. Since #843 a child runs under its own flow's
  // project token, so an unscoped lookup let a flow in one project start
  // another project's flow, with that project's store and connections, on
  // input it chose. A foreign id gets what a missing one gets.
  const childVersion = (flowId: string, projectId: string) => {
    const flow = getFlowInProject(projectId, flowId);
    // #1242: refused before any approval card, and again at dispatch.
    if (flow && isTurnedOff(flow)) throw childTurnedOffOutcome();
    const versionId = flow?.published_version_id ?? (flow ? getLatestDraft(flow.id)?.id : null);
    const version = versionId ? getFlowVersion(versionId) : null;
    if (!version) throw new Error('Target workflow version is unavailable');
    return { versionId: version.id, versionDigest: digest(version.trigger) };
  };
  const workflowsStart: WorkflowsStartFn = async (req, ctx) => {
    const resolved = resolveEffectContext(ctx, '@jarvispieces/piece-jarvis-trigger', 'run_workflow');
    const effectId = workflowEffectId(ctx.runId, resolved.stepName, resolved.executionPath, 'workflow');
    const reply = await effects.invoke({ context: ctx, piece: '@jarvispieces/piece-jarvis-trigger', action: 'run_workflow',
      route: 'workflow', toolName: 'workflow_start', category: 'spawn_agent', toolCategory: 'delegation',
      request: { ...req }, prepare: () => {
        const pinned = childVersion(req.flowId, ctx.projectId);
        // Named on the card (#1040). The name is kept out of `pinned`, whose
        // digest a paused run's execute compares against what it froze.
        const args = { ...req, pinned };
        return { arguments: args, target: { flowId: req.flowId, ...pinned, intent: workflowStartIntentOf(args),
          channelIntent: workflowStartChannelIntentOf(args) } };
      },
      intentFor: workflowStartIntentOf,
      cardRefusal: workflowStartCardRefusal,
      execute: async (args, checkpoint) => {
        checkpoint();
        if (digest(childVersion(args.flowId as string, ctx.projectId)) !== digest(args.pinned)) throw new Error('Target workflow changed after approval; start a new run');
        try {
          return await runnerAdapter.start(args as unknown as Parameters<typeof runnerAdapter.start>[0], ctx.runId, ctx.projectId,
            { effectId, stepName: resolved.stepName });
        } catch (error) {
          // Turned off after review: refused before anything started, not an uncertain dispatch.
          if (error instanceof WorkflowRunnerError && error.code === 'FLOW_TURNED_OFF') throw childTurnedOffOutcome();
          throw error;
        }
      },
    });
    if (reply.approval) return { runId: null, approval: reply.approval };
    const result = reply.result as Awaited<ReturnType<WorkflowsStartFn>>;
    const child = getChildRun(effectId);
    return { ...result, ...(child ? { child, waitpointId: child.outcome ? undefined : child.waitpointId ?? undefined } : {}) };
  };

  /**
   * A step with no Jarvis adapter: a community piece the owner installed from
   * the Library, a CODE step in a workflow granted them, an in-run core step
   * (delay, store, file helper, ...; `IN_RUN_STEP_PIECES`) or one of Jarvis's
   * own pieces. It stays outside Authority by those opt-ins, but it obeys Pause
   * and Kill (Q-08). A community piece or a CODE step leaves an audit row when
   * it is let run: like a governed piece's, the row records the dispatch, not
   * its outcome. Jarvis's own pieces leave none here, since each of their
   * effects passes the boundary and is audited there; in-run core steps leave
   * none either, having no effect outside Jarvis. The HTTP request is not one
   * of these: it is governed since #961. Its input is never sent here.
   */
  const admitUngovernedStep = (req: PieceAuthorizeRequest, ctx: WorkflowEffectContext): PieceAuthorizeResponse => {
    const run = getFlowRun(ctx.runId);
    if (!run || run.projectId !== ctx.projectId) throw new Error('Workflow step identity does not match the run');
    if (run.status !== 'RUNNING') throw new Error(`Workflow step blocked: run is ${run.status}`);
    const state = opts.emergencyController?.getState() ?? 'normal';
    if (state === 'killed') throw new Error(KILLED_REASON);
    const stepName = boundedReceiptText(ctx.stepName ?? 'unknown step', 120);
    if (state === 'paused') {
      const hold = holdStep({ runId: run.id, projectId: run.projectId, stepName: ctx.stepName ?? 'unknown step' });
      return { governed: false, dispatch: 'held', approval: { effectId: '', approvalId: '', waitpointId: hold.id, hold: PAUSED_REASON } };
    }
    // `isCommunityAction` is also what the editor's "Not approval-gated" badge reads (#955).
    if (req.piece === CODE_STEP_PIECE || isCommunityAction(req.piece, req.action)) {
      try {
        opts.auditTrail?.log({ agent_id: `workflow:${run.id}`, agent_name: `Workflow ${run.id} / ${stepName}`,
          tool_name: req.piece === CODE_STEP_PIECE ? 'code step' : `community piece ${boundedReceiptText(`${req.piece}/${req.action}`, 160)}`,
          action_category: 'execute_command', authority_decision: 'allowed', approval_id: null, executed: true });
      } catch (error) { console.error('[Workflow Authority] step audit failed:', error); }
    }
    return { governed: false };
  };

  /**
   * Admission for a verified piece's action. The piece itself runs in the
   * engine subprocess, so what passes through the boundary here is the
   * decision to let it dispatch: the same Authority check, the same emergency
   * and cancellation fences, the same durable record, audit row and approval
   * waitpoint every other effect gets. The remote call happens in the
   * subprocess once this returns, so the record is a dispatch authorization
   * and not a completion receipt.
   *
   * A piece with no adapter goes through `admitUngovernedStep` above.
   *
   * One authorization covers one step instance. A step the flow configures to
   * retry re-reads the recorded authorization for the same arguments instead
   * of asking again, so the engine's own retry of a step whose remote call
   * failed can repeat that call under the original decision. Any change to the
   * arguments, the version or the Authority decision invalidates the record and
   * stops the dispatch.
   *
   * Except a tracked send (Q-07, `tracksPieceCompletion`): its record stays
   * `dispatching` until the engine posts the completion receipt, so a retry
   * after a failed or lost send is refused instead of sending again, and a
   * retry after a recorded receipt gets the stored result back.
   */
  const pieceAuthorize: PieceAuthorizeFn = async (req, ctx) => {
    const named = resolveGovernedPieceAction(req.piece, req.action);
    if (!named) return admitUngovernedStep(req, ctx);
    // The action becomes `tool_name`: the audit row, the effect record, the
    // approval row and the card's `Action:` line (#651). Refused, not reported
    // ungoverned -- `governed: false` would let the engine run the piece with
    // no gate at all -- and refused before anything durable exists, under a
    // label that carries none of the name. Why validate rather than rewrite,
    // and why this invalidates nothing in flight: `isWellFormedPieceActionName`.
    if (!isWellFormedPieceActionName(named.action)) {
      effects.auditRefusal({ context: ctx,
        toolName: governedPieceToolName(named.adapter.catalogId, '[malformed action name]'),
        category: named.category });
      throw new Error(`Governed piece ${named.adapter.catalogId} was asked to run a malformed action name; dispatch refused`);
    }
    // The connection is stripped on the engine side before the input is sent;
    // stripping it again here means neither path can put a credential into the
    // durable record or the approval card. This pass keeps what the engine's
    // pass produced instead of re-cutting it, so the card's counts are the
    // engine's and not the length of the engine's notes (#651) -- see
    // `reprojectPieceInput` for which pending approvals that invalidated.
    //
    // Then the framing delimiters are neutralised (#634). `bound()` cuts every
    // string to 512 characters, and a cut through a framed `UNTRUSTED_CONTENT`
    // block keeps the open delimiter and drops the close -- which goes on to
    // disclaim whatever the approval card renders after it. This is the ONLY
    // site that defangs, deliberately: nothing is durable before this point, so
    // the engine's copy of `sanitizePieceInput` does not need to change and
    // `piece-effects.ts` stays free of the import the engine bundle would have
    // to start tracking. See `piece-effect-receipt.ts` for the whole argument,
    // including which in-flight approvals a changed projection invalidates.
    // F-14: an engine sends a supported decision document whole. What an engine
    // without that protocol would have sent is the bounded projection, so that
    // is the read-only input whenever the document path is not taken.
    const whole = req.documentProtocol === 1 ? documentInput(req.piece, req.action, req.input) : null;
    if (req.documentProtocol === 1 && !whole) throw new Error('Unsupported document protocol input');
    const projected = defangPieceProjection(reprojectPieceInput(whole ? sanitizePieceInput(req.input, req.piece) : req.input, req.piece));
    // #961: an action whose category depends on its input (an HTTP request's
    // method) is judged on the projection the card and the record carry; the
    // engine's digest of the whole input binds that projection to what runs.
    const judged = resolveGovernedPieceAction(req.piece, req.action, projected)!;
    // #1153 (owner decision): an HTTP read runs without asking only to a host
    // on the flow's read list. A body-less GET still carries what its URL and
    // headers hold to the host it names, so to any other host it is a send
    // and asks while sends are governed. The list goes back with the
    // authorization, and the engine holds the request and every redirect to
    // it (`withReadHosts`), so a listed host's redirect cannot carry it on.
    const readHosts = req.piece === HTTP_PIECE && judged.category === 'read_data' ? (() => {
      const flowRun = getFlowRun(ctx.runId);
      return flowRun && flowRun.projectId === ctx.projectId ? getFlowReadHosts(flowRun.flowId)?.hosts ?? [] : [];
    })() : null;
    // A step already recorded keeps the category it was recorded under: a
    // host listed while its card waits must not turn the approved send into
    // a "changed" effect, nor a host removed since make a recorded read ask.
    // Its retry as a read is still held to the list as it is now (the engine
    // refuses an unlisted host), and an approved send is not held at all.
    const recordedRead = readHosts !== null ? getWorkflowEffect(workflowEffectId(ctx.runId, ctx.stepName!, ctx.executionPath ?? [], 'piece'))?.actionCategory : undefined;
    const listedRead = readHosts !== null && (recordedRead === 'read_data' || recordedRead === 'send_message'
      ? recordedRead === 'read_data' : httpReadHostListed(projected, readHosts));
    const resolved = readHosts !== null && !listedRead ? { ...judged, category: 'send_message' as const } : judged;
    // Q-05: an action that sends to or addresses someone memory knows keeps
    // the facts the address matched, and stops if they stop holding.
    const addressing = ['send_email', 'send_message', 'write_data', 'modify_settings'].includes(resolved.category);
    const tool = governedPieceToolDefinition(resolved);
    const capability = (() => {
      try { return toolEffectCapability(tool); }
      catch (error) {
        effects.auditRefusal({ context: ctx, toolName: tool.name, category: refusedEffectCategory(tool) });
        throw error;
      }
    })();
    const tracked = tracksPieceCompletion(req.piece, req.action, projected);
    const route = tracked ? 'piece-dispatch' : 'piece';
    if (tracked && !req.inputDigest) throw new Error('A tracked send requires the complete input digest');
    const legacy = tracked ? getWorkflowEffect(workflowEffectId(ctx.runId, ctx.stepName!, ctx.executionPath ?? [], 'piece')) : null;
    if (legacy?.status === 'pending' && !legacy.outcome) {
      // Recorded under the untracked route before an upgrade tracked this
      // send, and never dispatched. It cannot move to the tracked identity,
      // so it ends here, typed, and its card cannot be approved for nothing.
      const message = 'This send was recorded before an upgrade changed how sends are tracked and was not sent; start a new run';
      legacy.status = 'blocked'; legacy.decision = 'denied'; legacy.error = message; legacy.reason = message;
      legacy.outcome = { status: 'blocked', code: 'WORKFLOW_UPGRADED', message, effect: 'not_started' };
      legacy.finishedAt = Date.now(); saveWorkflowEffect(legacy);
      const card = legacy.approvalId ? opts.approvalManager?.getRequest(legacy.approvalId) : null;
      if (card?.status === 'pending') { if (opts.approvalManager?.deny(card.id, 'workflow-upgrade')) opts.onWorkflowCardClosed?.(card.id); }
      else closeEffectApproval(opts.approvalManager, legacy, 'blocked', opts.onWorkflowCardClosed);
      throw new ActionOutcomeError(legacy.outcome);
    }
    // Already ended above (or otherwise settled without sending): repeat its
    // typed outcome instead of claiming it may have dispatched.
    if (legacy?.outcome && legacy.outcome.status !== 'succeeded' && legacy.outcome.effect === 'not_started') throw new ActionOutcomeError(legacy.outcome);
    if (legacy) {
      throw new Error('Legacy piece authorization may already have dispatched; inspect it and start a new intentional run');
    }
    const run = getFlowRun(ctx.runId);
    if (!run || run.projectId !== ctx.projectId) throw new Error('Workflow step identity does not match the run');
    const requestOf = (input: Record<string, unknown>, documentProtocol: boolean) => ({ piece: req.piece, action: req.action, input,
      ...(req.inputDigest ? { inputDigest: req.inputDigest } : {}),
      ...(tracked && req.credentialDigest ? { credentialDigest: req.credentialDigest } : {}),
      ...(documentProtocol ? { documentProtocol: 1 } : {}) });
    // A recorded effect keeps the protocol it was recorded under, whatever the
    // flag says now: a pending revision resumes, and an older record stays
    // read-only. A new one is a document only with the feature on, and only
    // when no text spells a framing delimiter the defang would rewrite (#634);
    // such a document keeps the bounded, defanged card instead.
    const previous = getWorkflowEffect(workflowEffectId(ctx.runId, ctx.stepName!, ctx.executionPath ?? [], route));
    const document = whole && (previous ? previous.requestDigest === digest(requestOf(whole, true))
      : opts.decisionDocumentsEnabled === true && digest(defangPieceProjection(whole)) === digest(whole)) ? whole : null;
    const contact = isHubspotContact(req.piece, req.action) ? hubspotContactInput(req.input) : null;
    if (contact && digest(contact) !== req.inputDigest) throw new Error('HubSpot contact input digest mismatch');
    const input = contact ?? document ?? projected;
    const providerBinding = tracked ? captureProviderBinding({ projectId: ctx.projectId, versionId: run.flowVersionId,
      stepName: ctx.stepName!, piece: req.piece, credentialDigest: req.credentialDigest, runId: ctx.runId }) : undefined;
    if (contact && !providerBinding) throw new Error('HubSpot contact upsert requires a saved, active HubSpot 0.12.1 OAuth connection; choose it in setup');
    const reply = await effects.invoke({ context: ctx, piece: req.piece, action: req.action,
      externalDispatch: tracked && !contact, providerBinding,
      // #953: a governed send or payment over the workflow's level asks
      // instead of failing the step, as a gated tool does; deletes and
      // settings changes stay denied by level.
      aboveLevelFloor: PIECE_ABOVE_LEVEL_FLOOR, aboveLevelGovernedOnly: PIECE_ABOVE_LEVEL_ASKS,
      route, toolName: tool.name, category: capability.category, toolCategory: tool.category,
      // Digested over the projection AND the engine's digest of the whole
      // resolved input, so a change to any prop -- including the part of a
      // long body or a long recipient list the card cuts -- invalidates an
      // approval granted earlier (Q-08).
      request: requestOf(input, !!document),
      documentReview: !!document,
      prepare: () => {
        // Matched once, when the effect is recorded; resumes and retries recheck the record's facts.
        const facts = addressing ? recipientFactPins(recipientAddresses(input)) : [];
        return { arguments: input, target: capability.target(input), ...(facts.length ? { bindings: { facts } } : {}) };
      },
      // A revised document carries its own reviewed target; anything else is frozen to this input.
      validateTarget: (args, target) => {
        if (digest(capability.target(document ? args : input)) !== digest(target)) throw new Error('Workflow execution target changed after review; dispatch blocked');
      },
      revalidate: record => assertRecipientFactsCurrent((record.bindings as { facts?: FactPin[] } | undefined)?.facts),
      revalidateOnReplay: true,
      // The engine applies exactly the reviewed document it is handed here.
      execute: async (args, checkpoint) => {
        checkpoint();
        if (contact) {
          // The row the engine resolved, still holding the same account's
          // credential: a token refresh since then keeps it, a person
          // replacing the credential does not.
          const connection = getConnection(providerBinding!.connectionId);
          if (!providerBindingHolds(providerBinding!, connection, ctx.projectId, req.piece))
            throw new Error('HubSpot connection changed before dispatch');
          // A stored OAuth2 token about to expire is refreshed here (#954), as
          // the engine's connection route does, only once the binding held.
          // A failure is before any HubSpot call and before the contact is
          // claimed, so a later submission can still write it.
          let token: unknown;
          try {
            token = (await opts.credentialResolver.fresh({ type: connection.type, value: connection.value,
              pieceName: connection.pieceName, status: connection.status,
              stored: { id: connection.id, projectId: connection.projectId, externalId: connection.externalId, generation: connection.credentialGeneration } })).value.access_token;
          } catch (error) {
            if (!(error instanceof ConnectionCredentialError)) throw error;
            // Typed on the run's binding as well, as every other service records it (#1233).
            recordRunCredentialOutcome(ctx.runId, connection.externalId, { code: error.code, message: error.message });
            // Only an expired or refused credential needs a person to reconnect; the others pass.
            const account = `the selected HubSpot account (${connection.externalId})`;
            const message = error.code === 'CONNECTION_EXPIRED' ? `Reconnect ${account}: ${error.message}`
              : error.code === 'CONNECTION_REFRESH_UNREACHABLE' ? `Nothing was sent: Jarvis could not refresh ${account} just now, which is usually temporary. Start a new run later. ${error.message}`
              : `Nothing was sent: ${account} changed while Jarvis refreshed it. Start a new run. ${error.message}`;
            throw new ActionOutcomeError({ status: 'blocked', code: error.code, message, effect: 'not_started' });
          }
          if (typeof token !== 'string' || !token)
            throw new ActionOutcomeError({ status: 'blocked', code: 'CONNECTION_EXPIRED',
              message: `Reconnect the selected HubSpot account (${connection.externalId}): it holds no access token`, effect: 'not_started' });
          // A stored OAuth2 credential was handed out: clear any failure an earlier fetch recorded.
          recordRunCredentialOutcome(ctx.runId, connection.externalId, null);
          checkpoint();
          const values = hubspotContactInput(args);
          const identity = digest(['hubspot-contact-v1',ctx.projectId,connection.id,values.email]);
          const owner = workflowEffectId(ctx.runId,ctx.stepName!,ctx.executionPath ?? [],route);
          await claimSettledIdentity(identity, owner, false, checkpoint, HUBSPOT_CLAIM_WAIT_MS);
          let result: Awaited<ReturnType<typeof upsertHubspotContact>>;
          try { result = await upsertHubspotContact(values, token, checkpoint, opts.hubspotFetch); }
          catch (error) {
            // A definite refusal, a checkpoint refusal before any possible
            // write, or a failed read-only lookup changed nothing: release the
            // contact and record the step as not started. Anything else stays
            // fenced until a person resolves it (recovery mark_done/release).
            if (error instanceof HubspotNotStartedError) {
              releaseIdentity(identity, owner);
              throw error.refusal !== undefined ? notStartedOutcome(error.refusal)
                : new ActionOutcomeError({ status: 'error', code: 'PROVIDER_UNAVAILABLE', message: error.message, effect: 'not_started' });
            }
            if (!(error instanceof HubspotWriteRefusedError)) throw error;
            releaseIdentity(identity, owner);
            throw new ActionOutcomeError({ status: 'error', code: 'PROVIDER_REFUSED', message: error.message, effect: 'not_started' });
          }
          completeIdentity(identity, owner);
          return result;
        }
        return { dispatch: 'authorized',
        ...(document ? { document: projectDocument(req.piece, req.action, args) } : {}) }; } });
    if (reply.approval) return { governed: true, dispatch: 'approval_required', approval: reply.approval };
    const approved = () => document ? { document: (reply.result as { document: ReturnType<typeof projectDocument> }).document } : {};
    if (tracked) {
      const effectId = workflowEffectId(ctx.runId, ctx.stepName!, ctx.executionPath ?? [], route);
      return getWorkflowEffect(effectId)?.status === 'succeeded'
        ? { governed: true, dispatch: 'completed', result: reply.result }
        : { governed: true, dispatch: 'authorized', effectId, ...approved() };
    }
    return { governed: true, dispatch: 'authorized', ...approved(), ...(listedRead ? { readHosts: readHosts! } : {}) };
  };

  const services: SandboxApiServices = {
    humanInput: cancellableWorkflowService((input: Record<string, unknown>, ctx: WorkflowEffectContext) =>
      requestHumanInput(input, ctx, Date.now(), { unavailable: opts.humanInputUnavailable?.() ?? null })),
    subflowCall: cancellableWorkflowService(createSubflowService(effects,opts.subflowNow,(flowId,versionId,payload)=>({intent:workflowStartIntentOf({flowId,pinned:{versionId},waitForCompletion:true,payload}),
      channelIntent:workflowStartChannelIntentOf({flowId,pinned:{versionId},waitForCompletion:true,payload})}),workflowStartCardRefusal)),
    subflowResult: cancellableWorkflowService(returnSubflowResult),
    credentialResolver: opts.credentialResolver,
    meetingBriefs: cancellableWorkflowService(meetingBriefs),
    quarterlyReport: cancellableWorkflowService(createQuarterlyReportService({effects,credentials:opts.credentialResolver,fetchImpl:opts.reportFetch})),
    weeklyReport: cancellableWorkflowService(createWeeklyReportService({effects,credentials:opts.credentialResolver,fetchImpl:opts.reportFetch,now:opts.reportNow})),
    approvalRefund: cancellableWorkflowService(createRefundService({effects,credentials:opts.credentialResolver,fetchImpl:opts.refundFetch,now:opts.refundNow})),
    contactImport: cancellableWorkflowService(createContactImportService({effects,credentials:opts.credentialResolver,request:opts.importRequest,now:opts.importNow,budget:opts.importBudget})),
    leadBatch: cancellableWorkflowService(createLeadBatchService({effects,credentials:opts.credentialResolver,fetchImpl:opts.batchFetch,now:opts.batchNow})),
    customerOnboarding: cancellableWorkflowService(createOnboardingService({effects,credentials:opts.credentialResolver,fetchImpl:opts.onboardingFetch})),
    salesFollowups: cancellableWorkflowService(createSalesFollowupsService({effects,credentials:opts.credentialResolver,fetchImpl:opts.salesFetch,now:opts.salesNow})),
    pieceAuthorize: cancellableWorkflowService(pieceAuthorize),
    pieceReceipt: (ctx, id, result) => recordPieceCompletion(ctx, id, result, opts),
    pieceNotSent: (ctx, id, message) => recordPieceNotSent(ctx, id, message, opts),
    llmChat: cancellableWorkflowService(llmChat),
    notify: cancellableWorkflowService(notify),
    contextProvider,
    agentDelegate: cancellableWorkflowService((req, ctx) => withWorkflowMachineBinding(ctx, () => agentDelegate(req, ctx), { delegated: true })),
    eventsPoll,
    workflowsStart: cancellableWorkflowService(workflowsStart),
    ...(opts.resumeUrlPrefix !== undefined ? { resumeUrlPrefix: opts.resumeUrlPrefix } : {}),
  };
  if (toolsInvoke) services.toolsInvoke = cancellableWorkflowService((req, ctx) => withWorkflowMachineBinding(ctx,
    () => req.toolName.startsWith('browser_')
      ? withToolSnapshots(ctx.runId, () => toolsInvoke(req, ctx))
      : toolsInvoke(req, ctx)));
  return services;
}
