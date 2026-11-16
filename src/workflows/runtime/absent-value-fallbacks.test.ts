import { expect, test } from 'bun:test';
import { withAbsentValueFallbacks } from './absent-value-fallbacks';
import { compileWorkflow } from './workflow-readiness';
import { PieceCatalog } from './piece-catalog';

const TEXT = '@activepieces/piece-text-helper';

test('the default-value step takes a whole-reference value as optional', () => {
  expect(withAbsentValueFallbacks(TEXT, 'defaultValue', { value: '{{trigger.missing}}', defaultString: 'fb' }))
    .toEqual({ value: "{{(trigger.missing) ?? ''}}", defaultString: 'fb' });
});

test('every other input, step and reference shape keeps the strict rule', () => {
  const input = { value: 'Hi {{trigger.missing}}', defaultString: '{{trigger.fallback}}' };
  expect(withAbsentValueFallbacks(TEXT, 'defaultValue', input)).toEqual(input);
  expect(withAbsentValueFallbacks(TEXT, 'defaultValue', { value: '{{connections.x.token}}' })).toEqual({ value: '{{connections.x.token}}' });
  expect(withAbsentValueFallbacks(TEXT, 'defaultValue', { value: '{{a}} and {{b}}' })).toEqual({ value: '{{a}} and {{b}}' });
  expect(withAbsentValueFallbacks(TEXT, 'concat', { value: '{{trigger.missing}}' })).toEqual({ value: '{{trigger.missing}}' });
  expect(withAbsentValueFallbacks('@activepieces/piece-other', 'defaultValue', { value: '{{trigger.missing}}' })).toEqual({ value: '{{trigger.missing}}' });
  expect(withAbsentValueFallbacks(TEXT, 'defaultValue', undefined)).toBeUndefined();
});

test('the saved input is not changed', () => {
  const input = { value: '{{trigger.missing}}' };
  withAbsentValueFallbacks(TEXT, 'defaultValue', input);
  expect(input.value).toBe('{{trigger.missing}}');
});

test('readiness still catches a mistyped step reference on the default-value step', () => {
  const pieces = new PieceCatalog([{ name: TEXT, displayName: '', description: '', actions: {
    defaultValue: { name: 'defaultValue', displayName: '', description: '', inputSchema: { fields: [
      { name: 'value', label: '', type: 'string', required: false },
      { name: 'defaultString', label: '', type: 'string', required: true },
    ] } },
  } }]);
  const graph = (value: string) => ({ name: 'trigger', type: 'EMPTY', nextAction: { name: 'fallback', type: 'PIECE', settings: { pieceName: TEXT, actionName: 'defaultValue', input: { value, defaultString: 'fb' } } } });
  expect(compileWorkflow(graph('{{trigger.missing}}'), { pieces }).ready).toBe(true);
  expect(compileWorkflow(graph('{{triger.missing}}'), { pieces }).issues)
    .toContainEqual(expect.objectContaining({ node: 'fallback', path: 'settings.input.value', code: 'REFERENCE_SCOPE' }));
});
