/**
 * D26's gesture, in the world it actually has to happen in.
 *
 * The decision says: the main pebble moves aside, goes to the finished agent
 * and hovers over it, so the founder sees exactly where to click. A physical
 * gesture, not an instruction.
 *
 * The complication is that by the time this beat fires there is no conductor.
 * The conducted hour ended with a stand-down: the conductor's layer unmounted,
 * its pebble went, its socket closed. The pebble on screen from that moment on
 * is the SHELL's own docked one (`.rs-peb`), which belongs to a different
 * component and hears about the world on a different socket.
 *
 * Three ways out were available and only one of them is honest:
 *
 *  - Bring the conductor back to do it. It would have to re-arm a socket and
 *    re-mount a layer whose whole purpose was to get out of the way, ten
 *    minutes after telling the founder it had.
 *  - Draw a second pebble in the trial's layer and fly that. That is the bug
 *    the handover was built to fix: two pebbles nine pixels apart read as one
 *    pebble cut in two.
 *  - Move the pebble that is already there.
 *
 * So the trial's day-one layer takes the shell's own pebble by the hand: it
 * measures it, sets an inline transform on it, and clears it afterwards. That
 * is safe here specifically because `.rs-peb` carries no transform of its own
 * in any state (roomShell.css sets position, flex and colour on it and nothing
 * else), so setting one adds a property that was not there and removing it
 * restores the element exactly. The transition is applied inline too, for the
 * same reason: the trial owns the whole of this effect and leaves nothing
 * behind.
 *
 * The functions below are the arithmetic, kept out of the component so the
 * placement can be checked without a browser.
 */

export type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** How far off the row the pebble stands. Close enough to point, far enough
 *  not to sit on the thing it is pointing at. */
export const GESTURE_GAP = 14;

/**
 * Where the pebble has to go to stand beside a finished agent's row.
 *
 * It approaches from the LEFT and stops level with the middle of the row,
 * rather than landing on top of it. The row is the only thing on screen the
 * founder is meant to read and then click: its name, its elapsed time and the
 * first two lines of what it found. A pebble hovering over that covers the
 * result it is pointing at, which is the gesture defeating itself.
 *
 * When there is no room on the left, as there is not in a 290px panel, it
 * stands to the right instead and the caller opens the label the other way.
 */
export function flightToRow(pebble: Rect, row: Rect): { dx: number; dy: number; side: 'left' | 'right' } {
  const wantLeft = row.left - GESTURE_GAP - pebble.width;
  const side: 'left' | 'right' = wantLeft >= 8 ? 'left' : 'right';
  const targetLeft = side === 'left' ? wantLeft : row.right + GESTURE_GAP;
  return {
    dx: Math.round(targetLeft - pebble.left),
    dy: Math.round((row.top + row.height / 2) - (pebble.top + pebble.height / 2)),
    side,
  };
}

/** Where the label sits, in viewport coordinates, once the pebble has landed. */
export function labelAt(
  pebble: Rect,
  flight: { dx: number; dy: number; side: 'left' | 'right' },
): { left: number; top: number; align: 'left' | 'right' } {
  const landedLeft = pebble.left + flight.dx;
  const landedMid = pebble.top + flight.dy + pebble.height / 2;
  return flight.side === 'left'
    ? { left: Math.max(8, landedLeft - GESTURE_GAP), top: Math.round(landedMid), align: 'right' }
    : { left: Math.round(landedLeft + pebble.width + GESTURE_GAP), top: Math.round(landedMid), align: 'left' };
}

/** The anchor a finished agent's row carries, so the daemon can name a row
 *  without knowing anything about how the strip is drawn. */
export function agentAnchor(taskId: string): string {
  return `agent:${taskId}`;
}
