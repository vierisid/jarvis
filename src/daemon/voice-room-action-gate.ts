/**
 * What a voice path may do with a room action that changes more than the
 * screen (#973).
 *
 * A room action runs the dashboard handler, whose REST calls reach the daemon
 * as clicks: no authority check, no taint gate, no realtime blocked
 * categories. ROOM_ACTIONS says which authority categories each action
 * reaches, and this holds a voice path to the emergency state, the realtime
 * blocked categories and the taint gate the way its own tool calls are. The
 * authority engine's own decision (a level cap, a deny override) is not
 * consulted: the handlers are clicks, and a click is not judged by it either.
 *
 * A voice command is the person's authority (the owner's decision), so an
 * ordinary action goes. The line is taint, as in lifecycle-gate.ts and the
 * realtime tool path in the orchestrator: once a realtime session has read
 * outside content this turn, an action whose category the taint profile
 * governs is refused, and the model tells the person to say it again as a
 * fresh request. The realtime path refuses rather than raising a card for the
 * same reason the realtime tool path does: there is no approval card that can
 * carry a dashboard handler out.
 *
 * The classifier is different. It has no turn the taint gate can see, it reads
 * the last few assistant replies (which repeat whatever outside content those
 * turns read), and it grades its own impact and confidence, so nothing the
 * daemon derives decides whether it acts. For an action in the governed
 * categories it does not act on its own reading at all: it holds the action
 * and repeats back what it would do, and the person's "yes" runs it: a click,
 * or a plain spoken yes that ws-service reads from the transcript itself, on
 * the same dashboard, within a minute, with no other hold it could be about.
 * That keeps voice as the authority while the person checks the one thing
 * that can go wrong, which is the classifier's reading.
 */

import { DEFAULT_TAINT_GOVERNED, taintProfile, type TaintGating } from '../authority/taint-gating.ts';
import { roomActionCategories } from './room-actions.ts';

export type RealtimeRoomActionContext = {
  /** The emergency state when it stops execution (paused, killed), else null. */
  halted: string | null;
  /** The realtime config's `blocked_categories`. */
  blockedCategories: readonly string[];
  taintGating: TaintGating | null;
  /** Outside content the realtime session read since the person last spoke. */
  taint: ReadonlySet<string>;
};

/**
 * Why the realtime model may not send `ra`, as the tool result it reads, or
 * null when it may. Presentation actions always may. The order is the
 * realtime tool path's: emergency, blocked categories, taint.
 */
export function realtimeRoomActionRefusal(
  ra: { room: string; action: string },
  ctx: RealtimeRoomActionContext,
): string | null {
  const categories = roomActionCategories(ra.room, ra.action);
  if (categories.length === 0) return null;
  const what = `${ra.room}/${ra.action}`;
  if (ctx.halted) {
    return `[SYSTEM ${ctx.halted.toUpperCase()}] ${what} was not sent: actions are suspended while the system is ${ctx.halted}.`;
  }
  const blocked = categories.find((c) => ctx.blockedCategories.includes(c));
  if (blocked) {
    return `[BLOCKED] ${what} (${blocked}) is in the realtime blocked-categories list and was not sent.`;
  }
  const governed = taintProfile(ctx.taintGating, ctx.taint)?.governed_categories ?? [];
  const tainted = categories.find((c) => governed.includes(c));
  if (tainted) {
    return `[BLOCKED] ${what} (${tainted}) was not sent: this session read outside content (${[...ctx.taint].join(', ')}) and voice cannot approve it. `
      + 'Tell the user what you wanted to do and ask them to say it again as a fresh request.';
  }
  return null;
}

/**
 * Whether the classifier must hold `ra` for the person to confirm rather than
 * act on its own reading: any action reaching a category the taint gating
 * governs. The governed list is the codebase's one definition of an action
 * that must not follow from an unchecked reading, so an owner who narrows it
 * narrows this too. The gating's on/off switch does not apply: this is not a
 * taint check, since the classifier has no taint to check.
 */
export function classifierMustConfirmRoomAction(
  ra: { room: string; action: string },
  gating: TaintGating | null,
): boolean {
  const governed: readonly string[] = gating?.governed_categories ?? DEFAULT_TAINT_GOVERNED;
  return roomActionCategories(ra.room, ra.action).some((c) => governed.includes(c));
}
