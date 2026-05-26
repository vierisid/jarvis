/**
 * TaskDispatcher - executes a TaskRequest by routing it through a runner
 * callback supplied by the AgentService. The runner is the primary
 * orchestrator path so the task gets the FULL tool registry, role prompt,
 * authority gating, and Jarvis-specific feature knowledge - just on the
 * requested tier instead of the default medium.
 *
 * Why a callback instead of calling chatTier directly: the original Phase 4
 * dispatcher did a single tool-less LLM call, which left task tiers with no
 * Jarvis context (couldn't manage workflows, no tools, no role). Routing
 * through the orchestrator fixes that without duplicating the orchestrator's
 * loop + tool-registry plumbing here.
 */

import type { LLMManager } from '../../llm/manager.ts';
import type { TaskRequest, TaskRecord, TaskResultEnvelope, TaskTemplate } from './task-envelope.ts';
import type { TaskRegistry } from './task-registry.ts';

const SUMMARY_THRESHOLD_CHARS = 1500;

const TEMPLATE_PROMPTS: Record<TaskTemplate, string> = {
  research: `[TASK TEMPLATE: RESEARCH] Focus on gathering information from your tools (web, vault, docs). Stay on the user's intent. Cite sources where it matters. End with a clear conclusion the conversation agent can quote.`,
  code: `[TASK TEMPLATE: CODE] Read existing code first when needed. Write clean, minimal changes. Run tests or builds if available. End with a brief plain-English summary (file paths, key changes).`,
  plan: `[TASK TEMPLATE: PLAN] Decompose the intent into concrete steps with clear ownership and rough effort. Identify dependencies and risks. Output a structured plan.`,
  write: `[TASK TEMPLATE: WRITE] Draft prose matching the requested format and audience. Prefer clarity over flourish. Return only the drafted content plus a one-line note about choices made.`,
  general: `[TASK TEMPLATE: GENERAL] Use your tools to accomplish the user's intent. Stay on scope. End with a brief summary.`,
};

/**
 * Runner signature: given a (tier, subsystem, template-prefixed prompt,
 * abort signal), execute the work and return the final text the task
 * produced. The AgentService implements this by invoking the primary
 * orchestrator's processMessage with the requested tier - which gives the
 * task tier full access to the role's tools and Jarvis-specific knowledge.
 */
export type TaskRunner = (args: {
  tier: TaskRequest['tier'];
  subsystem: string;
  template: TaskTemplate;
  intent: string;
  signal: AbortSignal;
}) => Promise<string>;

export type DispatchOptions = {
  /** Optional channel hint for logging. */
  channel?: string;
};

export class TaskDispatcher {
  constructor(
    private readonly llm: LLMManager,
    private readonly registry: TaskRegistry,
    private readonly runner: TaskRunner,
  ) {}

  /**
   * Run a task and return its result envelope. The task transitions through
   * queued -> running -> completed/failed/cancelled. Registry subscribers
   * see each transition so the conv orchestrator can surface UI events.
   */
  async dispatch(request: TaskRequest, _opts?: DispatchOptions): Promise<TaskResultEnvelope> {
    const subsystem = `task_${request.template}`;
    const record = this.registry.create(request, subsystem);
    const abort = new AbortController();
    this.registry.setAbortController(record.id, abort);
    this.registry.transition(record.id, 'running');

    if (abort.signal.aborted) {
      return this.finalize(record, 'cancelled', 'Task cancelled before it could start.');
    }

    try {
      const rawResult = await this.runner({
        tier: request.tier,
        subsystem,
        template: request.template,
        intent: request.intent,
        signal: abort.signal,
      });

      if (abort.signal.aborted) {
        return this.finalize(record, 'cancelled', 'Task cancelled during execution.');
      }

      const summary = await this.summarize(record, request, rawResult);
      return this.finalize(record, 'completed', summary, record.id);
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

  /**
   * Produce a compact summary the conv LLM can verbalize. Short outputs are
   * passed through; long outputs are condensed via the low tier (cheap) so
   * the conv prompt doesn't carry the full transcript each verbalize call.
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
      return trimmed.slice(0, 400) + (trimmed.length > 400 ? '...' : '');
    }
  }

  /**
   * Public so AgentService can build the runner-side prompt the same way the
   * dispatcher does. Kept in sync with TEMPLATE_PROMPTS.
   */
  static templatePromptFor(template: TaskTemplate): string {
    return TEMPLATE_PROMPTS[template];
  }

  private finalize(record: TaskRecord, status: 'completed' | 'cancelled', summary: string, detailsRef?: string): TaskResultEnvelope {
    const envelope: TaskResultEnvelope = {
      task_id: record.id,
      status,
      summary,
      ...(detailsRef ? { details_ref: detailsRef } : {}),
    };
    this.registry.transition(record.id, status, envelope);
    return envelope;
  }
}
