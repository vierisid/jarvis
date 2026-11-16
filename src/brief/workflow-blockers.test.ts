import { expect, test } from 'bun:test';
import { explainBlocker, explainCodeSteps } from './workflow-blockers';

const issue = (message: string, extra: Record<string, unknown> = {}) =>
  ({ node: 'step_1', path: 'settings.input.x', code: 'INPUT', message, ...extra });

test('a step name cannot reorder, hide or break out of the sentence', () => {
  const named = (name: string) => () => name;
  const rlo = explainBlocker([issue('Bad value')], named('cv\u202Egpj.exe\u200B "now" \n\n ok')).reason;
  expect(rlo).toBe(`Fix "cvgpj.exe 'now' ok" first: Bad value.`);
  expect(explainCodeSteps(['a'], named('\u200B\u2066')).reason).toBe('a step without a name runs code and needs your permission first.');
  const app = explainBlocker([issue('x', { connect: { app: 'Hub\u202ESpot' } })], named('Send')).reason;
  expect(app).toBe('Connect a HubSpot account for "Send" first.');
});

test('a long name or message is cut with a visible marker, the message stays last, and the reason fits a refusal', () => {
  const long = `${'word '.repeat(200_000)}end.`;
  const { reason } = explainBlocker([issue(long), issue('second')], () => 'n'.repeat(500));
  expect(reason.length).toBeLessThan(1000);
  expect(reason.startsWith(`Fix "${'n'.repeat(57)}..." first (and 1 more thing after it): word word`)).toBe(true);
  expect(reason.endsWith('word... (shortened; the workflow shows the full detail).')).toBe(true);
  // A message of exactly the budget is not marked.
  const fits = explainBlocker([issue('a'.repeat(400))], () => 'x').reason;
  expect(fits).toBe(`Fix "x" first: ${'a'.repeat(400)}.`);
});
