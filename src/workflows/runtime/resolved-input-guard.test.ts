import { expect, test } from 'bun:test';
import { resolvedInputIssues } from './resolved-input-guard';

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
