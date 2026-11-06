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

const MARKER = 'WorkflowExpressionError: Unsupported workflow expression: ';

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
