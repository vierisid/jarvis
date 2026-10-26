/**
 * The pebble's "open <room>" / "close <room>" fast path (T18), and what it
 * says afterwards (#1026).
 *
 * It used to build "Opening X." or "Closing X." before doing anything, mirror
 * that to the dashboard at once, and speak it whatever happened next: a
 * panel.spawn that threw was only logged, and a close with no tracked panel
 * logged "close is a no-op". The line now follows the outcome, as the in-panel
 * tab switch does (#933), and goes out once, through the confirmation itself.
 *
 * "Not open" means not open as far as this daemon tracks: panels the pebble or
 * the palette opened on this sidecar, until the sidecar reports them closed.
 * The tray's dashboard window is not a room panel, so the reply says what the
 * pebble can see rather than claiming the room is closed everywhere.
 *
 * NO IMPORTS beyond types: everything live is passed in, so this is testable
 * without the daemon.
 */

import type { ConfirmationCtrl, SpeakConfirmation } from './pebble-confirmation.ts';

export type RoomPanelIntent = { action: 'open' | 'close'; key: string; title: string };

export interface RoomPanelDeps {
  setState: (sidecarId: string, state: string, text?: string) => Promise<void>;
  /** The fast paths' one confirmation (pebble-confirmation.ts); it mirrors the line too. */
  speak: SpeakConfirmation;
  /** panel.spawn for this room; resolves to the RPC result, throws when it failed. */
  openPanel: (sidecarId: string, key: string) => Promise<unknown>;
  /** panel.close for one tracked panel; throws when it failed. */
  closePanel: (sidecarId: string, id: string) => Promise<void>;
  /** The most recent tracked panel showing this room, or null. */
  findPanel: (sidecarId: string, key: string) => { id: string } | null;
  trackPanel: (sidecarId: string, entry: { id: string; key: string; title: string }) => void;
  untrackPanel: (sidecarId: string, id: string) => void;
  log?: (message: string) => void;
  warn?: (message: string, err: unknown) => void;
}

/** What the pebble says once an open or close has settled. */
export function roomPanelReply(
  intent: RoomPanelIntent,
  outcome: 'done' | 'failed' | 'not_open',
): string {
  const { action, title } = intent;
  if (outcome === 'done') return action === 'open' ? `Opened ${title}.` : `Closed ${title}.`;
  if (outcome === 'not_open') return `I don't see an open ${title} window.`;
  return action === 'open' ? `I couldn't open ${title}.` : `I couldn't close ${title}.`;
}

export async function runRoomPanelIntent(
  deps: RoomPanelDeps,
  sidecarId: string,
  intent: RoomPanelIntent,
  ctrl: ConfirmationCtrl,
): Promise<void> {
  const { action, key, title } = intent;
  // A turn already cancelled is left to whoever cancelled it (#964).
  if (ctrl.cancelled) return;
  // Show it is working: a spawn can take a moment, and nothing is said until
  // it has settled.
  await deps.setState(sidecarId, 'thinking', '');

  let outcome: 'done' | 'failed' | 'not_open';
  if (action === 'open') {
    try {
      const result = await deps.openPanel(sidecarId, key);
      // panel.spawn returns { id: "<panel-id>" }: track it so window commands
      // ("expand it", "close the workflows window") can find it.
      const id = (result && typeof result === 'object' && 'id' in (result as object))
        ? String((result as { id?: unknown }).id ?? '')
        : '';
      if (id) deps.trackPanel(sidecarId, { id, key, title });
      outcome = 'done';
    } catch (err) {
      deps.warn?.(`[ambient-ui] panel.spawn(${key}) failed:`, err);
      outcome = 'failed';
    }
  } else {
    // Several panels of one room (two workflow windows): close the most recent.
    const target = deps.findPanel(sidecarId, key);
    if (!target) {
      deps.log?.(`[ambient-ui] no tracked panel for key "${key}": nothing to close`);
      outcome = 'not_open';
    } else {
      try {
        await deps.closePanel(sidecarId, target.id);
        deps.untrackPanel(sidecarId, target.id);
        outcome = 'done';
      } catch (err) {
        // The sidecar no longer has that window (a panel.closed event that
        // never arrived): drop the dead id, and say it is not open, which is
        // what is true. The sidecar's text is panels.go's ErrPanelUnknown,
        // "panel.close[<id>]: panel not found".
        if (/panel not found|unknown panel/i.test(String(err))) {
          deps.log?.(`[ambient-ui] panel.close(${key}): sidecar no longer has ${target.id}; dropped it`);
          deps.untrackPanel(sidecarId, target.id);
          outcome = 'not_open';
        } else {
          deps.warn?.(`[ambient-ui] panel.close(${key}) failed:`, err);
          outcome = 'failed';
        }
      }
    }
  }
  await deps.speak(sidecarId, roomPanelReply(intent, outcome), ctrl);
}
