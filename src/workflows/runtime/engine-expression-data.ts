/** The engine owns these envelopes. Piece payloads remain untouched and must
 * still pass the expression interpreter's JSON/prototype/accessor checks. */
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
