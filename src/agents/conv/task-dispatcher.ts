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

// Raised threshold: short task outputs (workflow creation results, code edit
// summaries, etc.) are typically 1-3K chars and contain IDs/names the conv
// LLM needs to reference later. Pass them through verbatim rather than risk
// the summarizer stripping identifiers.
const SUMMARY_THRESHOLD_CHARS = 3000;

const TOOL_USE_INSTRUCTION = `IMPORTANT: You have access to real tools listed in your context. USE THEM to do the work - do not just describe what someone could do. If the user asked to create a workflow, use the workflow tools. If they asked to browse the web, use the browser. If they asked to read a file, use file-ops. Generic textual answers about "you could write a Python script" or "here is the general approach" are wrong when the right tool exists in your registry.`;

const TEMPLATE_PROMPTS: Record<TaskTemplate, string> = {
  research: `[TASK TEMPLATE: RESEARCH] Gather information using your tools (web search, vault, docs). Stay on the user's intent. Cite sources where it matters. End with a clear conclusion the conversation agent can quote.\n\n${TOOL_USE_INSTRUCTION}`,
  code: `[TASK TEMPLATE: CODE] Read existing code via file-ops first when needed. Write clean, minimal changes. Run tests or builds if available. End with a brief plain-English summary (file paths, key changes).\n\n${TOOL_USE_INSTRUCTION}`,
  plan: `[TASK TEMPLATE: PLAN] Decompose the intent into concrete steps with clear ownership and rough effort. If the plan involves Jarvis features (workflows, commitments, goals, browser, sidecar) call the corresponding tools to inspect what already exists before drafting. Output a structured plan.\n\n${TOOL_USE_INSTRUCTION}`,
  write: `[TASK TEMPLATE: WRITE] Draft prose matching the requested format and audience. Prefer clarity over flourish. Return only the drafted content plus a one-line note about choices made.`,
  general: `[TASK TEMPLATE: GENERAL] Use your tools to accomplish the user's intent. Stay on scope. End with a brief summary.\n\n${TOOL_USE_INSTRUCTION}`,
};

/**
 * Result the runner returns. Either the task completed (text + final
 * conversation buffer for potential re-resume) or it paused awaiting user
 * input via the `ask_for_clarification` tool.
 */
export type TaskRunResult =
  | { kind: 'completed'; text: string; conversation: unknown[] }
  | { kind: 'paused'; question: string; conversation: unknown[] };

/**
 * Runner signature: given a (tier, subsystem, template-prefixed prompt,
 * abort signal), execute the work. The AgentService implements this by
 * invoking the primary orchestrator's `processTaskCall` with the requested
 * tier - which gives the task tier full access to the role's tools, Jarvis
 * knowledge, AND the `ask_for_clarification` tool for pause/resume.
 *
 * On resume, the runner is invoked again with `history` set to the saved
 * conversation buffer and `originalMessage` set to the user's clarification
 * reply. The orchestrator's processTaskCall picks the loop up from there.
 */
export type TaskRunner = (args: {
  tier: TaskRequest['tier'];
  subsystem: string;
  template: TaskTemplate;
  /** Conv LLM's paraphrased intent - used as routing hint / system context. */
  intent: string;
  /** User's verbatim message - this is what the task tier sees as the user prompt. */
  originalMessage: string;
  signal: AbortSignal;
  /** When resuming, the conversation buffer captured at the previous pause. */
  history?: unknown[];
}) => Promise<TaskRunResult>;

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
   * queued -> running -> {needs_input,completed,failed,cancelled}. Registry
   * subscribers see each transition so the conv orchestrator can surface
   * UI events.
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

    return await this.runAndHandle(record, request, subsystem, abort, {
      originalMessage: request.original_message ?? request.intent,
      history: undefined,
    });
  }

  /**
   * Resume a previously-paused task by feeding the user's clarification
   * reply back into the task tier's conversation. Reuses the saved buffer
   * so the LLM continues from where it stopped instead of starting over.
   */
  async resume(taskId: string, userInput: string): Promise<TaskResultEnvelope> {
    const record = this.registry.get(taskId);
    if (!record) {
      return {
        task_id: taskId,
        status: 'failed',
        summary: `Task ${taskId} not found.`,
        error: 'not_found',
      };
    }
    if (record.status !== 'needs_input' || !record.pausedConversation) {
      return {
        task_id: taskId,
        status: 'failed',
        summary: `Task ${taskId} is not waiting for input (status=${record.status}).`,
        error: 'invalid_state',
      };
    }

    const subsystem = record.subsystem;
    const abort = new AbortController();
    this.registry.setAbortController(taskId, abort);
    this.registry.transition(taskId, 'running');

    const history = record.pausedConversation;
    // Clear so a subsequent failed resume doesn't replay stale state.
    // Uses the registry helper so the DB row drops these fields too.
    this.registry.clearPauseState(taskId);

    return await this.runAndHandle(record, record.request, subsystem, abort, {
      originalMessage: userInput,
      history,
    });
  }

  /**
   * Shared post-runner handling: completed -> summarize + finalize,
   * paused -> capture conversation + return needs_input envelope, throw ->
   * mark failed. Used by both dispatch (first run) and resume.
   */
  private async runAndHandle(
    record: TaskRecord,
    request: TaskRequest,
    subsystem: string,
    abort: AbortController,
    callArgs: { originalMessage: string; history: unknown[] | undefined },
  ): Promise<TaskResultEnvelope> {
    try {
      const result = await this.runner({
        tier: request.tier,
        subsystem,
        template: request.template,
        intent: request.intent,
        originalMessage: callArgs.originalMessage,
        signal: abort.signal,
        history: callArgs.history,
      });

      if (abort.signal.aborted) {
        return this.finalize(record, 'cancelled', 'Task cancelled during execution.');
      }

      if (result.kind === 'paused') {
        // Record the pause state via the registry so it lands in the DB
        // (so a daemon restart doesn't drop the question + buffer).
        this.registry.recordPauseState(
          record.id,
          result.question,
          result.conversation as import('../../llm/provider.ts').LLMMessage[],
        );
        const envelope: TaskResultEnvelope = {
          task_id: record.id,
          status: 'needs_input',
          summary: result.question,
          needs_input: { question: result.question },
        };
        this.registry.transition(record.id, 'needs_input', envelope);
        return envelope;
      }

      const summary = await this.summarize(record, request, result.text);
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
          content:
            `Condense the task result into a short paragraph (4-6 sentences) the conversational assistant can read to the user. ` +
            `ALWAYS preserve identifiers verbatim: workflow IDs and names, file paths, commitment IDs, goal IDs, URLs, any other handles the user might need to reference later. ` +
            `Preserve concrete facts (names, numbers, dates). Drop preamble, meta-commentary, and chain-of-thought. ` +
            `Do NOT add information that isn't in the task result.`,
        },
        {
          role: 'user',
          content: `User asked: ${request.intent}\n\nTask result:\n${trimmed}`,
        },
      ], { temperature: 0.1, max_tokens: 600 });
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
