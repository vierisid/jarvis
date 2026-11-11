/** The engine owns these envelopes. Piece payloads remain untouched and must
 * still pass the expression interpreter's JSON/prototype/accessor checks. */
/**
 * A recorded step by name, from the object the engine keeps steps in. That
 * object is a plain `{}`, so `steps['toString']` is `Object.prototype.toString`
 * before any step by that name has run: the engine took such a step for
 * already finished and skipped it, and later references to it came up empty.
 * Only a step the run recorded itself is returned.
 */
export function ownStep<T>(steps: Record<string, T> | undefined, name: string): T | undefined {
  return steps !== undefined && Object.hasOwn(steps, name) ? steps[name] : undefined;
}

type Envelope = { type: string; output?: unknown };
type LoopOutput = { item?: unknown; index: number; iterations: Record<string, Envelope>[] };
export function stepExpressionOutput(step: Envelope, depth = 0): unknown {
  if (step.type !== 'LOOP_ON_ITEMS' || step.output == null) return step.output;
  if (depth > 64) throw new Error('Workflow loop output nesting limit');
  const output = step.output as LoopOutput;
  return {
    ...output,
    iterations: output.iterations.map(iteration => Object.fromEntries(
      Object.entries(iteration).map(([name, nested]) => {
        // Copy only the engine envelope. Never JSON.stringify a piece payload:
        // that would invoke toJSON/getters and bless arbitrary class instances.
        const data = Object.fromEntries(Object.entries(nested).filter(([, value]) => value !== undefined));
        const value = stepExpressionOutput(nested, depth + 1);
        if (value !== undefined) data.output = value;
        return [name, data];
      }),
    )),
  };
}
