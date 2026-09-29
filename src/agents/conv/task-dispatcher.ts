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
import { type TurnToolScope } from '../../actions/tools/tool-scope.ts';
import type { TaskRequest, TaskRecord, TaskResultEnvelope, TaskTemplate } from './task-envelope.ts';
import type { TaskRegistry } from './task-registry.ts';

// Raised threshold: short task outputs (workflow creation results, code edit
// summaries, etc.) are typically 1-3K chars and contain IDs/names the conv
// LLM needs to reference later. Pass them through verbatim rather than risk
// the summarizer stripping identifiers.
const SUMMARY_THRESHOLD_CHARS = 3000;

const TOOL_USE_INSTRUCTION = `IMPORTANT: You have access to real tools listed in your context. USE THEM to do the work - do not just describe what someone could do. If the user asked to create a workflow, use the workflow tools. If they asked to browse the web, use the browser. If they asked to read a file, use file-ops. Generic textual answers about "you could write a Python script" or "here is the general approach" are wrong when the right tool exists in your registry.

NEVER answer by announcing what you are about to do ("On it - I'll open Notepad, then verify it's in the foreground"). You are a background executor: nobody reads your text while you work, so an announcement reaches the user as the finished result and the work never happens. Call the tools first; your reply is the report of what they actually returned.`;

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
  /**
   * Tools this KIND of turn does not have (#571). Required, not optional:
   * this is the only route from a hosted chat turn to the tool registry, and
   * a runner that forgets it is a turn running unscoped. `null` is the
   * explicit "no scope".
   */
  scope: TurnToolScope | null;
  /**
   * The site-builder prompt block for a project-scoped chat, if any. Rebuilt
   * every turn and NOT persisted with the task: it carries repo-written file
   * names framed as untrusted data (sites/prompt-context.ts), and a stale
   * copy replayed onto a resume would describe a tree that has since moved.
   */
  siteContext?: string;
}) => Promise<TaskRunResult>;

/**
 * The facts about the dispatching TURN. Required on both `dispatch` and
 * `resume`, not an optional options bag: a dispatch that does not say what
 * scope its turn has is a task about to run unscoped, and the compiler is the
 * only thing that catches the next call site (#571).
 */
