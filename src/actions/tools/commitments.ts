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
    'Track tasks and commitments: one-off things to be done, each with a due date and a status.',
    'For OKR-style goals with a hierarchy and scoring, use manage_goals instead.',
  ].join('\n'),
  category: 'tasks',
  parameters: {
    action: {
      type: 'string',
      description: 'What to do.',
      enum: ['list', 'get', 'create', 'update_status', 'set_due'],
      required: true,
    },
    id: {
      type: 'string',
      description: 'Commitment id; required for get/update_status/set_due.',
      required: false,
    },
    what: {
      type: 'string',
      description: 'Task description; required for create.',
      required: false,
    },
    when_due: {
      type: 'string',
      description: 'Due date, ISO 8601 (e.g. "2026-02-28T14:00:00"); "null" clears it.',
      required: false,
    },
    priority: {
      type: 'string',
      description: 'low, normal, high, critical. Also filters list.',
      required: false,
    },
    context: {
      type: 'string',
      description: 'Extra context for the task.',
      required: false,
    },
    assigned_to: {
      type: 'string',
      description: 'Assignee, e.g. "jarvis" or "user". Also filters list.',
      required: false,
    },
    status: {
      type: 'string',
      description: 'New status for update_status: pending, active, completed, failed, escalated.',
      required: false,
    },
    result: {
      type: 'string',
      description: 'Result text, for update_status when completing or failing.',
      required: false,
    },
    filter_status: {
      type: 'string',
      description: 'Filter list by status.',
      required: false,
    },
    filter_overdue: {
      type: 'string',
      description: '"true" lists only overdue commitments.',
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
