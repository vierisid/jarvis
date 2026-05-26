/**
 * Conversation-tier orchestrator.
 *
 * The router-first architecture activates when `llm.tiers.conversation` is
 * configured. This orchestrator handles user turns by:
 *
 *   1. Building a TIGHT system prompt for the conversation LLM (persona +
 *      user identity + recent dialogue + delegation catalog + in-flight
 *      tasks + last task results). NO knowledge graph dump, NO 4k role
 *      prompt - that's what task tiers see.
 *   2. Calling the conversation tier with the CONV_TOOLS surface (delegate,
 *      check_task, cancel_task, resume_task).
 *   3. When conv emits a delegate tool call, dispatching it to the task
 *      tier via TaskDispatcher and feeding the envelope back as a tool
 *      result.
 *   4. Looping until conv produces final text for the user.
 *
 * Status pills / streaming filler / UI affordances are surfaced by the caller
 * via the optional `onTaskEvent` hook (the daemon's WS service uses this).
 */

import type { LLMManager } from '../../llm/manager.ts';
import type { LLMMessage, LLMToolCall } from '../../llm/provider.ts';
import { CONV_TOOLS, CONV_TOOL_NAMES } from './conv-tools.ts';
import { TaskDispatcher } from './task-dispatcher.ts';
import { TaskRegistry } from './task-registry.ts';
import type { TaskRecord, TaskRequest, TaskResultEnvelope } from './task-envelope.ts';

const MAX_CONV_ITERATIONS = 8;

export type ConvSystemContext = {
  /** User persona (name, timezone, role, etc.) - short identity block. */
  userIdentity?: string;
  /** Last N dialogue turns from the persistent conversation - verbatim. */
  recentDialogue?: LLMMessage[];
  /** Optional extra grounding the conv LLM should always see (e.g., active commitments count). */
  ambientFacts?: string;
};

export type ConvTaskEvent =
  | { type: 'task_started'; record: TaskRecord }
  | { type: 'task_completed'; record: TaskRecord; envelope: TaskResultEnvelope }
  | { type: 'task_failed'; record: TaskRecord; envelope: TaskResultEnvelope }
  | { type: 'task_cancelled'; record: TaskRecord; envelope: TaskResultEnvelope };

export type ConvProcessResult = {
  text: string;
  tasksRun: string[];   // task ids that fired during this turn
};

export class ConvOrchestrator {
  constructor(
    private readonly llm: LLMManager,
    private readonly registry: TaskRegistry,
    private readonly dispatcher: TaskDispatcher,
    private readonly persona: string,
  ) {}

  /**
   * Process one user turn. Returns the conversation LLM's final user-facing
   * text plus the ids of any tasks that fired during the turn. Caller is
   * responsible for persisting the user/assistant messages to the vault.
   */
  async processTurn(
    userMessage: string,
    context: ConvSystemContext,
    onTaskEvent?: (event: ConvTaskEvent) => void,
  ): Promise<ConvProcessResult> {
    const systemPrompt = this.buildSystemPrompt(context);
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...(context.recentDialogue ?? []),
      { role: 'user', content: userMessage },
    ];

    const tasksRun: string[] = [];

