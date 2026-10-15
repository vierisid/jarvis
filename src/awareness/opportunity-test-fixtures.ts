import { createCapture } from '../vault/awareness.ts';

/** Synthetic multi-step activity for lifecycle tests; returns the output's real capture ID. */
export function captureRoutine(timestamp: number, title = 'Overdue invoices', appName = 'Accounting', sidecarId?: string) {
  const phases = title === 'Weekly sales report' ? ['', 'Comparing figures', 'Weekly sales report draft']
    : title === 'Lead follow-up' ? ['', 'Reviewing last contact', 'Lead follow-up email draft']
    : ['', 'Checking payment status', 'Invoice follow-up draft'];
  const rows = phases.map((ocrText, i) => createCapture({ timestamp: timestamp - (2 - i) * 60_000,
    pixelChangePct: 0.5, windowTitle: title, ocrText: title === 'Email and spreadsheet' ? '' : ocrText, appName, sidecarId }));
  return rows[2]!;
}
