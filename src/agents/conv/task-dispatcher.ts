/**
 * TaskDispatcher - executes a TaskRequest on the appropriate task tier and
 * returns a TaskResultEnvelope for the conversation LLM to verbalize.
 *
 * This is the conv-tier's "task runner". It does NOT itself call any LLM
 * decision-making code beyond the single chatTier invocation for the task
 * payload - the conv LLM has already decided what to delegate and how. The
 * dispatcher's job is to:
 *   1. Build a focused system prompt from the TaskTemplate.
 *   2. Invoke the task tier with the user's intent + constraints + context.
 *   3. Summarize the task tier's response into a TaskResultEnvelope.
 *
 * Summarization runs on the `low` tier (cheap, structured output) when the
 * task tier's response is long, to keep the conv LLM's verbalize step from
 * paying for the full transcript on every turn.
 */

import type { LLMManager } from '../../llm/manager.ts';
import type { LLMMessage } from '../../llm/provider.ts';
import type { TaskRequest, TaskRecord, TaskResultEnvelope, TaskTemplate } from './task-envelope.ts';
import type { TaskRegistry } from './task-registry.ts';

const SUMMARY_THRESHOLD_CHARS = 1500;

const TEMPLATE_PROMPTS: Record<TaskTemplate, string> = {
  research: `You are executing a focused RESEARCH task. Gather information from your tools (web search, vault, docs). Stay focused on the user's intent. Cite sources where it matters. End your response with a clear conclusion the conversation agent can quote to the user.`,
  code: `You are executing a focused CODE task. Read existing code first when needed. Write clean, minimal changes. Run tests or builds if available. End with a brief plain-English summary of what you did (file paths, key changes) so the conversation agent can report it to the user.`,
  plan: `You are executing a focused PLANNING task. Decompose the intent into concrete steps with clear ownership and rough effort. Identify dependencies and risks. Output a structured plan the conversation agent can present to the user.`,
  write: `You are executing a focused WRITING task. Draft prose matching the requested format and audience. Prefer clarity over flourish. Return only the drafted content plus a one-line note about choices made (tone, length).`,
  general: `You are executing a focused task for the user. Use your tools to accomplish the intent. Stay on scope. End with a brief summary the conversation agent can quote.`,
};

export type DispatchOptions = {
  /** Optional channel hint for logging. */
  channel?: string;
};

export class TaskDispatcher {
  constructor(
    private readonly llm: LLMManager,
    private readonly registry: TaskRegistry,
  ) {}

  /**
   * Run a task and return its result envelope. The task transitions through
   * queued -> running -> completed/failed/cancelled. The conv LLM is
   * expected to be notified via the registry's subscribe() hook so it can
   * re-invoke itself when the result lands.
   */
  async dispatch(request: TaskRequest, opts?: DispatchOptions): Promise<TaskResultEnvelope> {
    const subsystem = `task_${request.template}`;
    const record = this.registry.create(request, subsystem);
    const abort = new AbortController();
    this.registry.setAbortController(record.id, abort);
    this.registry.transition(record.id, 'running');

    if (abort.signal.aborted) {
      const envelope: TaskResultEnvelope = {
        task_id: record.id,
        status: 'cancelled',
        summary: 'Task cancelled before it could start.',
      };
      this.registry.transition(record.id, 'cancelled', envelope);
      return envelope;
    }

    try {
      const taskMessages = this.buildTaskMessages(request);
      const response = await this.llm.chatTier(
        request.tier,
        subsystem,
        taskMessages,
        { temperature: 0.2 },
      );

      if (abort.signal.aborted) {
        const envelope: TaskResultEnvelope = {
          task_id: record.id,
          status: 'cancelled',
          summary: 'Task cancelled during execution.',
        };
        this.registry.transition(record.id, 'cancelled', envelope);
        return envelope;
      }

      const rawResult = response.content ?? '';
      const summary = await this.summarize(record, request, rawResult);

      const envelope: TaskResultEnvelope = {
        task_id: record.id,
        status: 'completed',
        summary,
        details_ref: record.id,
      };
      this.registry.transition(record.id, 'completed', envelope);
      return envelope;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const envelope: TaskResultEnvelope = {
        task_id: record.id,
        status: 'failed',
        summary: `Task failed: ${errorMsg.slice(0, 200)}`,
        error: errorMsg,
      };
      this.registry.transition(record.id, 'failed', envelope);
      return envelope;
    }
  }

  private buildTaskMessages(request: TaskRequest): LLMMessage[] {
    const systemParts: string[] = [TEMPLATE_PROMPTS[request.template]];
    if (request.constraints && request.constraints.length > 0) {
      systemParts.push('', 'Constraints:');
      for (const c of request.constraints) systemParts.push(`- ${c}`);
    }
    if (request.context) {
      systemParts.push('', 'Context:', request.context);
    }
    return [
      { role: 'system', content: systemParts.join('\n') },
      { role: 'user', content: request.intent },
    ];
  }

  /**
   * Produce a compact summary the conv LLM can verbalize. For short task
   * outputs we pass the raw result through. For long outputs we condense
   * via the low tier (cheap) so the conv-tier prompt doesn't carry the full
   * transcript.
   */
  private async summarize(record: TaskRecord, request: TaskRequest, rawResult: string): Promise<string> {
    const trimmed = rawResult.trim();
    if (!trimmed) return 'Task produced no output.';
    if (trimmed.length <= SUMMARY_THRESHOLD_CHARS) return trimmed;

    try {
      const condensed = await this.llm.chatTier('low', 'task_summarize', [
        {
          role: 'system',
          content: `Condense the following task result into 2-4 plain sentences a conversational assistant could read to the user. Preserve concrete facts (names, numbers, file paths). Drop preamble and meta-commentary.`,
        },
        {
          role: 'user',
          content: `User asked: ${request.intent}\n\nTask result:\n${trimmed}`,
        },
      ], { temperature: 0.1, max_tokens: 400 });
      return condensed.content?.trim() || trimmed.slice(0, 400);
    } catch {
      // Summarization is best-effort. Fall back to a head slice so the conv
      // LLM still has something to verbalize.
      return trimmed.slice(0, 400) + (trimmed.length > 400 ? '...' : '');
    }
  }
}
