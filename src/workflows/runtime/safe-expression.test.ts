import { describe, expect, test } from 'bun:test';
import { evaluateWorkflowExpression as evaluate, workflowExpressionReferences, WorkflowExpressionError } from './safe-expression';
import { noOpCodeSandbox } from '../activepieces/packages/server/engine/src/lib/core/code/no-op-code-sandbox';

/** Upper bound on the guidance suffix, so the excerpt assertion stays meaningful. */
const GUIDANCE_MAX = 600;

test('dependency inspection distinguishes roots from literal text, keys and property names', () => {
  expect([...workflowExpressionReferences('({ first: "first.pid", pid: 123 })')]).toEqual([]);
  const references = workflowExpressionReferences('flag ? first[third.key] : flattenNestedKeys(second.rows, ["first"])');
  expect([...references].sort()).toEqual(['first', 'flag', 'second', 'third']);
  expect([...workflowExpressionReferences('[first?.pid, -other.count, first.pid + 1]')].sort()).toEqual(['first', 'other']);
  expect(() => workflowExpressionReferences('first.getPid()')).toThrow(WorkflowExpressionError);
});

describe('workflow data expressions', () => {
  const context = { trigger: { amount: 12, rows: [{ name: 'Café' }, { name: '東京' }], key: 'amount' },
    connection: { secret_text: 'example' } };
  for (const [source, expected] of [
    ['trigger.amount * 2 + 3', 27], ['(trigger.amount + 2) / 2', 7],
    ['trigger[trigger.key]', 12], ["trigger.rows[1]['name']", '東京'],
    ['trigger.rows.length', 2], ['trigger.rows[0].name[0]', 'C'],
    ['trigger.missing?.name ?? "fallback"', 'fallback'],
    ['trigger.amount > 10 && trigger.amount <= 20 ? "yes" : "no"', 'yes'],
    ['false && missing.value', false], ['true || missing.value', true],
    ['null == undefined', true], ['null === undefined', false],
    ['!false', true], ['-trigger.amount + +"2"', -10],
    ['[trigger.amount, "x", true, null]', [12, 'x', true, null]],
    ['({ total: trigger.amount, "name": "Caf\\u00e9" })', { total: 12, name: 'Café' }],
    ['flattenNestedKeys(trigger.rows, ["name"])', ['Café', '東京']],
    ['connection.secret_text', 'example'], ['unknown.field', undefined],
  ] as const) test(source, () => expect(evaluate(source, context)).toEqual(expected));

  for (const source of [
    'fetch("https://example.invalid")', 'globalThis.fetch("x")', 'process.exit()',
    'import("node:fs")', 'require("node:fs")', 'Bun.write("x", "y")',
    'Function("return process")()', 'eval("1")', '(()=>1)()',
    'trigger.amount = 2', 'trigger.rows.push("x")', 'new Date()',
    'trigger.constructor', 'trigger["con" + "structor"]', 'trigger.__proto__',
    '({"__proto__": {}})', '({get x(){return 1}})', '`${process}`',
    'true ? 1 : fetch("x")', 'false && fetch("x")', // Parse the entire source, even unselected branches.
    'trigger.rows.map(x => x.name)', 'flattenNestedKeys(trigger, ["constructor"])',
    '1 / 0', '1e999', '1; 2', '[...trigger.rows]',
  ]) test(`rejects ${source}`, () => expect(() => evaluate(source, context)).toThrow(WorkflowExpressionError));

  test('never calls getters, coercion hooks or supplied helper functions', async () => {
    let effects = 0;
    const object = { get value() { effects++; return 'unsafe'; }, toString() { effects++; return 'unsafe'; } };
    for (const source of ['object.value', 'object + "x"', 'object', 'object.toString()']) {
      expect(() => evaluate(source, { object })).toThrow(WorkflowExpressionError);
    }
    expect(await noOpCodeSandbox.runScript({ script: 'flattenNestedKeys(data, ["x"])',
      scriptContext: { data: [{ x: 1 }] }, functions: { flattenNestedKeys: () => { effects++; } } })).toEqual([1]);
    expect(effects).toBe(0);
  });

  test('bounds source, nesting, materialized data and string calculations', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const [source, scope] of [
      [' '.repeat(16_385), {}], ['('.repeat(100) + '1' + ')'.repeat(100), {}],
      ['1+'.repeat(1500) + '1', {}], ['data', { data: Array(10_001).fill(0) }],
      ['data', { data: cyclic }], ['data + data', { data: 'x'.repeat(600_000) }],
    ] as const) expect(() => evaluate(source, scope)).toThrow(WorkflowExpressionError);
  });
});

describe('expression failure messages', () => {
  test('name the failing expression and what replaced JavaScript evaluation', () => {
    try {
      evaluate('trigger.rows.map(r => r.name)', { trigger: { rows: [] } });
      throw new Error('expected a WorkflowExpressionError');
    } catch (error) {
      const message = (error as Error).message;
      expect(error).toBeInstanceOf(WorkflowExpressionError);
      expect(message).toContain('{{ trigger.rows.map(r => r.name) }}');
      expect(message).toContain('JavaScript methods, function calls');
      expect(message).toContain('flattenNestedKeys(data, path)');
      expect((error as WorkflowExpressionError).source).toBe('trigger.rows.map(r => r.name)');
    }
  });

  test('a long expression is excerpted rather than dumped whole', () => {
    const source = `trigger.a${'b'.repeat(400)}.map(x => x)`;
    const error = (() => { try { evaluate(source, {}); } catch (e) { return e as WorkflowExpressionError; } })()!;
    expect(error.message).toContain('...');
    expect(error.message.length).toBeLessThan(source.length + GUIDANCE_MAX);
  });

  test('annotation happens once, even through the engine sandbox entry point', async () => {
    const error = await noOpCodeSandbox.runScript({ script: 'new Date()', scriptContext: {}, functions: {} })
      .then(() => null, (e: WorkflowExpressionError) => e);
    expect(error!.message.match(/Workflow expressions are data only/g)).toHaveLength(1);
  });
});
