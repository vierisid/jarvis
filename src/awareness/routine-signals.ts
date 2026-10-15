import type { JobSignal } from './opportunity-types.ts';
import { ROUTINES, ROUTINE_POLICY, type RoutineStage } from './routine-catalog.ts';

export type RoutineSignalEvidence = {
  policy: typeof ROUTINE_POLICY;
  stage: RoutineStage;
  sidecarId: string | null;
};
export type RoutineCapture = {
  captureId: string; timestamp: number; app?: string | null;
  windowTitle?: string | null; ocrText?: string | null; sidecarId?: string | null;
  excluded?: boolean;
};
const PRIVATE_CONTEXT = /\b(?:incognito|private browsing|inprivate|private window|1password|bitwarden|keepass|password manager|navigazione privata)\b/i;
// Full-screen OCR routinely carries thousands of characters of window chrome, so
// the OCR bound is generous; the whole bounded text is scanned for qualifiers.
export const MAX_ROUTINE_OCR_CHARS = 20_000;
const READING_CONTEXT = /\b(?:article|tutorial|research|guide|how to|documentation|blog|articolo|ricerca|guida|tutoriel|recherche|artículo|investigación)\b/i;

export function classifyJobSignals(input: RoutineCapture): JobSignal[] {
  if (input.excluded || !input.captureId || !Number.isSafeInteger(input.timestamp)) return [];
  const title = input.windowTitle ?? '';
  const ocr = input.ocrText ?? '';
  const app = input.app || 'Unknown app';
  // Overflow abstains instead of truncating away a privacy/research qualifier.
  if (title.length > 240 || ocr.length > MAX_ROUTINE_OCR_CHARS || app.length > 100
    || (input.sidecarId?.length ?? 0) > 200) return [];
  const text = `${title}\n${ocr}`;
  if (PRIVATE_CONTEXT.test(`${app}\n${text}`) || READING_CONTEXT.test(text)) return [];
  return ROUTINES.flatMap(job => {
    // Choose one stage per screen. A static page listing all three phases
    // cannot advance the sequence by being captured repeatedly.
    const stage = job.output.test(text) ? 'output'
      : job.source.test(text) ? job.operation.test(text) ? 'operation' : 'source' : null;
    if (!stage) return [];
    return [{ captureId: input.captureId, observedAt: input.timestamp, app,
      kind: job.kind, cue: job.cue,
      routine: { policy: ROUTINE_POLICY, stage, sidecarId: input.sidecarId || null } }];
  });
}

/** Old or invalid ledger evidence remains readable, but cannot certify v2 recurrence. */
export function parseRoutineEvidence(value: unknown): RoutineSignalEvidence | undefined {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (data.policy !== ROUTINE_POLICY || !['source', 'operation', 'output'].includes(String(data.stage))
    || !(data.sidecarId === null || typeof data.sidecarId === 'string' && data.sidecarId.length <= 200)) return undefined;
  return { policy: ROUTINE_POLICY, stage: data.stage as RoutineStage, sidecarId: data.sidecarId as string | null };
}
