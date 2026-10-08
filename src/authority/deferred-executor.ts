/**
 * Deferred Executor — Runs approved tool calls that were waiting for approval.
 */

import type { ToolRegistry } from '../actions/tools/registry.ts';
import { executionState, approvalIntentFromContext, approvalNeedsClick, approvalPrincipal, DASHBOARD_DECIDER, type ApprovalManager, type ApprovalRequest } from './approval.ts';
import { ABOVE_LEVEL_SUBSTITUTION, resolveToolGate, severityRank, substituteAboveLevel } from './tool-action-map.ts';
import { combineDecisions, type AuthorityEngine } from './engine.ts';
import type { ToolDefinition } from '../actions/tools/registry.ts';
import { ActionOutcomeError } from '../actions/action-outcome.ts';
import { rawUiGate } from './ui-intent';
import type { AuditTrail } from './audit.ts';
import type { AuthorityLearner } from './learning.ts';
import type { EmergencyController } from './emergency.ts';
import type { ActionCategory } from '../roles/authority.ts';
import { TAINT_PROFILE_LABEL } from './taint-gating.ts';
import { boundedReceiptText, toolReturnText } from '../roles/untrusted.ts';
import { withoutTemplateDelivery } from '../actions/tools/template-delivery-scope.ts';

// Defined next to substituteAboveLevel, which writes it; re-exported here,
// where the approval learner reads it.
export { ABOVE_LEVEL_SUBSTITUTION };

export type ExecutionResultCallback = (requestId: string, request: ApprovalRequest, result: string) => void;

/**
 * Budget for what `approval_requests.execution_result` stores. 2000 characters,
 * unchanged from the slice it replaces on the success path; the other six
 * writers in this file had no bound at all before (#609).
 *
 * EVERY `markExecuted` below goes through it, including the five `blocked`
 * branches whose strings are repo-authored. For those it is byte-identity, and
 * that is the point: a bound that only some branches apply is a bound the next
 * branch forgets. Two of them do interpolate outside-derived text -- a
 * per-call gate's `intent`, which for `ui_act` is built from an accessibility
 * element's name (`actions/tools/ui.ts`) -- so this is not only hygiene.
 *
 * That `intent` IS reduced at its source since #631: `ui_act` was the one gate
 * whose values skipped `forCard`, and it no longer is. This bound is therefore
 * no longer the only thing standing between a page's text and this column --
 * but it stays load-bearing all the same, because it is the bound that holds
 * for a gate written next year by someone who has not read #631, and because
 * `forCard` is a cap on a VALUE while this is a cap on the whole row.
 *
 * It belongs on `ApprovalManager.markExecuted`, which owns the column, rather
 * than on each caller. That is a coordination cost and not a design preference:
 * `authority/approval.ts` is being changed by another worktree this cycle. Noted
 * so the move is an obvious follow-up instead of a rediscovery.
 *
 * Exported so `workflows/runtime/effect-boundary.ts`, the one writer outside
 * this file that stores a tool's output in this column, uses the same number
 * rather than a second constant that can drift from it.
 */
export const RECEIPT_MAX_CHARS = 2000;

export class DeferredExecutor {
  private toolRegistry: ToolRegistry | null = null;
  private approvalManager: ApprovalManager;
  private auditTrail: AuditTrail;
  private learner: AuthorityLearner | null = null;
  private emergencyController: EmergencyController | null = null;
  private authorityEngine: AuthorityEngine | null = null;
  private onResult: ExecutionResultCallback | null = null;

  constructor(approvalManager: ApprovalManager, auditTrail: AuditTrail) {
    this.approvalManager = approvalManager;
    this.auditTrail = auditTrail;
  }

  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  setLearner(learner: AuthorityLearner): void {
    this.learner = learner;
  }

  setEmergencyController(controller: EmergencyController): void {
    this.emergencyController = controller;
  }

  /** Approved calls are judged again against the permissions in force when they run (Q-08). */
  setAuthorityEngine(engine: AuthorityEngine): void {
    this.authorityEngine = engine;
  }

