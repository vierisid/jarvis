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

export function allCases(registry: readonly ToolDefinition[]): BenchCase[] {
  return [...ISSUE_CASES, ...generatedCases(registry)];
}
