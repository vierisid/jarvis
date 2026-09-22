/**
 * `request_approval` — the intent-declaration tool.
 *
 * The LLM must call this BEFORE performing any gated semantic action
 * (sending email/messages, payments, installs, destructive file ops,
 * destructive shell commands, terminating agents). The tool creates
 * an ApprovalRequest, broadcasts it to the dashboard and external
 * channels, then blocks until the user decides.
 *
 * This closes the gap left by tool-level authority checks: the LLM
 * could always bypass tool-name-based gating by driving browser/
 * desktop tools to accomplish the same action. Intent-level gating
 * makes the LLM responsible for declaring what it is about to do,
 * regardless of which low-level tools it chooses.
 *
 * The orchestrator short-circuits the authority check for this
 * specific tool (it IS the authority mechanism — gating it would
 * cause recursion).
 */

import type { ActionCategory } from '../../roles/authority.ts';
import type { ApprovalDelivery } from '../../authority/approval-delivery.ts';
import type { ApprovalManager } from '../../authority/approval.ts';
import { AUTHORITY_REQUIREMENTS } from '../../roles/authority.ts';
import type { ToolDefinition } from './registry.ts';

const VALID_CATEGORIES = new Set<ActionCategory>(
  Object.keys(AUTHORITY_REQUIREMENTS) as ActionCategory[],
);

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface RequestApprovalDeps {
  approvalManager: ApprovalManager;
  approvalDelivery: ApprovalDelivery;
  /** Returns the agent that is currently executing tools (primary agent). */
  getCurrentAgent: () => { id: string; name: string } | null;
  /** Override the wait timeout (mostly for tests). */
  timeoutMs?: number;
}

export function createRequestApprovalTool(deps: RequestApprovalDeps): ToolDefinition {
  return {
    name: 'request_approval',
    category: 'authority',
    description:
      `Request the user's explicit approval BEFORE performing a gated action ` +
      `(see action_category for the list). Blocks until they decide.\n\n` +
      `This applies REGARDLESS of which low-level tools you plan to use. ` +
      `If you plan to click the Send button in a Gmail compose window via browser_click, ` +
      `call request_approval with action_category='send_email' FIRST. ` +
      `Do NOT write "APPROVAL REQUIRED" messages yourself - always use this tool.\n\n` +
      `Returns one of:\n` +
      `  [APPROVED] proceed with the action now.\n` +
      `  [DENIED]   STOP. Tell the user the action was blocked.\n` +
      `  [EXPIRED]  no answer in time. Ask them directly before proceeding.\n\n` +
      `Not for read-only actions (reading files, browsing info pages, running ls).`,
    parameters: {
      action_category: {
        type: 'string',
        description:
          'One of: send_email, send_message (any channel: Slack, Telegram, Discord, SMS), ' +
          'make_payment (any purchase or subscription), install_software (install, upgrade ' +
          'or removal), modify_settings, delete_data (files, records, any persistent state), ' +
          'execute_command (a shell command that MUTATES state: git push, rm, npm install), ' +
          'terminate_agent.',
        required: true,
      },
      intent: {
        type: 'string',
        description:
          'One imperative line saying exactly what you will do, e.g. ' +
          '"Send email to alice@example.com with subject \'Weekly Update\'".',
        required: true,
      },
      context: {
        type: 'string',
        description: 'Optional: why, in 1-2 sentences.',
        required: false,
      },
    },
    execute: async (params) => {
      const category = String(params.action_category ?? '').trim() as ActionCategory;
      const intent = String(params.intent ?? '').trim();
      const context = String(params.context ?? '').trim();

      if (!intent) {
        return `[ERROR] request_approval requires a non-empty intent sentence.`;
      }
      if (!VALID_CATEGORIES.has(category)) {
        return (
          `[ERROR] Invalid action_category '${category}'. ` +
          `Valid values: ${Array.from(VALID_CATEGORIES).join(', ')}.`
        );
      }

      const agent = deps.getCurrentAgent() ?? { id: 'primary', name: 'Jarvis' };
      const urgency: 'urgent' | 'normal' =
        category === 'make_payment' || category === 'delete_data' || category === 'terminate_agent'
          ? 'urgent'
          : 'normal';

      const request = deps.approvalManager.createRequest({
        agentId: agent.id,
        agentName: agent.name,
        toolName: 'request_approval',
        toolArguments: { action_category: category, intent, context },
        actionCategory: category,
        urgency,
        reason: intent,
        context: context || `Intent gate: ${intent}`,
      });

      // Fire-and-forget broadcast to dashboard + external channels.
      deps.approvalDelivery.deliver(request).catch((err) => {
        console.error('[request_approval] delivery error:', err);
      });

      const resolved = await deps.approvalManager.waitForResolution(request.id, {
        timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      switch (resolved.status) {
        case 'approved':
        case 'executed': {
          // Mark executed so the request is visibly resolved (the intent has
          // been "executed" from the authority POV — the actual work follows
          // in subsequent tool calls).
          deps.approvalManager.markExecuted(request.id, 'intent-granted');
          return (
            `[APPROVED] User granted approval for: ${intent}\n` +
            `Proceed with the action now. Do not ask for confirmation again.`
          );
        }
        case 'denied': {
          return (
            `[DENIED] User denied approval for: ${intent}\n` +
            `Do NOT proceed. Tell the user briefly that the action was blocked and stop.`
          );
        }
        case 'expired': {
          return (
            `[EXPIRED] Approval request expired: ${intent}\n` +
            `Ask the user if they still want you to proceed.`
          );
        }
        case 'pending':
        default: {
          return (
            `[PENDING] Timed out waiting for approval on: ${intent}\n` +
            `The request is still pending. Ask the user directly or stop and wait.`
          );
        }
      }
    },
  };
}
