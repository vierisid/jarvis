import type { JobSignal } from './opportunity-types.ts';
import { parseRoutineEvidence } from './routine-signals.ts';

export const OPPORTUNITY_WINDOW_MS = 14 * 86_400_000;
export const EPISODE_GAP_MS = 30 * 60_000;
export type RoutineEpisode = { source: JobSignal; operation: JobSignal; output: JobSignal };

/** Input is one kind, sorted/deduplicated here; a continuous session counts at most once. */
export function groupRoutineEpisodes(signals: JobSignal[], now: number): RoutineEpisode[] {
  const seen = new Set<string>();
  const observations = signals.filter(s => Number.isSafeInteger(s.observedAt)
    && s.observedAt >= now - OPPORTUNITY_WINDOW_MS && s.observedAt <= now
    && parseRoutineEvidence(s.routine)).sort((a, b) => a.observedAt - b.observedAt || a.captureId.localeCompare(b.captureId))
    .filter(s => !seen.has(s.captureId) && !!seen.add(s.captureId));
  const episodes: RoutineEpisode[] = [];
  const byDevice = new Map<string | null, { lastObserved: number; source?: JobSignal; operation?: JobSignal }>();
  let lastObserved = -Infinity;
  let counted = false;
  for (const signal of observations) {
    if (signal.observedAt - lastObserved >= EPISODE_GAP_MS) {
      byDevice.clear();
      counted = false;
    }
    lastObserved = signal.observedAt;
    if (counted) continue;
    const { sidecarId, stage } = parseRoutineEvidence(signal.routine)!;
    const previous = byDevice.get(sidecarId);
    // Other devices may keep the overall session active, but cannot carry a
    // stale source/operation forward on a device that has been idle.
    const pending = previous && signal.observedAt - previous.lastObserved < EPISODE_GAP_MS
      ? previous : { lastObserved: signal.observedAt };
    pending.lastObserved = signal.observedAt;
    if (stage === 'source' && !pending.source) pending.source = signal;
    if (stage === 'operation' && pending.source && signal.observedAt > pending.source.observedAt && !pending.operation) {
      pending.operation = signal;
    }
    if (stage === 'output' && pending.source && pending.operation && signal.observedAt > pending.operation.observedAt) {
      episodes.push({ source: pending.source, operation: pending.operation, output: signal });
      counted = true;
    }
    byDevice.set(sidecarId, pending);
  }
  return episodes;
}
