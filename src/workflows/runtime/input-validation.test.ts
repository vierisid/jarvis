import { expect, test } from 'bun:test';
import { emptyFieldInput, inputIssue } from './input-validation';
import type { PieceInputField } from './piece-input';

const tab: PieceInputField = { name: 'd', label: 'D', type: 'enum', required: true, options: [{ value: ',', label: 'Comma' }, { value: '\t', label: 'Tab' }, { value: '', label: 'None' }] };

test('only a declared whitespace choice of a dropdown counts as filled in', () => {
  expect(emptyFieldInput(tab, '\t')).toBe(false);
  expect(inputIssue(tab, '\t')).toBeNull();
  // Blank values that are not a declared choice, and a declared empty choice, stay empty.
  for (const blank of [undefined, null, '', ' ', ' \t ', '\n']) expect(inputIssue(tab, blank)).toBe('required input is missing');
  // Every other field type still treats whitespace as missing, even if it carries options.
  for (const type of ['string', 'long_text', 'number', 'datetime', 'flow_ref', 'json', 'multi_enum'] as const) {
    expect(inputIssue({ ...tab, type }, '   ')).toBe('required input is missing');
    expect(inputIssue({ ...tab, type }, '\t')).toBe('required input is missing');
  }
  expect(inputIssue({ ...tab, required: false }, ' ')).toBeNull();
});
