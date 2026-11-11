import { expect, test } from 'bun:test';
import { invalidDateMessage, resolvedInputIssues } from './resolved-input-guard';

test('required piece inputs reject missing values and invalid numbers', () => {
  const props = { to: { type: 'SHORT_TEXT', required: true }, count: { type: 'NUMBER', required: false } };
  expect(resolvedInputIssues({}, props, false, false)).toEqual({ to: ['required input is missing'] });
  expect(resolvedInputIssues({ to: '', count: NaN }, props, false, false).to).toBeDefined();
  expect(resolvedInputIssues({ to: 'recipient', count: 2 }, props, false, false)).toEqual({});
});

test('required collections accept empty values', () => {
  expect(resolvedInputIssues({ rows: [], document: [] }, {
    rows: { type: 'ARRAY', required: true }, document: { type: 'JSON', required: true },
  }, false, false)).toEqual({});
});

test('a date input that is not a date reads as a plain sentence', () => {
  const props = { delayUntilTimestamp: { type: 'DATE_TIME', displayName: 'Date and Time' } };
  const errors = { delayUntilTimestamp: ['x'] };
  expect(invalidDateMessage(errors, props, { delayUntilTimestamp: 'not a date' }, 'delay_until'))
    .toBe('The date to wait until is not a valid date: not a date');
  expect(invalidDateMessage(errors, props, { delayUntilTimestamp: 'a'.repeat(100) }, 'delay_until'))
    .toBe(`The date to wait until is not a valid date: ${'a'.repeat(80)}...`);
  expect(invalidDateMessage(errors, props, { delayUntilTimestamp: 'nope' }, 'other'))
    .toBe('The date in "Date and Time" is not a valid date: nope');
  // A missing date keeps the ordinary "required" path.
  expect(invalidDateMessage(errors, props, {}, 'delay_until')).toBeNull();
  expect(invalidDateMessage({ other: ['x'] }, props, { delayUntilTimestamp: 'nope' }, 'delay_until')).toBeNull();
});
