/**
 * The exposure ledger: what carries monotonicity (invariant I2).
 *
 * #483 defect 2 is mid-task stripping -- turn 1 `open notepad` uses `ui_act`,
 * turn 2 `now remember that I did that` silently removes it. The fix has to
 * guarantee the exposed set never shrinks within a conversation.
 *
 * An earlier draft of the design claimed that fell out "by construction",
 * because the selection reads an append-only conversation. That is false in
 * this codebase, for two independent reasons:
 *
 *   1. `AgentInstance.addMessage` takes only 'user' | 'assistant' | 'system'
 *      and has no `tool_calls` parameter and no 'tool' role. `processMessage`
 *      and `streamMessage` persist ONLY the final assistant text; every
 *      assistant-with-tool-calls and every tool result lives in the
 *      loop-local buffer and is discarded when the turn ends. So on the two
 *      highest-traffic loops there is nothing in the history to read a
 *      "tools already used" set back out of -- which is #483's repro case
 *      exactly.
 *   2. `addMessage` calls `compactHistory` past a retention threshold, which
 *      drops the oldest chunks. The conversation is not append-only.
 *
 * So monotonicity is carried explicitly instead, by a grow-only set. The
 * ledger is the only mutable state in the filter, and it is mutable in one
 * direction only: `add` is the sole mutator and there is no remove.
 */

import type { LLMMessage } from '../../../llm/provider.ts';

/** The tool name the escape hatch is exposed under. */
export const DISCOVER_TOOLS = 'discover_tools';

/** How an off-list refusal's tool result begins (`interceptOffList`). */
export const NOT_RUN_MARKER = '[NOT RUN]';

/**
 * The placeholder `processTaskCall`'s clarification branch writes for every
 * sibling call it skipped. It answers a tool_call id -- the providers require
 * it -- but the call neither ran nor was admitted, so seeding skips it.
 */
const SKIPPED_PREFIX = '[Not run:';

/**
 * A grow-only set of tool names that must stay exposed for the rest of a
 * conversation: everything the model has already called, plus everything it
 * explicitly asked for through `discover_tools`.
 */
export class ToolExposureLedger {
  private readonly exposed = new Set<string>();

  /** Names in insertion order. Read-only by construction. */
  snapshot(): ReadonlySet<string> {
    return this.exposed;
  }

  has(name: string): boolean {
    return this.exposed.has(name);
  }

  get size(): number {
    return this.exposed.size;
  }

  /** The only mutator. There is deliberately no way to remove a name. */
  add(...toolNames: readonly string[]): void {
    for (const n of toolNames) {
      if (typeof n === 'string' && n.length > 0) this.exposed.add(n);
    }
  }

  /**
   * Rebuild from a conversation buffer.
   *
   * Used where the buffer IS durable and complete: `processTaskCall`'s
   * `opts.history` (persisted whole onto the task record) and the sub-agent's
   * `resume.messages` (captured whole into the checkpoint). On the two chat
   * loops there is nothing useful to seed from, which is precisely why the
   * ledger lives on the agent instance there instead.
   *
   * Seeding is additive, like every other write.
   */
  seedFromMessages(
    messages: readonly LLMMessage[] | undefined,
    /**
     * Restricts what can be seeded to names that actually exist. Without
     * it a conversation carrying model-invented tool names would grow the
     * ledger with strings that match nothing, forever -- and the names in
     * a `discover_tools` call are model-authored input.
     */
    isKnown?: (name: string) => boolean,
  ): void {
    if (!messages) return;
    const ok = (n: string) => (isKnown ? isKnown(n) : true);
    // Only calls that were ANSWERED. A paused sub-agent's buffer ends on an
    // assistant turn whose later calls were never reached; seeding those
    // would put a tool the model chose while it was hidden -- a shell
    // picked with every framed reader out of view -- into the exposed set,
    // and the resume would then dispatch it without the off-list check.
    // "Called or admitted" has to mean it.
    //
    // Not the clarification branch's skipped siblings: they were answered
    // with a placeholder, never ran and were never admitted, and seeding
    // them into the shared, process-lifetime primary ledger would widen it
    // with no audit row. An off-list REFUSAL (NOT_RUN_MARKER) is different
    // and IS seeded: the live loop admitted that name, audited the
    // admission, and told the model it is available from its next step --
    // a resumed run that forgot it would refuse the retry the live one
    // allows.
    const answered = new Set<string>();
    for (const m of messages) {
      if (m.role !== 'tool' || !m.tool_call_id) continue;
      const text = m.content;
      if (typeof text === 'string' && text.startsWith(SKIPPED_PREFIX)) continue;
      answered.add(m.tool_call_id);
    }
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.tool_calls) continue;
      for (const tc of m.tool_calls) {
        if (!answered.has(tc.id)) continue;
        if (ok(tc.name)) this.add(tc.name);
        if (tc.name === DISCOVER_TOOLS) this.add(...admittedNames(tc.arguments).filter(ok));
      }
    }
  }
}

/**
 * Pull the `names` argument out of a `discover_tools` call.
 *
 * Model-authored input, so it is treated as such: only strings survive, and
 * whether a named tool actually exists is decided later by the subset check
 * in `normalizeToolSet` -- a name that is not registered simply never
 * matches anything. Admission cannot conjure a tool into existence, and it
 * cannot bypass the framing invariant, which is re-checked on every computed
 * set including this one.
 */
export function admittedNames(args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  let raw = (args as Record<string, unknown>).names;
  if (typeof raw === 'string') {
    // Small models routinely stringify the array ('["browser_navigate"]')
    // or send a comma-separated list, and `discover_tools` is answered
    // before the registry's argument coercion ever sees it. Read either
    // shape rather than reporting "No such tool" for a name that exists --
    // the hatch failing on a formatting slip is the hatch failing.
    const text = raw.trim();
    if (text.startsWith('[')) {
      try { raw = JSON.parse(text); } catch { raw = text.slice(1, -1); }
    }
    if (typeof raw === 'string') raw = raw.split(/[\s,]+/).map((n) => n.replace(/^["']|["']$/g, ''));
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
}