  /**
   * Why the approved call may no longer run under the permissions in force
   * now, or null. Judged as the agent the request was asked for, the way its
   * gate judged it, with the approval standing in for the approval it asked
   * for: what stops it is a denial -- a deny override, a context rule, a
   * revoked permission, a lowered level a gate cannot substitute -- added
   * since the card was raised (Q-08). Unwired (tests), nothing is rechecked.
   */
  private permissionsRefusal(request: ApprovalRequest, tool: ToolDefinition | undefined, args: Record<string, unknown>): string | null {
    if (!this.authorityEngine) return null;
    const principal = approvalPrincipal(request);
    if (!principal) return 'it was approved before each request recorded whom it was asked for, so its permissions cannot be checked again. Ask for it again.';
    const gate = resolveToolGate(tool, request.tool_name, args);
    const check = (actionCategory: ActionCategory) => this.authorityEngine!.checkAuthority({
      agentId: request.agent_id, agentAuthorityLevel: principal.agentAuthorityLevel, agentRoleId: principal.agentRoleId,
      toolName: request.tool_name, toolCategory: tool?.category ?? 'unknown', actionCategory,
      temporaryGrants: new Map(), profile: principal.profile ?? null,
    });
    const decision = substituteAboveLevel(combineDecisions(gate.categories.map(check)), gate, check);
    return decision.allowed ? null : `its permissions changed after it was approved: ${decision.reason}.`;
  }

  /** The audit row for what became of an approved call: run, refused, failed or uncertain. */
  private logReceipt(request: ApprovalRequest, executed: boolean, executionTimeMs: number | null = null): void {
    try {
      this.auditTrail.log({
        agent_id: request.agent_id, agent_name: request.agent_name, tool_name: request.tool_name,
        action_category: request.action_category as ActionCategory, authority_decision: 'approval_required',
        approval_id: request.id, executed, execution_time_ms: executionTimeMs,
      });
    } catch (err) {
      console.warn('[DeferredExecutor] could not audit a receipt:', err instanceof Error ? err.message : err);
    }
  }

  /** Record a refusal after the claim: nothing ran. */
  private refuse(request: ApprovalRequest, text: string): { claimed: true; result: string } {
    this.approvalManager.markExecuted(request.id, boundedReceiptText(text, RECEIPT_MAX_CHARS), 'blocked');
    this.logReceipt(request, false);
    this.onResult?.(request.id, request, text);
    return { claimed: true, result: text };
  }

  setResultCallback(cb: ExecutionResultCallback): void {
    this.onResult = cb;
  }

  /**
   * Execute a previously approved request. `claimedBy` names the surface
   * that runs it (dashboard, voice, inline gate) and lands in the claim.
   * The string is what the conversation or the channel shows the user.
   */
  async executeApproved(requestId: string, claimedBy = 'deferred-executor'): Promise<string> {
    return (await this.executeApprovedWithReceipt(requestId, claimedBy)).result;
  }

