/**
 * Field measurement for routine detection (#1068).
 *
 * The routine corpora in ./fixtures are synthetic and were written with the
 * catalog's own phrases, so they cannot show how often the classifier fires on
 * real screens. This counts, over captures the owner's own Jarvis already
 * stored (screen_captures.ocr_text, on an opted-in machine), where each one
 * stopped: at a gate in front of the phrase matching, at each family's source,
 * operation and output phrase, or as an ordered episode. The numbers are what
 * a phrase change has to be argued from.
 *
 * Counts only. Nothing in the result carries OCR text, a window title, an app
 * name, a capture id, a sidecar id or a timestamp, so the report can be shared
 * without sharing the screens it was measured on.
 */
import { assessJobHypotheses } from '../job-hypotheses.ts';
import { ROUTINES } from '../routine-catalog.ts';
import { groupRoutineEpisodes } from '../routine-episodes.ts';
import { REPORT_CADENCES } from '../routine-identity.ts';
import { classifyJobSignals, routineAbstention, routineStage, type RoutineAbstention, type RoutineCapture } from '../routine-signals.ts';
import type { JobSignal } from '../opportunity-types.ts';

const DAY = 86_400_000;

type FamilyCounts = {
  /** Captures read by the classifier whose text matches the phrase, each tested alone. */
  sourcePhrase: number; operationPhrase: number; outputPhrase: number;
  /** An operation screen needs the source phrase too (routine-signals.ts). */
  sourceAndOperationPhrase: number;
  /** The one stage each read capture was given. */
  stages: { source: number; operation: number; output: number };
  /** Captures a gate stopped that the classifier would otherwise have given a stage for this family. */
  stoppedByGate: Record<'private' | 'reading' | 'oversize', number>;
  /**
   * Ordered source -> operation -> output episodes in the window, grouped as
   * the assessment groups them: recurring reports per cadence (`none` is a
   * report with no schedule word), the other families as one group.
   */
  episodes: Record<string, number>;
  /** Distinct UTC days the episodes start on, per group: a proposal needs 3 episodes on 2 or more. */
  episodeDays: Record<string, number>;
};

export type RoutineFieldReport = {
  schemaVersion: 1;
  data: 'local captures, counts only';
  captures: number;
  /**
   * Whole days between the oldest and newest capture measured. Captures are
   * deleted after awareness.retention (1 hour by default), so a short span
   * means the data was deleted, not that detection failed.
   */
  spanDays: number;
  /** Of all captures, those with no OCR text and no window title (also counted in abstained or read). */
  withoutText: number;
  abstained: Record<RoutineAbstention, number>;
  read: number;
  families: Record<string, FamilyCounts>;
  /** Routine kinds the real assessment would propose now, before dismissals or known patterns. */
  proposals: string[];
};

export function measureRoutineCaptures(captures: readonly RoutineCapture[], now: number): RoutineFieldReport {
  const abstained: Record<RoutineAbstention, number> = { excluded: 0, invalid: 0, oversize: 0, private: 0, reading: 0 };
  const families: Record<string, FamilyCounts> = {};
  for (const job of ROUTINES) {
    families[job.kind] = {
      sourcePhrase: 0, operationPhrase: 0, outputPhrase: 0, sourceAndOperationPhrase: 0,
      stages: { source: 0, operation: 0, output: 0 },
      stoppedByGate: { private: 0, reading: 0, oversize: 0 },
      episodes: {}, episodeDays: {},
    };
  }
  let withoutText = 0;
  let read = 0;
  const signals: JobSignal[] = [];
  for (const capture of captures) {
    if (!capture.ocrText && !capture.windowTitle) withoutText++;
    const text = `${capture.windowTitle ?? ''}\n${capture.ocrText ?? ''}`;
    const gate = routineAbstention(capture);
    if (gate !== null) {
      abstained[gate]++;
      if (gate === 'private' || gate === 'reading' || gate === 'oversize') {
        for (const job of ROUTINES) {
          if (routineStage(job, text)) families[job.kind]!.stoppedByGate[gate]++;
        }
      }
      continue;
    }
    read++;
    for (const job of ROUTINES) {
      const f = families[job.kind]!;
      const source = job.source.test(text);
      const operation = job.operation.test(text);
      if (source) f.sourcePhrase++;
      if (operation) f.operationPhrase++;
      if (source && operation) f.sourceAndOperationPhrase++;
      if (job.output.test(text)) f.outputPhrase++;
    }
    for (const signal of classifyJobSignals(capture)) {
      signals.push(signal);
      if (signal.routine) families[signal.kind]!.stages[signal.routine.stage]++;
    }
  }
  for (const job of ROUTINES) {
    // The same grouping as assessJobHypotheses: a report per cadence.
    const groups: Array<[string, string | undefined]> = job.kind === 'recurring_report'
      ? [['none', undefined], ...REPORT_CADENCES.map((c): [string, string] => [c, c])] : [['all', undefined]];
    for (const [name, cadence] of groups) {
      const episodes = groupRoutineEpisodes(signals.filter(s => s.kind === job.kind
        && (job.kind !== 'recurring_report' || s.routine?.cadence === cadence)), now);
      families[job.kind]!.episodes[name] = episodes.length;
      families[job.kind]!.episodeDays[name] = new Set(episodes.map(e => new Date(e.source.observedAt).toISOString().slice(0, 10))).size;
    }
  }
  const proposals = assessJobHypotheses(signals, [], new Set(), now).proposals.map(p => p.kind);
  const times = captures.map(c => c.timestamp).filter(t => Number.isSafeInteger(t));
  const spanDays = times.length ? Math.floor((Math.max(...times) - Math.min(...times)) / DAY) : 0;
  return { schemaVersion: 1, data: 'local captures, counts only', captures: captures.length, spanDays, withoutText, abstained, read, families, proposals };
}
