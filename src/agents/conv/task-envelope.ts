/**
 * Task envelope - the contract between the conversation tier and the task
 * tiers. The conversation LLM emits structured `delegate` tool calls; the
 * dispatcher executes them on the requested tier and returns an envelope
 * that the conversation LLM verbalizes for the user.
 *
 * Keep this file small and dependency-free so the conv tier and the task
 * tier can share types without circular imports.
 */

import type { Tier } from '../../llm/tiers.ts';

/**
 * Task templates - rough categorization the conversation LLM picks when
 * delegating. Used to pre-build a focused system prompt on the task tier.
 * Keep this list short - we intentionally collapsed specialty roles into
 * functional templates in Phase 3.
 */
export type TaskTemplate =
  | 'research'   // gather information from the web / docs / vault
  | 'code'       // write, read, debug, refactor code
  | 'plan'       // multi-step planning, decomposition, scheduling
  | 'write'      // draft prose (emails, docs, summaries)
  | 'general';   // catch-all for anything that doesn't fit above

export type TaskStatus =
  | 'queued'        // accepted, not yet started
  | 'running'       // task tier is executing
  | 'needs_input'   // task paused, waiting for clarification from user
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * What the conversation LLM passes when delegating. The `intent` field is
 * the one-line goal sentence the task tier sees first - it should contain
 * any constraints (budget, tone, scope) folded inline. Phase 4 also had
 * separate `constraints` / `context` fields but small models tend to
 * mis-serialize arrays as strings, so we keep the schema minimal.
 */
export type TaskRequest = {
  tier: Exclude<Tier, 'conversation'>;
  template: TaskTemplate;
  /**
   * One-line goal the conv LLM extracted from the user's message. Used as a
   * routing hint and added to the task tier's system context, but the task
   * tier actually sees the user's ORIGINAL verbatim message as its user
   * prompt (see TaskRunner). This avoids losing Jarvis-specific cues that
   * a paraphrasing conv LLM might strip out.
   */
  intent: string;
  /**
   * The user's verbatim message. Set by the conv orchestrator when it
   * builds a TaskRequest; the runner uses it as the task tier's user prompt.
   */
  original_message?: string;
};

/**
 * What flows back into the conversation LLM's context after a task runs.
 * `summary` is what the conv LLM verbalizes; `details_ref` is a pointer to
 * fetch the full task transcript if the user drills in. `followup_hints`
 * are optional next-step suggestions the conv LLM can offer.
 */
export type TaskResultEnvelope = {
  task_id: string;
  status: 'completed' | 'failed' | 'cancelled' | 'needs_input';
  summary: string;
  details_ref?: string;
  followup_hints?: string[];
  /** Populated when status === 'needs_input'. */
  needs_input?: { question: string };
  /** Populated when status === 'failed'. */
  error?: string;
};

/**
 * In-memory record of a task. The registry holds these for in-flight and
 * recently-completed tasks. Older completed tasks are evicted.
 */
export type TaskRecord = {
  id: string;
  request: TaskRequest;
  subsystem: string;          // attribution label for token tracking
  status: TaskStatus;
  startedAt: number;
  updatedAt: number;
  result?: TaskResultEnvelope;
  /** Set by the dispatcher; calling .abort() cancels the in-flight task. */
  abortController?: AbortController;
  /**
   * When status === 'needs_input', the question the task tier wants the
   * conversation agent to ask the user. The conv LLM verbalizes this and
   * captures the user's reply for a subsequent `resume_task` call.
   */
  question?: string;
  /**
   * Captured task-tier conversation buffer at the moment of pause. The
   * dispatcher uses this to resume execution by appending the user's reply
   * as a new user message and re-entering the ReAct loop. Discarded once
   * the task transitions to a terminal state.
   */
  pausedConversation?: unknown[];
};

export function newTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
