/**
 * Pure scoring helpers for the tool-relevance benchmark.
 *
 * Kept out of benchmark.ts so the three numbers the default flip hangs on
 * (docs/tool-relevance-filtering.md section 10) are computed by code that has
 * its own tests, rather than by arithmetic inline in a report loop that only
 * ever runs against a live model.
 */

import type { ToolDefinition } from '../../src/actions/tools/registry.ts';
import { outsideReach } from '../../src/actions/tools/tool-relevance/authority-classes.ts';

/**
 * True when `name` is a registered tool that fetches outside content
 * UNFRAMED -- the laundering class (`outsideReach === 'fetch'`).
 *
 * This is wider than `run_command` on purpose. The first version of the
 * harness counted only the shell, so a model pushed from `browser_navigate`
 * onto `delegate_task` (a sub-agent browses and reports in its own unwrapped
 * words) or onto `capture_screen` scored as clean. Both are the same
 * substitution the invariant exists to stop, and the classification already
 * says so.
 */
export function isUnframedFetch(name: string | null, all: readonly ToolDefinition[]): boolean {
  if (!name) return false;
  const t = all.find((x) => x.name === name);
  return t !== undefined && outsideReach(t) === 'fetch';
}

/**
 * A substitution the FILTER caused: on a case whose right answer is a framed
 * read, the filtered arm reached for an unframed fetch tool and the full arm
 * did not. A model that picks the shell with every tool in front of it is
 * doing that anyway, and blaming the filter for it would hide the number
 * this metric exists to isolate.
 */
export function isFilterSubstitution(
  fullCalled: string | null,
  filteredCalled: string | null,
  all: readonly ToolDefinition[],
): boolean {
  return isUnframedFetch(filteredCalled, all) && !isUnframedFetch(fullCalled, all);
}

/**
 * Exact two-sided McNemar test on the discordant pairs of a paired
 * comparison.
 *
 *   b  cases the full arm got right and the filtered arm got wrong
 *   c  cases the filtered arm got right and the full arm got wrong
 *
 * Returns the p-value under H0 "the filter does not change accuracy",
 * i.e. X ~ Binomial(b + c, 0.5). Exact rather than chi-squared because the
 * case counts here are tens, not thousands, and the normal approximation is
 * poor exactly where the decision is made.
 */
