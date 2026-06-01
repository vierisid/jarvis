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

/**
 * Events emitted by streamTurn() as the conversation progresses. Lets the
 * caller (agent-service) surface intermediate text - in particular the
 * acknowledgment the conv LLM emits alongside a delegate tool call - to the
 * user immediately, instead of waiting for the slow task tier to finish.
 */
export type ConvStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'task'; event: ConvTaskEvent }
  | { type: 'done'; tasksRun: string[] };

export class ConvOrchestrator {
  private currentUserMessage = '';

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
    let fullText = '';
    const tasksRun: string[] = [];
    for await (const event of this.streamTurn(userMessage, context)) {
      if (event.type === 'text') {
        fullText += (fullText && !fullText.endsWith('\n') ? '\n' : '') + event.text;
      } else if (event.type === 'task') {
        onTaskEvent?.(event.event);
      } else if (event.type === 'done') {
        tasksRun.push(...event.tasksRun);
      }
    }
    return { text: fullText, tasksRun };
  }

  /**
   * Streaming variant of processTurn. Yields each piece of assistant text
   * as it becomes available (acknowledgment alongside a delegate call,
   * then later the verbalization of the result). Task lifecycle events fire
   * via the `onTaskEvent` callback in REAL TIME (not buffered), so the UI
   * can update status pills as `task_started` -> running ms -> `task_completed`
   * rather than getting both events together at task end.
   */
  async *streamTurn(
    userMessage: string,
    context: ConvSystemContext,
    onTaskEvent?: (event: ConvTaskEvent) => void,
  ): AsyncGenerator<ConvStreamEvent> {
    const systemPrompt = this.buildSystemPrompt(context);
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...(context.recentDialogue ?? []),
      { role: 'user', content: userMessage },
    ];

    const tasksRun: string[] = [];
    // Remember the user's verbatim message so we can attach it to every
    // delegate request - the task tier sees what the user actually said,
    // not the conv LLM's paraphrase.
    this.currentUserMessage = userMessage;

    for (let iteration = 0; iteration < MAX_CONV_ITERATIONS; iteration++) {
      const response = await this.llm.chatTier('conversation', 'conv_orchestrator', messages, {
        tools: CONV_TOOLS,
        tool_choice: 'auto',
      });

      // Conv LLM emitted text only (no tool calls) -> final user-facing reply.
      if (!response.tool_calls || response.tool_calls.length === 0) {
        if (response.content) yield { type: 'text', text: response.content };
        yield { type: 'done', tasksRun };
        return;
      }

      // Conv LLM emitted tool calls. If it also wrote any prose (the
      // acknowledgment - "I'm looking into that"), surface it NOW so the
      // user gets immediate feedback before the slow task tier starts.
      if (response.content && response.content.trim().length > 0) {
        yield { type: 'text', text: response.content };
      }

      messages.push({
        role: 'assistant',
        content: response.content ?? '',
        tool_calls: response.tool_calls,
      });

      // Task events go DIRECTLY to the onTaskEvent callback in real time so
      // the UI can update status pills incrementally (started -> elapsed ->
      // completed). Each event is snapshotted at the moment it fires so
      // later record mutations don't mutate historical event payloads.
      const captureEvent = (event: ConvTaskEvent) => {
        if (!onTaskEvent) return;
        // Shallow snapshot of the record so status/updatedAt at this moment
        // are preserved when the listener reads them later. The request
        // object is immutable in practice; preserved by reference.
        const snapshot = { ...event.record };
        onTaskEvent({ ...event, record: snapshot } as ConvTaskEvent);
      };

      for (const call of response.tool_calls) {
        const result = await this.handleToolCall(call, captureEvent);
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
    yield {
      type: 'text',
      text: 'I got stuck routing your request. Could you rephrase or try again?',
    };
    yield { type: 'done', tasksRun };
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
          // Attach the user's verbatim message so the task tier sees what
          // the user actually said, not the conv LLM's paraphrase.
          original_message: this.currentUserMessage || undefined,
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
        const args = call.arguments as { task_id?: string; input?: string };
        if (!args.task_id || !args.input) {
          return { envelope: { error: 'resume_task requires task_id and input' } };
        }
        const targetId = args.task_id;
        // Subscribe to registry transitions so the UI sees `task_started`
        // when the resume re-enters the running state (mirrors delegate's
        // intermediate-event behavior). Filter by task_id so we only fire
        // for OUR task even if other tasks transition concurrently.
        const unsub = this.registry.subscribe((rec) => {
          if (rec.id === targetId && rec.status === 'running') {
            onTaskEvent?.({ type: 'task_started', record: rec });
          }
        });
        try {
          const envelope = await this.dispatcher.resume(targetId, args.input);
          const rec = this.registry.get(envelope.task_id);
          if (rec) {
            if (envelope.status === 'completed') {
              onTaskEvent?.({ type: 'task_completed', record: rec, envelope });
            } else if (envelope.status === 'failed') {
              onTaskEvent?.({ type: 'task_failed', record: rec, envelope });
            } else if (envelope.status === 'cancelled') {
              onTaskEvent?.({ type: 'task_cancelled', record: rec, envelope });
            }
            // needs_input again - the task paused with a SECOND question. The
            // conv LLM will see this envelope and ask again. The registry
            // transition already fired through the subscription above (the
            // task went running -> needs_input).
          }
          return { envelope, taskId: envelope.task_id };
        } finally {
          unsub();
        }
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
      'You are the conversation layer. You own dialogue tone and routing decisions. ' +
      'You do NOT do real work yourself. For anything beyond small talk, you call the ' +
      '`delegate` tool to send the work to a task tier that has access to all of Jarvis\'s ' +
      'real tools (workflows, browser, file ops, vault, calendar, commitments, goals, etc.).',
    );
    parts.push('');

    parts.push('# CRITICAL: You have NO direct knowledge of Jarvis state');
    parts.push(
      'You do not know what workflows exist, what files are in the vault, what commitments ' +
      'are scheduled, what goals are active, what was built earlier, what the user\'s ' +
      'calendar looks like, or any other live state. The chat history shows what was ' +
      'discussed, NOT what is true. To answer any question about real state, you MUST ' +
      'delegate so the task tier can look it up with tools.',
    );
    parts.push('');
    parts.push('Examples of questions you MUST delegate (not answer from your own knowledge):');
    parts.push('- "What workflows do I have?"');
    parts.push('- "What pieces are in the workflow we just made?"');
    parts.push('- "What did you just create?" / "Show me the steps"');
    parts.push('- "What\'s on my calendar today?"');
    parts.push('- "Read me the latest research notes"');
    parts.push('- Anything asking for SPECIFICS about real state, even if the result envelope summary mentioned it briefly');
    parts.push('');
    parts.push(
      'It IS fine to ask the user for clarifying info when something is genuinely ' +
      'ambiguous (e.g., which person they mean by "Sarah"). Just don\'t use ' +
      'clarification as a way to dodge delegating something the tools could answer.',
    );
    parts.push('');

    parts.push('# Delegation Catalog');
    parts.push('Use the `delegate` tool when:');
    parts.push('- The user asks you to FIND or LOOK UP something - tier=medium, template=research');
    parts.push('- The user asks about real Jarvis state (workflows, files, vault, calendar) - tier=medium, template=general');
    parts.push('- The user asks you to WRITE or REFACTOR code - tier=medium, template=code');
    parts.push('- The user asks for a PLAN, schedule, or decomposition - tier=high, template=plan');
    parts.push('- The user asks to DRAFT prose (email, doc, summary) - tier=medium, template=write');
    parts.push('- The user asks for complex multi-step reasoning - tier=high, template=general');
    parts.push('- Anything needing real tool execution or live state lookup - tier=medium, template=general');
    parts.push('');
    parts.push("Do NOT delegate when:");
    parts.push('- The user is making small talk (greeting, thanks, mood)');
    parts.push('- The user is clarifying or cancelling an in-flight task (use check_task / cancel_task)');
    parts.push('- The user asks who you are / what you can do / how Jarvis works (general capabilities, not specifics)');
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

    // Last task results - shown in full so the conv LLM has the IDs/names
    // it needs to verbalize follow-ups. Even with the full summary, ANY
    // request for specifics not already in the summary MUST be delegated
    // (see "CRITICAL: You have NO direct knowledge" above).
    const recent = this.registry.recentResults(5);
    if (recent.length > 0) {
      parts.push('# Recent Task Results');
      for (const t of recent) {
        if (!t.result) continue;
        parts.push(`## Task ${t.id} - ${t.request.template} (${t.status})`);
        parts.push(`User asked: ${t.request.intent}`);
        parts.push(`Result:`);
        parts.push(t.result.summary);
        parts.push('');
      }
    }

    if (context.ambientFacts) {
      parts.push('# Ambient State');
      parts.push(context.ambientFacts);
      parts.push('');
    }

    parts.push('# Handling paused tasks');
    parts.push(
      'When the `delegate` tool returns an envelope with `status: "needs_input"`, ' +
      'the task tier paused because it needs more info from the user. The envelope ' +
      'has a `needs_input.question` field with the specific question. You should:',
      '1. Ask the user that exact question (verbalize it naturally; don\'t change the meaning).',
      '2. When the user replies, call `resume_task` with the task_id and the user\'s reply ' +
      '   as `input`. Do NOT delegate again - resume reuses the work the task tier already did.',
      '3. The resume returns a new envelope - completed, failed, or another needs_input (if ' +
      '   the task needs another round of clarification).',
      '',
    );

    parts.push('# Style');
    parts.push(
      'Speak naturally and concisely.',
      '',
      'IMPORTANT - acknowledgment while delegating:',
      'When you call the `delegate` tool, you MUST also output a short, ' +
      'context-aware acknowledgment sentence in the same response (alongside ' +
      'the tool call). The user sees this immediately while the task runs ' +
      'in the background, so it should be specific to what they asked - not ' +
      'a generic "working on it". Examples:',
      '- For research: "Pulling up the top CRMs for solo founders now - one moment."',
      '- For code: "Let me read the file first and figure out where to make the change."',
      '- For planning: "I\'ll sketch out the workflow steps - back shortly with a plan."',
      '',
      'IMPORTANT - verbalizing task results:',
      'When a task completes you receive a result envelope with a `summary`. ' +
      'Your verbalization MUST be faithful to that summary - report what the ' +
      'task tier actually did/found, not what you think the answer should be. ' +
      'Do NOT substitute your own knowledge. Do NOT invent details that aren\'t ' +
      'in the summary. If the summary mentions Jarvis features (workflows, ' +
      'commitments, goals), say so - do not suggest generic alternatives like ' +
      '"you could write a Python script" when the task already used a Jarvis ' +
      'tool. If the task failed or returned poor output, tell the user briefly ' +
      'and offer to retry rather than papering over it with your own guess.',
    );

    return parts.join('\n');
  }
}
