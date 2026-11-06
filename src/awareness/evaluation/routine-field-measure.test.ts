/**
 * #1068: the field measurement counts where real captures stop, and carries
 * nothing of the screens themselves.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { caseCaptures, EVALUATION_NOW, type RoutineCase } from './routine-evaluation.ts';
import { measureRoutineCaptures } from './routine-field-measure.ts';
import type { RoutineCapture } from '../routine-signals.ts';

const dev = JSON.parse(readFileSync(new URL('./fixtures/development.json', import.meta.url), 'utf-8')) as { cases: RoutineCase[] };
const invoices = dev.cases.find(c => c.id === 'dev-invoices')!;

test('agrees with the evaluation on a fixture that proposes: three ordered episodes, one proposal', () => {
  const report = measureRoutineCaptures(caseCaptures(invoices), EVALUATION_NOW);
  const f = report.families.invoice_review!;
  expect(report.read).toBe(9);
  expect(f.stages).toEqual({ source: 3, operation: 3, output: 3 });
  expect(f.episodes).toEqual({ all: 3 });
  expect(f.episodeDays).toEqual({ all: 3 });
  expect(report.spanDays).toBe(2);
  expect(report.proposals).toEqual(['invoice_review']);
});

test('a screen that shows only the source phrase counts as a source and nothing more', () => {
  const capture: RoutineCapture = { captureId: 'c1', timestamp: EVALUATION_NOW - 1000, app: 'Browser',
    ocrText: 'Overdue invoices\nAmount due\nCustomer', sidecarId: 'd' };
  const f = measureRoutineCaptures([capture], EVALUATION_NOW).families.invoice_review!;
  expect(f).toMatchObject({ sourcePhrase: 1, operationPhrase: 0, outputPhrase: 0, sourceAndOperationPhrase: 0, episodes: { all: 0 } });
  expect(f.stages).toEqual({ source: 1, operation: 0, output: 0 });
});

test('each gate is counted, and so is the family it hid', () => {
  const base = { timestamp: EVALUATION_NOW - 1000, app: 'Browser', sidecarId: 'd' };
  const report = measureRoutineCaptures([
    { ...base, captureId: 'r', ocrText: 'Overdue invoices\nHelp guide' },
    { ...base, captureId: 'p', ocrText: 'Overdue invoices', app: 'Bitwarden' },
    { ...base, captureId: 'o', ocrText: `Overdue invoices ${'x'.repeat(20_001)}` },
    { ...base, captureId: 'e', ocrText: 'Overdue invoices', excluded: true },
    { ...base, captureId: 'n', ocrText: null, windowTitle: null },
  ], EVALUATION_NOW);
  expect(report.abstained).toEqual({ excluded: 1, invalid: 0, oversize: 1, private: 1, reading: 1 });
  expect(report.withoutText).toBe(1);
  expect(report.read).toBe(1);
  expect(report.families.invoice_review!.stoppedByGate).toEqual({ private: 1, reading: 1, oversize: 1 });
  expect(report.families.lead_followup!.stoppedByGate).toEqual({ private: 0, reading: 0, oversize: 0 });
});

test('the report carries counts only: no screen text, title, app, capture id or device id', () => {
  const marker = 'Zq7secretmarker';
  const captures: RoutineCapture[] = caseCaptures(invoices).map((c, i) => ({
    ...c, captureId: `${marker}-id-${i}`, app: `${marker}App`, windowTitle: `${marker} title`,
    ocrText: `${c.ocrText}\n${marker} customer`, sidecarId: `${marker}-device`,
  }));
  const report = measureRoutineCaptures(captures, EVALUATION_NOW);
  // Not vacuous: the marked captures were really read and matched.
  expect(report.families.invoice_review!.episodes).toEqual({ all: 3 });
  const json = JSON.stringify(report);
  expect(json).not.toContain(marker);
  for (const c of captures) expect(json).not.toContain(String(c.timestamp));
});

test('a gated screen counts for a family only if the classifier would have given it a stage', () => {
  const base = { timestamp: EVALUATION_NOW - 1000, app: 'Browser', sidecarId: 'd' };
  // An operation phrase alone gets no stage (operation needs the source too),
  // nor does a report screen naming two schedules.
  const report = measureRoutineCaptures([
    { ...base, captureId: 'op', ocrText: 'Checking payment status\nHelp guide' },
    { ...base, captureId: 'two', ocrText: 'Weekly report and monthly report\nHelp guide' },
  ], EVALUATION_NOW);
  expect(report.abstained.reading).toBe(2);
  expect(report.families.invoice_review!.stoppedByGate.reading).toBe(0);
  expect(report.families.recurring_report!.stoppedByGate.reading).toBe(0);
});

test('recurring reports are grouped per cadence, as the assessment groups them', () => {
  const weekly: RoutineCase = { id: 'weekly', usefulRoutine: 'recurring_report', steps: [
    { app: 'Sheet', text: 'Weekly sales report' },
    { app: 'Sheet', text: 'Weekly sales report\nComparing figures' },
    { app: 'Docs', text: 'Weekly sales report draft' },
  ] };
  const report = measureRoutineCaptures(caseCaptures(weekly), EVALUATION_NOW);
  expect(report.families.recurring_report!.episodes).toEqual({ none: 0, daily: 0, weekly: 3, monthly: 0 });
  expect(report.proposals).toEqual(['recurring_report']);
});

test('one view showing all three phrases, captured again and again, is never an episode', () => {
  const captures: RoutineCapture[] = Array.from({ length: 20 }, (_, i) => ({
    captureId: `v${i}`, timestamp: EVALUATION_NOW - 3 * 86_400_000 + i * 6 * 3_600_000, app: 'Browser', sidecarId: 'd',
    ocrText: 'Overdue invoices\nChecking payment status\nInvoice follow-up draft',
  }));
  const f = measureRoutineCaptures(captures, EVALUATION_NOW).families.invoice_review!;
  expect(f.stages).toEqual({ source: 0, operation: 0, output: 20 });
  expect(f.episodes).toEqual({ all: 0 });
});
