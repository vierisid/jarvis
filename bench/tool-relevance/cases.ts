/**
 * Benchmark cases.
 *
 * Two sources, deliberately:
 *
 *   1. The five conversations #483 measured, so the before/after is directly
 *      comparable to the numbers in the issue rather than to a fresh set
 *      chosen after the fact.
 *   2. Cases GENERATED from the registry, one per tool, so a tool added
 *      tomorrow is exercised without anyone remembering to write a case.
 *      #483 requirement 5 is explicit that the fixtures come from
 *      BUILTIN_TOOLS and not from a hand-written list.
 *
 * `wants` names the tool a correct answer would call. For the generated
 * cases that is the tool the prompt was generated from; for the issue's
 * conversations it is a judgement, and `wantsFramedRead` marks the ones
 * where the right answer is a framed perception tool -- those are what the
 * substitution metric is computed over.
 */

import type { ToolDefinition } from '../../src/actions/tools/registry.ts';
import { isFloorEligible, outsideReach } from '../../src/actions/tools/tool-relevance/authority-classes.ts';

export type BenchCase = {
  id: string;
  /** The conversation, oldest first. */
  messages: string[];
  /** Tool a correct answer would call, when there is an unambiguous one. */
  wants?: string;
  /**
   * True when the task requires reading something outside the conversation
   * through a framed tool. Reaching for `run_command` on one of these is the
   * substitution this whole design exists to prevent.
   */
  wantsFramedRead?: boolean;
};

/** The five rows of #483's measurement table, plus its mid-task loss case. */
export const ISSUE_CASES: BenchCase[] = [
  { id: 'issue/notepad', messages: ['open notepad and type hello'], wants: 'desktop_launch_app' },
  {
    id: 'issue/research',
    messages: ['research the competitor landscape and write it up'],
    wants: 'browser_navigate', wantsFramedRead: true,
  },
  {
    id: 'issue/summarise-url',
    messages: ['summarise this article https://example.com/post/1'],
    wants: 'browser_navigate', wantsFramedRead: true,
  },
  { id: 'issue/goal', messages: ['set a goal to ship the release this week'], wants: 'manage_goals' },
  {
    id: 'issue/schedule',
    messages: ['schedule a daily check of the dashboard'],
    wants: 'manage_workflow',
  },
  {
    // The mid-task loss #483 reproduced: turn 2 mentions only the knowledge
    // group, and under #475 that removed ui_act and browser_navigate while
    // retaining run_command.
    id: 'issue/mid-task-followup',
    messages: ['open notepad and type hello', 'now remember that I did that'],
    wants: 'commitments',
  },
];

/**
 * One case per droppable tool, generated from the registry.
 *
 * The prompt is deliberately naive -- it is derived from the tool's own
 * description, which is what the model sees anyway. The point is not to be
 * a realistic utterance; it is to guarantee that every tool has at least one
 * case in which it is the right answer, so a tool the trigger table forgot
 * shows up as an accuracy loss rather than as silence.
 */
export function generatedCases(registry: readonly ToolDefinition[]): BenchCase[] {
  return registry
    .filter((t) => !isFloorEligible(t))
    .map((t) => ({
      id: `gen/${t.name}`,
      messages: [firstSentence(t.description)],
      wants: t.name,
      wantsFramedRead: outsideReach(t) === 'framed',
    }));
}

function firstSentence(description: string): string {
  const cut = description.search(/\.\s/);
  return (cut > 0 ? description.slice(0, cut) : description).trim();
}

/**
 * Realistic browse asks that name neither the web nor a browser. These are
 * the asks most likely to produce a substitution -- the model has to decide
 * how to go and look, with no keyword steering it -- and before they were
 * added, the substitution rate rested on two realistic cases and sixteen
 * prompts generated from tool descriptions. Kept in step with the
 * "realistic browse asks" test in src/actions/tools/tool-relevance/
 * selection.test.ts.
 */
