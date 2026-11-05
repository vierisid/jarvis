import type { JobSignal } from './opportunity-types.ts';
import { ROUTINES, ROUTINE_POLICY, type RoutineDefinition, type RoutineStage } from './routine-catalog.ts';
import { reportCadence, type ReportCadence } from './routine-identity.ts';

export type RoutineSignalEvidence = {
  policy: typeof ROUTINE_POLICY;
  stage: RoutineStage;
  sidecarId: string | null;
  /** Allowlisted material schedule, never a title/app/account fingerprint. */
  cadence?: ReportCadence;
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

/** Why a capture is not classified at all, or null when it is read. */
export type RoutineAbstention = 'excluded' | 'invalid' | 'oversize' | 'private' | 'reading';

/**
 * The gates in front of the phrase matching, in the order classifyJobSignals
 * applies them. Exported so a local field measurement (#1068) can say which
 * gate a real screen stopped at without re-implementing them.
 */
export function routineAbstention(input: RoutineCapture): RoutineAbstention | null {
  if (input.excluded) return 'excluded';
  if (!input.captureId || !Number.isSafeInteger(input.timestamp)) return 'invalid';
  const title = input.windowTitle ?? '';
  const ocr = input.ocrText ?? '';
  const app = input.app || 'Unknown app';
  // Overflow abstains instead of truncating away a privacy/research qualifier.
  if (title.length > 240 || ocr.length > MAX_ROUTINE_OCR_CHARS || app.length > 100
    || (input.sidecarId?.length ?? 0) > 200) return 'oversize';
  const text = `${title}\n${ocr}`;
  if (PRIVATE_CONTEXT.test(`${app}\n${text}`)) return 'private';
  if (READING_CONTEXT.test(text)) return 'reading';
  return null;
}

/**
 * The one stage this screen's text gives one routine family, or null. Shared
 * with the field measurement (#1068), so "would have matched" there means
 * exactly what the classifier does.
 */
export function routineStage(job: RoutineDefinition, text: string): { stage: RoutineStage; cadence?: ReportCadence } | null {
  // Choose one stage per screen. A static page listing all three phases
  // cannot advance the sequence by being captured repeatedly.
  const stage = job.output.test(text) ? 'output'
    : job.source.test(text) ? job.operation.test(text) ? 'operation' : 'source' : null;
  if (!stage) return null;
  const cadences = job.kind === 'recurring_report'
    ? new Set([...text.matchAll(/\b(daily|weekly|monthly) (?:sales |revenue |pipeline |performance |status )?report\b/gi)]
      .map(m => m[1]!.toLowerCase())) : new Set<string>();
  // Ambiguous schedules must not mint a fresh identity that bypasses suppression.
  if (cadences.size > 1) return null;
  const cadence = reportCadence([...cadences][0]);
  return cadence ? { stage, cadence } : { stage };
}

export function classifyJobSignals(input: RoutineCapture): JobSignal[] {
  if (routineAbstention(input) !== null) return [];
  const text = `${input.windowTitle ?? ''}\n${input.ocrText ?? ''}`;
  const app = input.app || 'Unknown app';
  return ROUTINES.flatMap(job => {
    const read = routineStage(job, text);
    if (!read) return [];
    const { stage, cadence } = read;
    return [{ captureId: input.captureId, observedAt: input.timestamp, app,
      kind: job.kind, cue: job.cue,
      routine: { policy: ROUTINE_POLICY, stage, sidecarId: input.sidecarId || null, ...(cadence ? { cadence } : {}) } }];
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
  if (data.cadence !== undefined && !reportCadence(data.cadence)) return undefined;
  return { policy: ROUTINE_POLICY, stage: data.stage as RoutineStage, sidecarId: data.sidecarId as string | null,
    ...(data.cadence ? { cadence: reportCadence(data.cadence)! } : {}) };
}
