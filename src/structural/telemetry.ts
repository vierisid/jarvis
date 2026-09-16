/**
 * Structural Runtime - perception/action logging.
 *
 * The honesty signal for the structural path: one line per snapshot or act
 * saying what served it, how much of the surface the accessibility tree
 * covered, and whether the postcondition actually held. Two cases are worth
 * a line on their own - a surface too canvas-drawn to read structurally, and
 * an action whose outcome could not be confirmed - because both are moments
 * where the runtime is about to hand the model a worse answer than it looks.
 *
 * Local process logging only. Nothing here is transmitted: the daemon's
 * outbound telemetry is the four anonymous fields in src/telemetry/client.ts
 * (see docs/TELEMETRY.md) and this module adds nothing to it.
 */

import type { SemanticSurface } from './types.ts';

export type PerceptionEvent = {
  /** Same vocabulary as the surface it describes, so the two cannot drift. */
  provider: SemanticSurface['provider'];
  action: string;
  /** 0-1 structural coverage of the surface this event concerns. */
  coverage: number;
  /** Verification outcome, when a postcondition was checked. */
  verified?: boolean;
  /**
   * Set when the structural path could not fully serve the request and the
   * model was pointed at a screenshot instead.
   */
  visionRecommended?: 'low_coverage' | 'unverified_outcome';
  detail?: string;
};

export function recordPerception(ev: PerceptionEvent): void {
  if (!ev.visionRecommended && ev.verified !== false) return;
  const why = ev.visionRecommended ?? 'unverified';
  console.log(
    `[structural] ${why} action=${ev.action} provider=${ev.provider} ` +
      `coverage=${Math.round(ev.coverage * 100)}%${ev.detail ? ` - ${ev.detail}` : ''}`,
  );
}
