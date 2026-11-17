/**
 * What to change when a step failed because one of its input expressions
 * could not be evaluated against the data it read (`safe-expression.ts`).
 *
 * Syntax the evaluator refuses (function calls, unknown operators, unclosed
 * strings and the like) is caught by readiness before a run starts
 * (`workflow-readiness.ts`), so a run that fails here failed on its data: the
 * value an earlier step returned did not fit the expression. Each reason the
 * evaluator raises at runtime maps to one fixed sentence. Nothing from the
 * message itself (the expression, a value, a stack path) is ever copied: the
 * sentence is advice, shown on every surface that reads the run's failure.
 *
 * The match reads the failed step's recorded message, the only evidence the
 * engine keeps for it. It changes the advice only, never what the reading
 * says did or did not take effect, so a message that merely quotes this text
 * cannot make a step that acted read as one that did nothing.
 */

import { failureCause } from '../../failures/cause';

const MARKER = 'Unsupported workflow expression: ';

const CHECK_MAPPING = "Check the step's input mapping against the data the earlier step returns.";

const SIZE = 'The data this input reads is larger or more deeply nested than a workflow step can carry. '
  + "Narrow the earlier step's output, or map only the fields this step needs.";

/** Runtime reasons from `safe-expression.ts`, by the exact reason text it raises. */
const GUIDANCE: Record<string, string> = {
  'non-JSON object': 'An input reads a value that is not plain JSON data, such as a date or binary object. '
    + "Map the plain fields this step needs from the earlier step's output.",
  // Raised for a key the expression looks up and for a key inside the data it reads.
  'prototype access': 'An input reads data that uses a property name workflows do not allow '
    + '(__proto__, prototype or constructor), as a key in the data or as a key it looks up. '
    + "Map only the fields this step needs from the earlier step's output.",
  'invalid property key': `An input looks up a property with a key from the data that is not text or a number. ${CHECK_MAPPING}`,
  // Raised for an operand and for a result that is not finite.
  'operators require finite primitive values': 'An input applies an operator to a value it cannot use, '
    + `such as a list or an object, text that is not a number, or a division by zero. ${CHECK_MAPPING}`,
  'accessor property': `An input reads a value that is computed rather than stored as data. ${CHECK_MAPPING}`,
  'non-data value': `An input reads a value that is not data, such as a function. ${CHECK_MAPPING}`,
  'value size limit': SIZE,
  'array size limit': SIZE,
  'output size limit': SIZE,
  'value or nesting limit': SIZE,
  'flatten path must be a string array': `The path an input passes to flattenNestedKeys is not a list of text keys. ${CHECK_MAPPING}`,
};

const OTHER = `An input expression could not be evaluated against the data this step read. ${CHECK_MAPPING}`;

/** The fixed advice for a step whose input expression failed on its data, or null when it did not. */
export function expressionFailureGuidance(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const at = message.indexOf(MARKER);
  if (at < 0) return null;
  const rest = message.slice(at + MARKER.length);
  const end = rest.indexOf(' in {{');
  const reason = end < 0 ? null : rest.slice(0, end);
  return (reason !== null && Object.hasOwn(GUIDANCE, reason) ? GUIDANCE[reason] : undefined) ?? OTHER;
}

const MISSING_REFERENCE = /^"\{\{(.+)\}\}" has no value in this run\.$/su;

/**
 * Whether a step failed because an input reference had no value in this run
 * (`absentReferenceError`). That is raised while the step's input is resolved,
 * before the step runs, so nothing the step does took effect. Only a message
 * whose own cause is exactly that sentence counts: a step that did something
 * and then reported an error that merely quotes it does not.
 */
export function failedOnMissingReference(message: unknown): boolean {
  return missingReference(message) !== null;
}

/**
 * The reference a missing-reference failure names, whitespace removed and
 * without the "..." of a long one cut short, or null for any other failure.
 */
export function missingReference(message: unknown): string | null {
  const cause = failureCause(message, 1000);
  const named = cause === null ? null : MISSING_REFERENCE.exec(cause)?.[1];
  return named ? named.replace(/\.\.\.$/u, '').replace(/\s+/gu, '') || null : null;
}

/** The wrapper the engine runtime puts around an error that ended the whole run, not one step. */
const ENGINE_WRAP = /^executeFlow\(run [^)]*\) -> [A-Z_]+:\s*/u;
const ERROR_CLASS = /^(?:[A-Z][A-Za-z]*)?Error:\s*/u;

/** A reference is shown only when it reads as a plain path, never as arbitrary text. */
function plainReference(raw: string): string | null {
  const text = raw.trim();
  return /^[\w.[\]'"-]{1,80}$/u.test(text) && !text.endsWith('...') ? text : null;
}

export interface LoopInputFailure {
  /** The expression the loop reads, as the engine reported it, when it reads as a plain path. */
  reference: string | null;
  /** The raw expression text the loop's own setting is matched against. */
  expression: string;
  /** Plain advice, with `who` (the loop's name) in place of "This loop". */
  text: (who: string) => string;
}

/**
 * A loop whose list could not be read, from the engine's whole-run failure.
 * The engine evaluates a loop's list before any step record exists, so it
 * reports it as an internal error with no step. Reads only the two reasons
 * that can come from a list: the value limits (`safe-expression.ts` allows
 * 10,000 values, counting every field of every item) and a reference with no
 * value. Any other reason is left to the general reading.
 */
export function loopInputFailure(message: unknown): LoopInputFailure | null {
  if (typeof message !== 'string') return null;
  const body = message.replace(ENGINE_WRAP, '').replace(ERROR_CLASS, '');
  const missing = /^"\{\{(.+?)\}\}" has no value in this run\./su.exec(body);
  if (missing) {
    const expression = missing[1]!.trim();
    const named = plainReference(expression);
    return { expression, reference: named, text: who => `${who} reads ${named ? `"${named}"` : 'a list'}, which had no value in this run. `
      + 'Start the workflow with a list there, or point the loop at a step that returns one.' };
  }
  const at = message.indexOf(MARKER);
  if (at < 0) return null;
  const rest = message.slice(at + MARKER.length);
  const end = rest.indexOf(' in {{ ');
  const reason = end < 0 ? null : rest.slice(0, end);
  const close = rest.indexOf(' }}.', end);
  const expression = close < 0 ? '' : rest.slice(end + ' in {{ '.length, close).trim();
  const named = plainReference(expression);
  if (reason !== null && (reason === 'value or nesting limit' || reason === 'array size limit')) {
    return { expression, reference: named, text: who => `${who} reads a list that is too big. A loop can carry up to 10,000 values, counting every field, `
      + 'so about 2,500 contacts with three fields each. Split the list into smaller batches, or send fewer fields per item.' };
  }
  const advice = expressionFailureGuidance(message)!;
  return { expression, reference: named, text: () => advice };
}
