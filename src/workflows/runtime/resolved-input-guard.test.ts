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

test('a declared whitespace dropdown choice is a value; other blanks are still missing', () => {
  const props = {
    delimiter_type: { type: 'STATIC_DROPDOWN', required: true, options: { options: [{ label: 'Comma', value: ',' }, { label: 'Tab', value: '\t' }] } },
    csv_text: { type: 'LONG_TEXT', required: true },
  };
  expect(resolvedInputIssues({ delimiter_type: '\t', csv_text: 'a' }, props, false, false)).toEqual({});
  expect(resolvedInputIssues({ delimiter_type: ' ', csv_text: '   ' }, props, false, false)).toEqual({
    delimiter_type: ['required input is missing'], csv_text: ['required input is missing'],
  });
  expect(resolvedInputIssues({ delimiter_type: '', csv_text: '\t' }, props, false, false)).toEqual({
    delimiter_type: ['required input is missing'], csv_text: ['required input is missing'],
  });
});