export const BROWSE_CASES: BenchCase[] = [
  'find the cheapest flight to Tokyo',
  "what's the price of bitcoin right now",
  'visit example.org and tell me what it says',
  'go to github.com and check my notifications',
  'fill in the signup form on their homepage',
  'what are people saying on reddit about the new iphone',
  'compare prices for a standing desk',
  'find me a recipe for lasagna',
  'who won the match last night',
  'hover over the menu and tell me the options',
  'look up the weather in Rome',
].map((ask, i) => ({ id: `browse/${i + 1}`, messages: [ask], wants: 'browser_navigate', wantsFramedRead: true }));

export function allCases(registry: readonly ToolDefinition[]): BenchCase[] {
  return [...ISSUE_CASES, ...BROWSE_CASES, ...generatedCases(registry)];
}

/** One turn of a scripted conversation, for the prompt-cache measurement. */
export type ScriptedTurn = {
  user: string;
  /**
   * The assistant's final text. Scripted rather than taken from the model so
   * both arms carry byte-identical histories and differ ONLY in the tool
   * list -- which is the variable being measured. The chat loops persist
   * only this text (`AgentInstance.addMessage`), never the tool calls, so a
   * history of plain user/assistant text is what production actually sends.
   */
  reply: string;
  /** Tools the turn used, noted into the ledger the way the loops do. */
  used?: string[];
};

export type ScriptedConversation = { id: string; turns: ScriptedTurn[] };

/**
 * Multi-turn conversations for the cache accounting (#502's third exit
 * criterion: a saving that survives prompt-cache accounting).
 *
 * The single-shot cases cannot answer that question. The cost the filter
 * adds is a CHANGE in the tool list between requests, which invalidates the
 * cached prefix, and a change only exists across requests. These are run in
 * order, in one arm at a time, so the cross-conversation effect is in the
 * number too: unfiltered, the tools-plus-system prefix stays warm from one
 * conversation to the next; filtered, it survives only if the next
 * conversation happens to start with the same set.
 *
 * Deliberately mixed: a quiet chat, #483's mid-task repro, and sessions that
 * grow the set turn by turn. A benchmark made only of single-intent chats
 * would flatter the filter.
 */
export const CONVERSATIONS: ScriptedConversation[] = [
  {
    id: 'conv/quiet',
    turns: [
      { user: 'hi jarvis', reply: 'Hello! What can I do for you?' },
      { user: 'nothing much, just saying thanks for yesterday', reply: 'Any time.' },
    ],
  },
  {
    id: 'conv/mid-task',
    turns: [
      { user: 'open notepad and type hello', reply: 'Notepad is open and says hello.', used: ['desktop_launch_app', 'desktop_type'] },
      { user: 'now remember that I did that', reply: 'Noted.', used: ['commitments'] },
    ],
  },
  {
    id: 'conv/read-then-note',
    turns: [
      { user: 'summarise this article https://example.com/post/1', reply: 'It argues that small models need fewer tools.', used: ['browser_navigate'] },
      { user: 'save that summary as a note', reply: 'Saved as a document.', used: ['create_document'] },
      { user: 'and remind me to read the follow-up tomorrow', reply: 'Reminder set for tomorrow.', used: ['commitments'] },
    ],
  },
  {
    id: 'conv/goal-then-build',
    turns: [
      { user: 'set a goal to ship the release this week', reply: 'Goal created.', used: ['manage_goals'] },
      { user: 'what should I focus on first?', reply: 'Start with the failing tests.' },
      { user: 'ok run the test suite and tell me if it passes', reply: 'All tests pass.', used: ['run_command'] },
      { user: 'great, thanks', reply: 'You are welcome.' },
    ],
  },
  {
    id: 'conv/long-mixed',
    turns: [
      { user: 'what is on my screen right now?', reply: 'A code editor with two files open.', used: ['desktop_snapshot'] },
      { user: 'copy the error message from it', reply: 'Copied.', used: ['set_clipboard'] },
      { user: 'search the web for that error', reply: 'It is a known bug fixed in 2.1.', used: ['browser_navigate'] },
      { user: 'draft a short report about the fix', reply: 'Draft saved.', used: ['create_document'] },
      { user: 'schedule a weekly check that the fix is still deployed', reply: 'Workflow scheduled.', used: ['manage_workflow'] },
      { user: 'thanks, that is all', reply: 'Glad to help.' },
    ],
  },
];
