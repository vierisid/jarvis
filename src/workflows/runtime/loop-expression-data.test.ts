import { expect, test } from 'bun:test';
import { stepExpressionOutput } from './engine-expression-data';
import { evaluateWorkflowExpression as evaluate } from './safe-expression';

class Envelope {
  constructor(public output: unknown, public type = 'PIECE', public status = 'SUCCEEDED', public input = {}) {}
}
const piece = (output: unknown) => new Envelope(output);
const loop = (steps: any[]) => new Envelope({ item: false, index: steps.length, iterations: steps }, 'LOOP_ON_ITEMS');
const context = (output: Envelope) => ({ currentState: () => ({ review: stepExpressionOutput(output) }) });

test('whole loop and iterations are data while preserving typed outputs and metadata', () => {
  const steps = [{ ask: piece({ count: 0, blocked: false, value: null }) }, { ask: piece({ count: 2.25, blocked: true }) }];
  const current = context(loop(steps)).currentState();
  const all = evaluate('review', current) as any;
  expect(all.iterations[0].ask.output).toEqual({ count: 0, blocked: false, value: null });
  expect(all.iterations[1].ask.status).toBe('SUCCEEDED');
  expect(evaluate('review.iterations', current)).toEqual(all.iterations);
  expect(evaluate('review.iterations[0].ask.output.count', current)).toBe(0);
  expect(steps[0]!.ask).toBeInstanceOf(Envelope);
});

test('nested loop collections have the same data before and after persisted resume', () => {
  const output = loop([{ nested: loop([{ ask: piece({ quantity: 0 }) }]) }]);
  const original = context(output);
  const persisted = context(JSON.parse(JSON.stringify(output)));
  expect(evaluate('review', original.currentState())).toEqual(evaluate('review', persisted.currentState()));
  expect(evaluate('review.iterations[0].nested.output.iterations[0].ask.output.quantity', original.currentState())).toBe(0);
});

test('normalizing engine envelopes never blesses piece data or calls getters/toJSON', () => {
  let calls = 0;
  class Untrusted { value = 1; toJSON() { calls++; return { value: 1 }; } }
  const accessor = { get value() { calls++; return 1; } };
  for (const payload of [new Untrusted(), accessor, JSON.parse('{"__proto__":{}}')]) {
    const current = context(loop([{ ask: piece(payload) }])).currentState();
    expect(() => evaluate('review', current)).toThrow();
    expect(() => evaluate('review.iterations[0].ask.output', current)).toThrow();
  }
  expect(calls).toBe(0);
});