    for (let iteration = 0; iteration < MAX_CONV_ITERATIONS; iteration++) {
      const response = await this.llm.chatTier('conversation', 'conv_orchestrator', messages, {
        tools: CONV_TOOLS,
        tool_choice: 'auto',
      });

      // Conv LLM emitted text only (no tool calls) -> final user-facing reply.
      if (!response.tool_calls || response.tool_calls.length === 0) {
        return { text: response.content ?? '', tasksRun };
      }

      // Conv LLM emitted tool calls. Record the assistant message (with tool
      // calls) so the next iteration sees what was decided, then handle each
      // call and append the tool results.
      messages.push({
        role: 'assistant',
        content: response.content ?? '',
        tool_calls: response.tool_calls,
      });

      for (const call of response.tool_calls) {
        const result = await this.handleToolCall(call, onTaskEvent);
        if (result.taskId) tasksRun.push(result.taskId);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result.envelope),
        });
      }
    }

    // Hit the iteration cap - bail with whatever the last response said,
    // or a generic fallback.
    return {
      text: 'I got stuck routing your request. Could you rephrase or try again?',
      tasksRun,
    };
  }

  private async handleToolCall(
    call: LLMToolCall,
    onTaskEvent?: (event: ConvTaskEvent) => void,
  ): Promise<{ envelope: unknown; taskId?: string }> {
    switch (call.name) {
      case CONV_TOOL_NAMES.delegate: {
        const args = call.arguments as Partial<TaskRequest>;
        if (!args.tier || !args.template || !args.intent) {
          return { envelope: { error: 'delegate requires tier, template, and intent' } };
        }
        const request: TaskRequest = {
          tier: args.tier,
          template: args.template,
          intent: args.intent,
          constraints: args.constraints,
          context: args.context,
        };

        // Dispatch produces a result envelope. We notify the caller as the
        // task moves through its lifecycle via the registry subscription.
        const unsub = this.registry.subscribe(rec => {
          if (rec.status === 'running' && rec.id) {
            onTaskEvent?.({ type: 'task_started', record: rec });
          }
        });
        try {
          const envelope = await this.dispatcher.dispatch(request);
          const rec = this.registry.get(envelope.task_id);
          if (rec) {
            if (envelope.status === 'completed') {
              onTaskEvent?.({ type: 'task_completed', record: rec, envelope });
            } else if (envelope.status === 'failed') {
              onTaskEvent?.({ type: 'task_failed', record: rec, envelope });
            } else if (envelope.status === 'cancelled') {
              onTaskEvent?.({ type: 'task_cancelled', record: rec, envelope });
            }
          }
          return { envelope, taskId: envelope.task_id };
        } finally {
          unsub();
        }
      }

      case CONV_TOOL_NAMES.check_task: {
        const id = (call.arguments as { task_id?: string }).task_id;
        if (!id) return { envelope: { error: 'check_task requires task_id' } };
        const rec = this.registry.get(id);
        if (!rec) return { envelope: { error: `task ${id} not found` } };
        return {
          envelope: {
            task_id: rec.id,
            status: rec.status,
            elapsed_ms: Date.now() - rec.startedAt,
            summary: rec.result?.summary ?? null,
          },
        };
      }

      case CONV_TOOL_NAMES.cancel_task: {
        const id = (call.arguments as { task_id?: string }).task_id;
        if (!id) return { envelope: { error: 'cancel_task requires task_id' } };
        const ok = this.registry.abort(id);
        return { envelope: { task_id: id, cancelled: ok } };
      }

      case CONV_TOOL_NAMES.resume_task: {
        // Phase 4 stub: the task tier doesn't yet support pause/resume mid-stream.
        // Returning an error tells the conv LLM to handle the clarification
        // by issuing a fresh delegate with the new context instead.
        return {
          envelope: {
            error: 'resume_task is not yet supported - issue a fresh delegate with the clarified intent instead.',
          },
        };
      }

      default:
        return { envelope: { error: `unknown tool: ${call.name}` } };
    }
  }

  /**
   * Build the conversation tier's tight system prompt. Goal: keep it under
   * ~1500 tokens (persona + identity + delegation catalog + in-flight tasks
   * + last result summaries). The task tiers see the heavy context separately.
   */
  private buildSystemPrompt(context: ConvSystemContext): string {
    const parts: string[] = [];

    parts.push('# Persona');
    parts.push(this.persona);
    parts.push('');

    if (context.userIdentity) {
      parts.push('# User');
      parts.push(context.userIdentity);
      parts.push('');
    }

    parts.push('# Your Role');
    parts.push(
      'You are the conversation layer. You own dialogue and routing. ' +
      'For anything that needs real action (research, code, planning, writing, tool use), ' +
      'call the `delegate` tool to send it to a task tier. The task tier runs with its own ' +
      'tools and returns a structured envelope you can verbalize to the user. ' +
      'Handle small talk, follow-ups, clarifications, and routing decisions yourself.',
    );
    parts.push('');

    parts.push('# Delegation Catalog');
    parts.push('Use the `delegate` tool when:');
    parts.push('- The user asks you to FIND or LOOK UP something - tier=medium, template=research');
    parts.push('- The user asks you to WRITE or REFACTOR code - tier=medium, template=code');
    parts.push('- The user asks for a PLAN, schedule, or decomposition - tier=high, template=plan');
    parts.push('- The user asks to DRAFT prose (email, doc, summary) - tier=medium, template=write');
    parts.push('- The user asks for complex multi-step reasoning - tier=high, template=general');
    parts.push('- Anything else needing real tool execution - tier=medium, template=general');
    parts.push('');
    parts.push("Do NOT delegate when:");
    parts.push('- The user is making small talk');
    parts.push('- The user is asking a follow-up about a recently-completed task (you have the summary)');
    parts.push('- The user is clarifying or cancelling a task (use check_task / cancel_task)');
    parts.push("- You already know the answer from this session's context");
    parts.push('');

    // In-flight tasks
    const inFlight = this.registry.inFlight();
    if (inFlight.length > 0) {
      parts.push('# In-flight Tasks');
      for (const t of inFlight) {
        const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
        parts.push(`- ${t.id} (${t.status}, ${elapsed}s, ${t.request.template}): ${t.request.intent}`);
      }
      parts.push('');
    }

    // Last task results
    const recent = this.registry.recentResults(3);
    if (recent.length > 0) {
      parts.push('# Recent Task Results');
      for (const t of recent) {
        if (!t.result) continue;
        parts.push(`- ${t.id} (${t.status}): ${t.result.summary}`);
      }
      parts.push('');
    }

    if (context.ambientFacts) {
      parts.push('# Ambient State');
      parts.push(context.ambientFacts);
      parts.push('');
    }

    parts.push('# Style');
    parts.push(
      'Speak naturally and concisely. When you delegate, briefly acknowledge ' +
      'what you\'re looking into before the tool call so the user knows you understood. ' +
      'When a task completes, verbalize the summary in your own voice - don\'t paste raw output.',
    );

    return parts.join('\n');
  }
}
