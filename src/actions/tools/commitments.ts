/**
 * Commitments Tool
 *
 * Allows the agent to manage tasks/commitments:
 * list, get, create, update status, set due date.
 */

import type { ToolDefinition } from './registry.ts';
import type { CommitmentPriority, CommitmentStatus } from '../../vault/commitments.ts';
import {
  createCommitment, getCommitment, findCommitments,
  updateCommitmentStatus, updateCommitmentDue, getUpcoming,
} from '../../vault/commitments.ts';

const VALID_STATUSES = ['pending', 'active', 'completed', 'failed', 'escalated'];
const VALID_PRIORITIES = ['low', 'normal', 'high', 'critical'];

export const commitmentsTool: ToolDefinition = {
  name: 'commitments',
  description: [
    'Manage tasks and commitments. Use this to create, update, and track scheduled tasks.',
    '',
    'Actions:',
    '  list          — List commitments, filtered by status/priority/assigned_to/overdue',
    '  get           — Get a single commitment by ID',
    '  create        — Create a new task (required: what. optional: when_due, priority, context, assigned_to)',
    '  update_status — Update a commitment\'s status (pending, active, completed, failed)',
    '  set_due       — Set or clear a commitment\'s due date',
    '',
    'For when_due, use ISO 8601 format (e.g., "2026-02-28T14:00:00") or "null" to clear.',
    'Priorities: low, normal, high, critical',
    'Statuses: pending, active, completed, failed, escalated',
  ].join('\n'),
  category: 'tasks',
  parameters: {
    action: {
      type: 'string',
      description: 'The action: list, get, create, update_status, set_due',
      required: true,
    },
    id: {
      type: 'string',
      description: 'Commitment ID (required for get, update_status, set_due)',
      required: false,
    },
    what: {
      type: 'string',
      description: 'Task description (required for create)',
      required: false,
    },
    when_due: {
      type: 'string',
      description: 'Due date in ISO 8601 format (e.g., "2026-02-28T14:00:00"). Use "null" to clear.',
      required: false,
    },
    priority: {
      type: 'string',
      description: 'Priority: low, normal, high, critical',
      required: false,
    },
    context: {
      type: 'string',
      description: 'Additional context for the task',
      required: false,
    },
    assigned_to: {
      type: 'string',
      description: 'Who the task is assigned to (e.g., "jarvis", "user")',
      required: false,
    },
    status: {
      type: 'string',
      description: 'New status for update_status: pending, active, completed, failed',
      required: false,
    },
    result: {
      type: 'string',
      description: 'Result text (optional, for update_status when completing/failing)',
      required: false,
    },
    filter_status: {
      type: 'string',
      description: 'Filter by status (for list action)',
      required: false,
    },
    filter_overdue: {
      type: 'string',
      description: 'Set to "true" to list only overdue commitments',
      required: false,
    },
  },
  execute: async (params) => {
    const action = params.action as string;

    switch (action) {
      case 'list': {
        const query: { status?: CommitmentStatus; priority?: CommitmentPriority; assigned_to?: string; overdue?: boolean } = {};
        if (params.filter_status) query.status = params.filter_status as CommitmentStatus;
        if (params.priority) query.priority = params.priority as CommitmentPriority;
        if (params.assigned_to) query.assigned_to = params.assigned_to as string;
        if (params.filter_overdue === 'true') query.overdue = true;

        const items = findCommitments(query);
        if (items.length === 0) return 'No commitments found matching the criteria.';
        return items.map(c => {
          const due = c.when_due ? ` (due: ${new Date(c.when_due).toLocaleString()})` : '';
          const assignee = c.assigned_to ? ` [${c.assigned_to}]` : '';
          return `[${c.id}] [${c.priority}] ${c.what}${due} — ${c.status}${assignee}`;
        }).join('\n');
      }

      case 'get': {
        if (!params.id) return 'Error: "id" is required for get action';
        const item = getCommitment(params.id as string);
        if (!item) return `Commitment not found: ${params.id}`;
        return [
          `ID: ${item.id}`,
          `Task: ${item.what}`,
          `Status: ${item.status}`,
          `Priority: ${item.priority}`,
          `Due: ${item.when_due ? new Date(item.when_due).toLocaleString() : 'none'}`,
          `Assigned to: ${item.assigned_to || 'unassigned'}`,
          `Context: ${item.context || 'none'}`,
          `Created: ${new Date(item.created_at).toLocaleString()}`,
          item.completed_at ? `Completed: ${new Date(item.completed_at).toLocaleString()}` : null,
          item.result ? `Result: ${item.result}` : null,
        ].filter(Boolean).join('\n');
      }

      case 'create': {
        if (!params.what) return 'Error: "what" is required for create action';

        let whenDue: number | undefined;
        if (params.when_due && params.when_due !== 'null') {
          const parsed = new Date(params.when_due as string).getTime();
          if (isNaN(parsed)) return `Error: Invalid date format for when_due: "${params.when_due}". Use ISO 8601 (e.g., "2026-02-28T14:00:00")`;
          whenDue = parsed;
        }

        if (params.priority && !VALID_PRIORITIES.includes(params.priority as string)) {
          return `Error: Invalid priority "${params.priority}". Must be: ${VALID_PRIORITIES.join(', ')}`;
        }

        const item = createCommitment(params.what as string, {
          when_due: whenDue,
          priority: (params.priority as CommitmentPriority) || undefined,
          context: params.context as string | undefined,
          assigned_to: params.assigned_to as string | undefined,
          created_from: 'jarvis',
          // P0.2 — the primary agent calls this tool while answering the
          // user, so the row is a direct instruction, not an inference.
          // Without an explicit confidence the executor would treat it as
          // unknown and never auto-execute it. Note the executor's other
          // gates still apply: an `assigned_to` naming a person keeps this
          // announce-only regardless.
          confidence: 1.0,
        });

        const due = item.when_due ? ` — due: ${new Date(item.when_due).toLocaleString()}` : '';
        return `Created commitment: [${item.id}] "${item.what}" (${item.priority})${due}`;
      }

      case 'update_status': {
        if (!params.id) return 'Error: "id" is required for update_status action';
        if (!params.status) return 'Error: "status" is required for update_status action';
        if (!VALID_STATUSES.includes(params.status as string)) {
          return `Error: Invalid status "${params.status}". Must be: ${VALID_STATUSES.join(', ')}`;
        }

        const updated = updateCommitmentStatus(
          params.id as string,
          params.status as CommitmentStatus,
          params.result as string | undefined,
        );
        if (!updated) return `Commitment not found: ${params.id}`;
        return `Updated: [${updated.id}] "${updated.what}" — now ${updated.status}${updated.result ? ` (result: ${updated.result})` : ''}`;
      }

      case 'set_due': {
        if (!params.id) return 'Error: "id" is required for set_due action';

        let whenDue: number | null = null;
        if (params.when_due && params.when_due !== 'null') {
          const parsed = new Date(params.when_due as string).getTime();
          if (isNaN(parsed)) return `Error: Invalid date format: "${params.when_due}". Use ISO 8601 (e.g., "2026-02-28T14:00:00")`;
          whenDue = parsed;
        }

        const updated = updateCommitmentDue(params.id as string, whenDue);
        if (!updated) return `Commitment not found: ${params.id}`;
        const due = updated.when_due ? new Date(updated.when_due).toLocaleString() : 'cleared';
        return `Due date updated: [${updated.id}] "${updated.what}" — due: ${due}`;
      }

      default:
        return `Unknown action: "${action}". Valid actions: list, get, create, update_status, set_due`;
    }
  },
};
