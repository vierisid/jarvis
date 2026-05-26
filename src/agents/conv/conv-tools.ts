/**
 * Conversation-tier tool surface.
 *
 * The conversation LLM sees a small set of "tools" it can call to drive the
 * task tiers. These are NOT registered in the global ToolRegistry - they're
 * intercepted locally by the conv orchestrator and never reach the agent's
 * full tool set. The conv LLM's job is to route, not to do.
 *
 * Tools exposed:
 *   - delegate          - send work to a task tier (returns task_id)
 *   - check_task        - get the current status of an in-flight task
 *   - cancel_task       - abort a running task
 *   - resume_task       - provide clarification to a task in `needs_input`
 *
 * Conversation also has direct knowledge of in-flight tasks via the system
 * prompt's "In-flight tasks" section, so it doesn't need to "discover" what's
 * running - it just decides what to do about it.
 */

import type { LLMTool } from '../../llm/provider.ts';

export const CONV_TOOLS: LLMTool[] = [
  {
    name: 'delegate',
    description:
      "Delegate work to a task tier. Use this when the user's request needs real action (research, code, planning, writing, tool execution). The task tier will run with its own tools and return a result envelope you can verbalize to the user. Pick the smallest tier that can handle the work: low for trivial extraction/classification, medium for general tool work, high for complex multi-step reasoning. Returns a task_id you can reference for status checks. Fold any constraints (budget, tone, format, scope) directly into the `intent` sentence.",
    parameters: {
      type: 'object',
      required: ['tier', 'template', 'intent'],
      properties: {
        tier: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Which task tier should run this. Default to "medium" unless you have a clear reason.',
        },
        template: {
          type: 'string',
          enum: ['research', 'code', 'plan', 'write', 'general'],
          description: 'Functional category of the task. Picks a focused system prompt for the task tier.',
        },
        intent: {
          type: 'string',
          description: 'One-line goal sentence the task tier sees first. Be specific. Include any constraints (budget, tone, scope, format) inline rather than passing them separately.',
        },
      },
    },
  },
  {
    name: 'check_task',
    description:
      'Get the current status snapshot of a previously-delegated task. Use this when the user asks "how is X going?" without delegating again.',
    parameters: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string', description: 'The task id returned from a previous delegate call.' },
      },
    },
  },
  {
    name: 'cancel_task',
    description:
      'Abort a running task. Use this when the user says "stop", "never mind", or clearly wants the task discontinued. The task tier will halt at its next checkpoint.',
    parameters: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string', description: 'The task id to cancel.' },
      },
    },
  },
  {
    name: 'resume_task',
    description:
      'Provide clarification to a task that paused in needs_input state. The task tier will continue with the new input.',
    parameters: {
      type: 'object',
      required: ['task_id', 'input'],
      properties: {
        task_id: { type: 'string' },
        input: { type: 'string', description: 'The clarification text to feed back to the task tier.' },
      },
    },
  },
];

/**
 * Canonical names exposed for type-safe dispatch.
 */
export const CONV_TOOL_NAMES = {
  delegate: 'delegate',
  check_task: 'check_task',
  cancel_task: 'cancel_task',
  resume_task: 'resume_task',
} as const;
export type ConvToolName = (typeof CONV_TOOL_NAMES)[keyof typeof CONV_TOOL_NAMES];
