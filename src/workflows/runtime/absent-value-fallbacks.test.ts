import { expect, test } from 'bun:test';
import { withAbsentValueFallbacks } from './absent-value-fallbacks';

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