export type TurnContext = {
  /** Tools this kind of turn does not have. `null` is the explicit "none". */
  scope: TurnToolScope | null;
  /** This turn's site prompt block, handed to the task tier that has the tools. */
  siteContext?: string;
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
  async dispatch(request: TaskRequest, turn: TurnContext): Promise<TaskResultEnvelope> {
    const subsystem = `task_${request.template}`;
    // A scoped task must run on the USER's words. The fallback below
    // (`original_message ?? intent`) would otherwise hand the task tier the
    // router's paraphrase, and the paraphrase is what the relevance filter
    // then selects on: "make the hero bigger" matches no trigger group and
    // substitutes the site surface, while "update the hero section on the
    // user's website" matches the BROWSE group (selection.ts puts "site" and
    // "website" there, not in the site-build group), reaches for nothing
    // withheld, and so gets the framed site readers but none of the actors.
    // Failing is better than silently running a site task on text the user
    // never wrote.
    if (turn.scope && !request.original_message) {
      return {
        task_id: 'unassigned',
        status: 'failed',
        summary: 'This chat is scoped to one project, so a task has to run on your own words. Please say that again.',
        error: 'missing_original_message',
      };
    }
    const record = this.registry.create(request, subsystem, turn.scope?.id);
    const abort = new AbortController();
    this.registry.setAbortController(record.id, abort);
    this.registry.transition(record.id, 'running');

    if (abort.signal.aborted) {
      return this.finalize(record, 'cancelled', 'Task cancelled before it could start.');
    }

    return await this.runAndHandle(record, request, subsystem, abort, {
      originalMessage: request.original_message ?? request.intent,
      history: undefined,
      // On a fresh dispatch the record's scope IS the turn's -- it was just
      // written from it -- so there is nothing to reconcile.
      scope: turn.scope,
      ...(turn.siteContext ? { siteContext: turn.siteContext } : {}),
    });
  }

  /**
   * Resume a previously-paused task by feeding the user's clarification
   * reply back into the task tier's conversation. Reuses the saved buffer
   * so the LLM continues from where it stopped instead of starting over.
   */
  async resume(taskId: string, userInput: string, turn: TurnContext): Promise<TaskResultEnvelope> {
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

    // MATCH OR REFUSE, and not a union of the two scopes (#571).
    //
    // `resume_task` takes a task id the ROUTER chose, validated only for
    // presence and existence, against a process-global TaskRegistry shared by
    // every chat and channel. So the conv LLM in a site chat can resume a
    // task that paused in the telegram chat, and vice versa.
    //
    // A union of the withheld sets is safe in the widening direction -- the
    // resume can never do more than either context allowed -- but it is
    // wrong in the narrowing one. A non-site task resumed from the Sites page
    // would run under the site scope: its buffer already used `read_file`, the
    // ledger is seeded from that buffer so the model believes it has it, the
    // candidate set removes it, `discover_tools` cannot hand it back because
    // the catalogue is scope-filtered too, and the refusal it finally gets
    // says "use the site_* tools with the project_id" for a task that has no
    // project. The user's paused work is burned on iteration cap or an
    // apology, triggered by a model's choice of id rather than anything the
    // user did.
    //
    // Comparing IDS, not resolved scopes, is deliberate: a row carrying a
    // scope id this build no longer defines matches no live turn and is
    // refused, where resolving it would yield `null` -- "no scope" -- and run
    // the task with the full registry. The security-relevant direction fails
    // closed.
    const recordScopeId = record.scopeId ?? null;
    const turnScopeId = turn.scope?.id ?? null;
    if (recordScopeId !== turnScopeId) {
      return {
        task_id: taskId,
        status: 'failed',
        summary: `Task ${taskId} was started in a different chat and cannot be continued here. `
          + 'Ask again in the chat it started in, or start it over here.',
        error: 'scope_mismatch',
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
      // Identical to the record's by the check above, so either is correct;
      // the turn's is the live object.
      scope: turn.scope,
      ...(turn.siteContext ? { siteContext: turn.siteContext } : {}),
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
    callArgs: {
      originalMessage: string;
      history: unknown[] | undefined;
      scope: TurnToolScope | null;
      siteContext?: string;
    },
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
        scope: callArgs.scope,
        ...(callArgs.siteContext ? { siteContext: callArgs.siteContext } : {}),
      });

      if (abort.signal.aborted) {
        return this.finalize(record, 'cancelled', 'Task cancelled during execution.');
      }

      if (result.kind === 'paused') {
        // Record the pause state via the registry so it lands in the DB
        // (so a daemon restart doesn't drop the question + buffer).
        //
        // System messages are dropped first (#571). They are rebuilt fresh by
        // `processTaskCall` on resume, and persisting them was a real leak of
        // the per-turn guarantee: the site prompt block interpolates
        // repo-written file names framed as untrusted data, and
        // sites/prompt-context.ts states the design intent as "rebuilt into
        // the system prompt on EVERY later turn" precisely so planted text
        // cannot outlive the turn that planted it. Serialized into
        // `tasks.paused_conversation` it outlived the turn, the conversation
        // and the daemon process. Dropping them also shrinks the blob and
        // makes the scope notice live on the resume path instead of being
        // shadowed by a stale copy.
        //
        // Safe for tool_use/tool_result pairing: these buffers only ever
        // carry system messages at the head (processTaskCall builds them that
        // way), so removing them leaves the assistant/tool sequence
        // untouched, and the resume re-prepends them in the same position.
        const buffer = (result.conversation as import('../../llm/provider.ts').LLMMessage[])
          .filter((m) => m.role !== 'system');
        this.registry.recordPauseState(record.id, result.question, buffer);
        const envelope: TaskResultEnvelope = {
          task_id: record.id,
          status: 'needs_input',
          summary: result.question,
          needs_input: { question: result.question },
        };
        this.registry.transition(record.id, 'needs_input', envelope);
        return envelope;
      }

      // A task that finished without touching a single tool is the signature
      // of a model that announced its plan instead of executing it - the
      // result the conversation tier then reads out as a progress note. It is
      // model-family dependent, so it can reappear on any upstream swap:
      // log it loudly rather than letting it look like a normal completion.
      // `grep 'completed without using any tool'` on the daemon log is the
      // fastest check after changing which model backs a tier.
      // `write` is exempt: it drafts prose and is dispatched with
      // requireToolUse off, so a tool-less completion is the expected shape -
      // warning on it would bury the real signal in the log.
      const usedTools = (result.conversation as { role?: string }[])
        .some((m) => m?.role === 'tool');
      if (!usedTools && request.template !== 'write') {
        console.warn(
          `[TaskDispatcher] task ${record.id} (${request.template}, tier=${request.tier}) ` +
          `completed without using any tool - the model answered with text only. ` +
          `Result: ${JSON.stringify(result.text.slice(0, 160))}`,
        );
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