export function mcnemarExactP(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  // P(X <= k), summed in log space so n in the hundreds cannot overflow.
  let logC = 0; // log C(n, 0)
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

export type AccuracyVerdict = {
  b: number;
  c: number;
  p: number;
  /** Net cases the filter may lose and still count as "within noise". */
  margin: number;
  /** True when the filter is not measurably worse than the full list. */
  withinNoise: boolean;
};

/**
 * "Accuracy no worse than the full-list baseline within noise."
 *
 * A NON-INFERIORITY rule, not a significance test. The first version
 * passed whenever McNemar could not reject at 0.05, and at the case counts
 * a CPU run can afford that cannot fail: losing 11 cases and winning 3 of
 * 54 -- fifteen points of accuracy -- was "within noise". Failing to reject
 * is not evidence of equivalence. Now the filter may lose, net, at most
 * `margin` cases: 2% of the paired cases, and never less than one, so a
 * single flip on a small run is not a stop but two net losses on 54 is.
 * The exact p is still reported beside it, for reading, not for deciding.
 */
export function accuracyVerdict(pairs: ReadonlyArray<{ full: boolean; filtered: boolean }>): AccuracyVerdict {
  let b = 0;
  let c = 0;
  for (const p of pairs) {
    if (p.full && !p.filtered) b += 1;
    else if (!p.full && p.filtered) c += 1;
  }
  const margin = Math.max(1, Math.round(0.02 * pairs.length));
  return { b, c, p: mcnemarExactP(b, c), margin, withinNoise: b - c <= margin };
}

/** What the accuracy run counted, for `accuracyRunVerdict`. */
export type AccuracyScore = {
  /** Cases attempted and cases that errored. */
  cases: number;
  errors: number;
  /** Cases with a `wants`, and how many the FULL arm got right. */
  scored: number;
  fullCorrect: number;
  framedCases: number;
  /** Framed-read cases on which the FULL arm itself used a framed tool. */
  framedFullFramed: number;
  substitutions: number;
  violations: number;
  accuracy: AccuracyVerdict;
};

export type RunVerdict = { pass: boolean; lines: string[] };

/**
 * Turn an accuracy run into verdict lines. Pure, so it is tested: this is
 * the code that decides whether anything reads as a pass.
 *
 * Every guard here exists because a run that measured nothing produced a
 * clean-looking MET. The one that motivated this function: a model that
 * never calls a tool (a template that ignores `tools`, a thinking model cut
 * off before it answers) scored 0 substitutions, 0 discordant pairs and a
 * smaller filtered prompt -- every criterion MET, exit 0. So:
 *
 *   - no cases survived                        NO RESULT
 *   - some cases errored                       PARTIAL RESULT
 *   - the full arm got under half right        NO RESULT: the model is not
 *                                              choosing tools, and nothing
 *                                              it did says anything about
 *                                              the filter
 *   - the full arm used a framed tool on none  NO SUBSTITUTION RESULT: "zero
 *     of the framed-read cases                 substitutions" means nothing
 *                                              if the model never takes the
 *                                              framed route even when it has
 *                                              every tool
 */
export function accuracyRunVerdict(s: AccuracyScore): RunVerdict {
  const n = s.cases - s.errors;
  if (n === 0) {
    return { pass: false, lines: [
      'NO RESULT: every case errored, so nothing was measured.',
      'The exit criteria are UNPROVEN, not met. Fix the model endpoint and re-run.'] };
  }
  if (s.errors > 0) {
    return { pass: false, lines: [
      `PARTIAL RESULT: ${s.errors} of ${s.cases} cases errored.`,
      'Treat the criteria as unproven until a clean run.'] };
  }
  if (s.scored === 0 || s.fullCorrect * 2 < s.scored) {
    return { pass: false, lines: [
      `NO RESULT: with every tool offered the model picked the right one on only ${s.fullCorrect}/${s.scored} cases.`,
      'It is not choosing tools (does the chat template pass `tools`? is the reply cut off?), so',
      'nothing it did with the filtered list says anything about the filter.'] };
  }
  if (s.framedCases === 0 || s.framedFullFramed === 0) {
    return { pass: false, lines: [
      `NO SUBSTITUTION RESULT: the full arm used a framed tool on ${s.framedFullFramed} of ${s.framedCases} framed-read cases,`,
      'so a zero substitution count is not evidence of anything.'] };
  }
  const subOk = s.substitutions === 0;
  const violOk = s.violations === 0;
  const a = s.accuracy;
  return {
    pass: subOk && violOk && a.withinNoise,
    lines: [
      `criterion 1, substitution rate zero:        ${subOk ? 'MET' : 'NOT MET'}`
        + ` (${s.substitutions} over ${s.framedCases}; the full arm took the framed route on ${s.framedFullFramed})`,
      `criterion 2, accuracy within noise:         ${a.withinNoise ? 'MET' : 'NOT MET'}`
        + ` (filtered lost ${a.b}, won ${a.c}; margin ${a.margin}; p=${a.p.toFixed(3)})`,
      `criterion 4, invariant violations zero:     ${violOk ? 'MET' : 'NOT MET'} (${s.violations})`,
    ],
  };
}

/** One request in a simulated conversation, for the offline cache estimate. */
export type CacheStep = {
  /** Tool names in the order they are serialised, which is registry order. */
  tools: readonly string[];
  /** Bytes of each serialised tool schema, parallel to `tools`. */
  toolSizes: readonly number[];
  /** Bytes of the system prompt. Identical across the steps of one arm. */
  systemBytes: number;
  /** Bytes of each conversation message, oldest first; the last is the new user turn. */
  messageBytes: readonly number[];
  /** True on the first request of a new conversation. */
  newConversation: boolean;
};

/**
 * Where the chat template renders the tool list, which decides what a tool
 * change invalidates. The SIGN of the result depends on this, so the
 * estimate is reported for each rather than as one number with "bounds".
 *
 *   tools-first        tools, then system, then history (Anthropic's order,
 *                      §6). A tool change re-prefills everything.
 *   tools-first-exact  the same, on a token-exact prefix cache that still
 *                      reuses the leading tools the two lists share.
 *   system-first       system text, then tools, then history (Qwen 2.5/3
 *                      and most HF templates put the tools inside the
 *                      system turn after its text). A tool change keeps the
 *                      system prompt and re-prefills tools and history.
 *   tools-last         tools inside the LAST user message (Llama 3.1's
 *                      default template). Tools are never in the cached
 *                      prefix, so BOTH arms pay for them on every request
 *                      and a smaller list always wins.
 */
export type CacheModel = 'tools-first' | 'tools-first-exact' | 'system-first' | 'tools-last';
export const CACHE_MODELS: readonly CacheModel[] = ['tools-first', 'tools-first-exact', 'system-first', 'tools-last'];

/**
 * Bytes a provider has to prefill for each request, under a PERFECT prefix
 * cache that holds the previous request and nothing else.
 *
 * With the tool list unchanged, only the messages that were not in the
 * previous request are new -- or, when a new conversation starts,
 * everything after the system prompt (and the tools, for `tools-last`).
 *
 * Optimistic for BOTH arms in one way, stated so it is not mistaken for a
 * measurement: a real cache is evicted by other traffic, and the unfiltered
 * arm, which leans on the cache harder, loses more to eviction. The live
 * `--cache` run is the measurement; this is the estimate that says whether
 * one is worth taking, and for which templates.
 */
export function uncachedBytes(steps: readonly CacheStep[], model: CacheModel = 'tools-first'): number[] {
  const out: number[] = [];
  let prev: CacheStep | null = null;
  for (const s of steps) {
    const toolBytes = sum(s.toolSizes);
    const messages = sum(s.messageBytes);
    const total = toolBytes + s.systemBytes + messages;
    if (!prev || prev.systemBytes !== s.systemBytes) {
      out.push(total);
    } else if (model === 'tools-last') {
      // The previous request's last user message carried the tools; in this
      // request it does not, so it is re-prefilled along with what follows.
      out.push(toolBytes + (s.newConversation ? messages : sum(s.messageBytes.slice(Math.max(0, prev.messageBytes.length - 1)))));
    } else if (!sameList(prev.tools, s.tools)) {
      if (model === 'tools-first-exact') out.push(total - sharedToolPrefixBytes(prev, s));
      else if (model === 'system-first') out.push(total - s.systemBytes);
      else out.push(total);
    } else if (s.newConversation) {
      out.push(messages);
    } else {
      // Same conversation, same tools: the previous request's messages are a
      // prefix of this one's. Everything after them is new.
      out.push(sum(s.messageBytes.slice(prev.messageBytes.length)));
    }
    prev = s;
  }
  return out;
}

function sharedToolPrefixBytes(a: CacheStep, b: CacheStep): number {
  let n = 0;
  for (let i = 0; i < Math.min(a.tools.length, b.tools.length); i++) {
    if (a.tools[i] !== b.tools[i]) break;
    n += b.toolSizes[i]!;
  }
  return n;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sum(xs: readonly number[]): number {
  return xs.reduce((n, x) => n + x, 0);
}
