import { describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import { absentReferenceError, evaluateWorkflowExpression } from './safe-expression';
import { expressionFailureGuidance, failedOnMissingReference } from './expression-failure';

/** The step message the engine records: `inspect` of the real evaluator error, behind the executor's prefix. */
function recorded(script: string, context: Record<string, unknown>): string {
  try { evaluateWorkflowExpression(script, context); } catch (error) { return `engine executor: run r ended FAILED at step "s": ${inspect(error)}`; }
  throw new Error(`expected ${script} to fail`);
}
const SECRET = 'secret_customer_value';
const CHECK = "Check the step's input mapping against the data the earlier step returns.";
function guidance(reason: string, script: string, context: Record<string, unknown>): string {
  const message = recorded(script, context);
  expect(message).toContain(`Unsupported workflow expression: ${reason} in {{`);
  const text = expressionFailureGuidance(message)!;
  expect(text).not.toBeNull();
  // Fixed sentences only: never the expression, a value, the evaluator's wording or a stack path.
  for (const leak of [SECRET, '{{', 'Unsupported workflow expression', 'WorkflowExpressionError', ' at ', '/']) expect(text).not.toContain(leak);
  expect(text).not.toContain('validate the draft');
  expect(text).not.toContain('run it again');
  return text;
}

describe('expressionFailureGuidance', () => {
  test('a failure that is not an expression failure has no guidance', () => {
    expect(expressionFailureGuidance(null)).toBeNull();
    expect(expressionFailureGuidance(undefined)).toBeNull();
    expect(expressionFailureGuidance('Provider error: Unsupported value')).toBeNull();
  });

  test('a non-JSON value', () => {
    expect(guidance('non-JSON object', `${SECRET}`, { [SECRET]: new Date() })).toContain('not plain JSON data');
  });

  test('a property name from the data that reaches the prototype', () => {
    const lookup = guidance('prototype access', `a[${SECRET}]`, { a: {}, [SECRET]: '__proto__' });
    expect(lookup).toContain('(__proto__, prototype or constructor)');
    // The same reason when the data returned simply holds such a key.
    expect(guidance('prototype access', SECRET, { [SECRET]: { constructor: 1 } })).toBe(lookup);
    expect(lookup).toContain('as a key in the data or as a key it looks up');
  });

  test('a property key from the data that is not text or a number', () => {
    expect(guidance('invalid property key', `a[${SECRET}]`, { a: {}, [SECRET]: {} })).toBe(`An input looks up a property with a key from the data that is not text or a number. ${CHECK}`);
  });

  test('an operator applied to a value that is not a finite primitive', () => {
    const operand = guidance('operators require finite primitive values', `${SECRET} + 1`, { [SECRET]: { nested: true } });
    expect(operand).toContain('such as a list or an object, text that is not a number, or a division by zero');
    // Results that are not finite raise the same reason.
    expect(guidance('operators require finite primitive values', `a / ${SECRET}`, { a: 1, [SECRET]: 0 })).toBe(operand);
    expect(guidance('operators require finite primitive values', `${SECRET} - 1`, { [SECRET]: 'abc' })).toBe(operand);
  });

  test('an accessor property or a value that is not data', () => {
    const getter = Object.defineProperty({}, 'x', { get: () => 1, enumerable: true });
    expect(guidance('accessor property', `${SECRET}.x`, { [SECRET]: getter })).toContain('computed rather than stored as data');
    expect(guidance('non-data value', `${SECRET}.x`, { [SECRET]: () => 1 })).toContain('not data, such as a function');
  });

  test('data larger or deeper than a step can carry', () => {
    const size = guidance('output size limit', SECRET, { [SECRET]: 'x'.repeat(1_100_000) });
    expect(size).toContain("larger or more deeply nested than a workflow step can carry. Narrow the earlier step's output");
    expect(guidance('array size limit', SECRET, { [SECRET]: Array.from({ length: 10_001 }, () => 0) })).toBe(size);
    let deep: unknown = 1; for (let i = 0; i < 70; i++) deep = { d: deep };
    expect(guidance('value or nesting limit', SECRET, { [SECRET]: deep })).toBe(size);
    expect(guidance('value size limit', `${SECRET} + 'b'`, { [SECRET]: 'x'.repeat(1_100_000) })).toBe(size);
  });

  test('a flatten path that is not a list of text keys', () => {
    expect(guidance('flatten path must be a string array', `flattenNestedKeys(a, ${SECRET})`, { a: {}, [SECRET]: 'x' })).toContain('flattenNestedKeys is not a list of text keys');
  });

  test('any other reason gets the general sentence, never its wording', () => {
    const text = expressionFailureGuidance(`WorkflowExpressionError: Unsupported workflow expression: forbidden-${SECRET} in {{ token }}`)!;
    expect(text).toBe(`An input expression could not be evaluated against the data this step read. ${CHECK}`);
    expect(expressionFailureGuidance('WorkflowExpressionError: Unsupported workflow expression: constructor')).toBe(text);
  });
});

describe('a reference with no value', () => {
  const recordedAbsent = (expression: string) => `engine executor: run r ended FAILED at step "s": ${inspect(absentReferenceError(expression))}\nAutomatic retry is disabled.`;

  test('names the reference, and is read back from the step message with its stack', () => {
    expect(absentReferenceError('trigger.body.name').message).toBe('"{{trigger.body.name}}" has no value in this run.');
    expect(failedOnMissingReference(recordedAbsent('trigger.body.name'))).toBe(true);
    expect(failedOnMissingReference(recordedAbsent("trigger.headers['x-qa']"))).toBe(true);
  });

  test('a long reference is cut, not copied whole', () => {
    expect(absentReferenceError(`a.${'b'.repeat(500)}`).message.length).toBeLessThan(200);
  });

  test('other messages, including ones that only quote it, are not it', () => {
    expect(failedOnMissingReference('Error: boom')).toBe(false);
    expect(failedOnMissingReference('Error: sent, then failed: "{{a}}" has no value in this run.')).toBe(false);
    expect(failedOnMissingReference(undefined)).toBe(false);
  });
});