  /**
   * The same execution, reporting whether this call held the claim. A caller
   * that must not report a lost claim as a run (the execute route) reads
   * `claimed`; `result` is the receipt text, or why nothing ran.
   *
   * `failed` is set only when the TOOL threw, and exists so a caller with a
   * model in front of it can frame that text as data without re-reading the row
   * (#608). It is deliberately not set for the `blocked` branches: those strings
   * are repo-authored, so there is nothing to disclaim.
   */
  async executeApprovedWithReceipt(requestId: string, claimedBy = 'deferred-executor'): Promise<{ claimed: boolean; result: string; failed?: boolean }> {
    const request = this.approvalManager.getRequest(requestId);
    if (!request || request.status !== 'approved') {
      return { claimed: false, result: `Error: Request ${requestId} not found or not in approved state` };
    }

    if (request.execution_mode === 'workflow') {
      return { claimed: false, result: 'Workflow-owned approval: execution must resume through its recorded effect boundary' };
    }

    if (!this.toolRegistry) {
      return { claimed: false, result: 'Error: No tool registry configured' };
    }

    // One executor per approval. A second caller, or a daemon restarted after
    // the claim, cannot dispatch the same approved action again; the receipt
    // or the reconciled state says what became of the first attempt.
    if (!this.approvalManager.claimExecution(requestId, claimedBy)) {
      const current = this.approvalManager.getRequest(requestId);
      return { claimed: false, result: `Error: Request ${requestId} was already taken for execution (${current ? executionState(current) : 'missing'}); check its receipt before deciding on another run` };
    }

    // Emergency gate: an approval clicked while the system is paused/killed
    // must not execute. Close the request out (mirroring the error path)
    // so it doesn't linger as an approved-but-never-executed zombie.
    if (this.emergencyController && !this.emergencyController.canExecute()) {
      const state = this.emergencyController.getState();
      return this.refuse(request, `[SYSTEM ${state.toUpperCase()}] Approved action ${request.tool_name} was NOT executed: all tool execution is suspended because the user has ${state} the system.`);
    }

    const startTime = Date.now();

    try {
      const args = JSON.parse(request.tool_arguments);
      const uiCall = rawUiGate(request.tool_name, args);
      const registry = uiCall ? this.approvalManager.getUiExecutionRegistry(request) : this.toolRegistry;
      const gate = resolveToolGate(registry?.get(request.tool_name), request.tool_name, args);
      if (gate.confirm === 'always' && !approvalNeedsClick(request)) {
        const blocked = `Approved action ${request.tool_name} was NOT executed: this approval predates the required UI review. Request a fresh dashboard review.`;
        this.approvalManager.markExecuted(requestId, boundedReceiptText(blocked, RECEIPT_MAX_CHARS), 'blocked');
        this.onResult?.(requestId, request, blocked);
        return { claimed: true, result: blocked };
      }
      if (!registry) {
        const blocked = `Approved action ${request.tool_name} was NOT executed: its original UI session or reviewed subject is no longer available. Take a fresh snapshot and request a fresh review.`;
        this.approvalManager.markExecuted(requestId, boundedReceiptText(blocked, RECEIPT_MAX_CHARS), 'blocked');
        this.onResult?.(requestId, request, blocked);
        return { claimed: true, result: blocked };
      }
      // A card that must be reviewed on screen was approved somewhere that
      // could not show it: a chat reply, a toast, a voice "yes" (Q-08). Every
      // decision surface refuses such an approve; this holds below them all.
      if (approvalNeedsClick(request) && request.decided_by !== DASHBOARD_DECIDER) {
        return this.refuse(request, `Approved action ${request.tool_name} was NOT executed: it must be reviewed and approved on the dashboard, and it was approved from ${request.decided_by ?? 'an unknown surface'}. Ask for it again and approve it on the dashboard.`);
      }
      const permissions = this.permissionsRefusal(request, registry.get(request.tool_name), args);
      if (permissions) {
        return this.refuse(request, `Approved action ${request.tool_name} was NOT executed: ${permissions}`);
      }
      // An approval given to a call that had no per-call gate then, but has
      // one now that raises it, was not an approval of what would run: a
      // relative write_file path reviewed in a site chat resolves against
      // home once the turn has ended, and a path can have become a shell rc
      // or a hook in between (#522).
      if (gate.intent && !approvalIntentFromContext(request)
        && severityRank(gate.actionCategory) > severityRank(request.action_category)) {
        const blocked = `Approved action ${request.tool_name} was NOT executed: it was approved as ${request.action_category}, but it now reaches ${gate.actionCategory} (${gate.intent}). Request a fresh approval.`;
        this.approvalManager.markExecuted(requestId, boundedReceiptText(blocked, RECEIPT_MAX_CHARS), 'blocked');
        this.onResult?.(requestId, request, blocked);
        return { claimed: true, result: blocked };
      }
      // A card that carried a sentence was an approval of THAT sentence. When
      // the same arguments now produce a different one -- write_file naming
      // the file it will land on, which moves when the site chat's cwd is
      // gone; a skill whose stored steps changed -- it is not the call that
      // was approved. UI calls are left to their own guard: their sentence
      // describes a live screen, and captureApprovalGuard binds that.
      const approvedIntent = approvalIntentFromContext(request);
      if (!uiCall && approvedIntent && gate.intent && gate.intent.trim() !== approvedIntent) {
        const blocked = `Approved action ${request.tool_name} was NOT executed: what it would do changed after approval (approved: "${approvedIntent}"; now: "${gate.intent}"). Request a fresh approval.`;
        this.approvalManager.markExecuted(requestId, boundedReceiptText(blocked, RECEIPT_MAX_CHARS), 'blocked');
        this.onResult?.(requestId, request, blocked);
        return { claimed: true, result: blocked };
      }
      // Delivery off for the duration (#586). This path CANNOT place a trusted
      // trailer outside the untrusted block -- see the collapse below -- and a
      // delivery is recorded when the tool OFFERS one, not when a consumer
      // places it. `browser_navigate` always takes a card (authority/
      // ui-intent.ts) and an inline approval comes through here too
      // (orchestrator.ts), so every approved navigation was recording a playbook
      // it then disclaimed, and the chat model's own snapshot got nothing for
      // the next 30 minutes.
      //
      // SAID PLAINLY, because it changes what the model sees: `browser_navigate`
      // now delivers no playbook at all, and the playbook arrives with the first
      // `browser_snapshot` instead (which takes no card, so it can place the
      // trailer outside the block). What is given up is a copy the model was
      // told to distrust; what is gained is that an authoritative copy is still
      // available at all, which is what burning the slot used to cost.
      const raw = await withoutTemplateDelivery(() => registry.execute(request.tool_name, args));
      // Collapsed to one string: this path records a DB receipt and returns a
      // single value, so it cannot carry a trusted trailer separately. The
      // trailer therefore goes back in band and is framed as data along with the
      // page when the orchestrator frames this result. That loses a site
      // playbook on an approved browser call; what it cannot do is put attacker
      // text OUTSIDE a block, because only trusted code that received a trailer
      // as a trailer ever places one there (roles/untrusted.ts).
      const result = toolReturnText(raw);

      const executionTimeMs = Date.now() - startTime;

      // The receipt: the tool returned.
      //
      // Bounded through `boundedReceiptText` rather than sliced (#609). A tool
      // that frames its own return (`actions/tools/manage-workflow.ts`) hands
      // this path a string whose first lines open a delimited block, and a bare
      // prefix kept the open line while dropping the close -- a block that never
      // terminates, which disclaims whatever the consumer appends after it
      // rather than only its own payload. The helper rewrites the delimiters to
      // their inert spelling instead, so the row keeps the preamble that says
      // the payload is data and carries no boundary at all.
      this.approvalManager.markExecuted(requestId, boundedReceiptText(result, RECEIPT_MAX_CHARS), 'committed');

      // Log to audit trail
      this.logReceipt(request, true, executionTimeMs);

      // Record approval for learning. Two kinds are excluded.
      //
      // Taint-gated: an override the learner would suggest cannot lift a
      // profile gate, so the suggestion would be dead on arrival.
      //
      // Above-level substitutions: the opposite problem, and live rather
      // than dead. A `confirm: 'above_level'` card says "this one call
      // reached a category above this agent's level" -- it is not the
      // person endorsing the category. But `getSuggestions` emits a
      // per-CATEGORY override with no tool and no role, and an override is
      // evaluated BEFORE the level check, so accepting one would auto-allow
      // that category for every tool at every level. `site_delete_file`
      // (#503) makes this concrete: it is an approval on every single call,
      // so five routine project-file deletions would offer to auto-allow
      // `delete_data` everywhere.
      const reason = request.reason ?? '';
      const learnable = !reason.includes(TAINT_PROFILE_LABEL)
        && !reason.includes(ABOVE_LEVEL_SUBSTITUTION);
      if (learnable) {
        this.learner?.recordDecision(
          request.action_category as ActionCategory,
          request.tool_name,
          true
        );
      }

      // Notify
      this.onResult?.(requestId, request, result);

      return { claimed: true, result };
    } catch (err) {
      // RAW, and framed nowhere in this method (#608). This one string has six
      // consumers and only two of them are a model: the row below, the
      // `onResult` notification (which `daemon/index.ts` broadcasts over the
      // dashboard WS and relays to a chat channel), the HTTP body of
      // `/api/authority/approvals/:id/execute`, and the value returned to the
      // orchestrator's inline gate. Framing here put a live per-message nonce
      // and an unterminated block into the first three -- the HTTP route
      // reachably, since `applyExecutionResolution` resolves a restart-orphaned
      // INLINE approval without checking `execution_mode`.
      //
      // So the frame is drawn by the consumer that has a model, and this stays
      // the raw text every other consumer wants. `failed` below is what lets
      // that consumer tell a failure from a success without re-reading the row.
      const errorStr = `Error executing ${request.tool_name}: ${err instanceof Error ? err.message : String(err)}`;
      // The receipt: the tool threw. The call was dispatched, so a partial
      // effect is possible; the row is executed with a failed outcome.
      //
      // Bounded through the same helper as the success receipt above, which also
      // gives this branch a size bound it never had: a thrown message can carry
      // a step name, a remote error or a stderr tail of unbounded length.
      //
      // Unless the tool said what happened (Q-08). Nothing started: the row is
      // blocked, not failed. It may have taken effect: the row keeps the
      // `unknown` outcome a restart gives an interrupted run, so it is never
      // run again and a person checks before closing it.
      const outcome = err instanceof ActionOutcomeError ? err.outcome : null;
      const receipt = boundedReceiptText(errorStr, RECEIPT_MAX_CHARS);
      if (outcome?.effect === 'not_started') {
        this.approvalManager.markExecuted(requestId, receipt, 'blocked');
        this.logReceipt(request, false);
      } else if (outcome?.status === 'unknown') {
        this.approvalManager.markUncertain(requestId, receipt);
        this.logReceipt(request, true);
      } else {
        this.approvalManager.markExecuted(requestId, receipt, 'failed');
        this.logReceipt(request, true);
      }
      this.onResult?.(requestId, request, errorStr);
      return { claimed: true, result: errorStr, failed: true };
    }
  }

  /**
   * Handle a denial — record for learning.
   */
  recordDenial(request: ApprovalRequest): void {
    this.learner?.recordDecision(
      request.action_category as ActionCategory,
      request.tool_name,
      false
    );
  }
}
