/** Static guidance only. Never copy expressions, provider messages or stack traces
 * into Brief's conservatively redacted inspection surface. This is advice, not
 * evidence about whether any earlier effect happened. */
export function workflowDiagnostic(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const marker = 'WorkflowExpressionError: Unsupported workflow expression: ';
  const at = message.indexOf(marker);
  if (at < 0) return null;
  const reason = message.slice(at + marker.length);
  if (reason.startsWith('non-JSON object in {{')) return 'An input expression returned an object that is not plain JSON. Map its supported data fields into the input, then validate the draft before starting a new run.';
  if (reason.startsWith('prototype access')) return 'An input expression accesses a protected object property. Use ordinary JSON data fields instead, then validate the draft before starting a new run.';
  return 'An input expression could not be evaluated. Inspect the failed step’s input mappings. Use data references and supported operators; move function calls or other logic into a supported workflow step. Validate the draft before starting a new run.';
}
