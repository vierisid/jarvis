/**
 * The pebble's native room panels: the realtime nav tools the voice model
 * calls (open_dashboard_room, dashboard_room_action, control_dashboard_window)
 * and the command palette's room pick. Both open a room panel on a sidecar's
 * machine from a key someone else supplied: the model's tool arguments, or the
 * body of POST /api/palette/pick. The panel bookkeeping and the sidecar RPC
 * stay in index.ts and come in as deps, so this can be driven in tests.
 */

import { pebbleRoom } from './pebble-intents.ts';
import { pebbleRoomActionResult, REALTIME_NAV_TOOL_NAMES } from './realtime-nav-tools.ts';

export type PebblePanelEntry = { id: string; key: string; title: string };

export type PebbleRoomDeps = {
  dispatchRPC: (sidecarId: string, method: string, params: Record<string, unknown>) => Promise<unknown>;
  dashboardURL: (key: string) => string;
  boundsForRoom: (key: string, fallbackW: number, fallbackH: number) => { x: number; y: number; w: number; h: number };
  trackPanel: (sidecarId: string, entry: PebblePanelEntry) => void;
};

export type PebbleNavDeps = PebbleRoomDeps & {
  untrackPanel: (sidecarId: string, id: string) => void;
  findPanel: (sidecarId: string, hint?: string) => PebblePanelEntry | null;
};

const panelId = (result: unknown): string =>
  (result && typeof result === 'object' && 'id' in (result as object))
    ? String((result as { id?: unknown }).id ?? '') : '';

/** The sidecar window states an action names. A Map, so only these keys answer (#975). */
const WINDOW_STATES = new Map<string, string>([
  ['maximize', 'maximized'], ['maximized', 'maximized'],
  ['minimize', 'minimized'], ['minimized', 'minimized'],
  ['restore', 'normal'], ['normal', 'normal'],
]);
const windowState = (action: string): string | null => WINDOW_STATES.get(action) ?? null;

/**
 * Executes a realtime nav tool on the pebble's machine. Returns a
 * confirmation, or null if `name` isn't a nav tool so the caller falls
 * through to the agent tool bridge.
 */
export function makePebbleNavTool(deps: PebbleNavDeps) {
  return async (sidecarId: string, name: string, args: Record<string, unknown>): Promise<string | null> => {
    if (!REALTIME_NAV_TOOL_NAMES.has(name)) return null;
    const openRoom = async (key: string): Promise<string> => {
      const meta = pebbleRoom(key);
      if (!meta) return `I don't have a "${key}" screen.`;
      try {
        const result = await deps.dispatchRPC(sidecarId, 'panel.spawn', {
          url: deps.dashboardURL(key),
          title: meta.title,
          bounds: deps.boundsForRoom(key, meta.w, meta.h),
          resizable: true,
          always_on_top: meta.alwaysOnTop ?? false,
          multi_instance: false,
        });
        const id = panelId(result);
        if (id) deps.trackPanel(sidecarId, { id, key, title: meta.title });
        return `Opened ${meta.title}.`;
      } catch (err) {
        console.warn(`[pebble-realtime] open room "${key}" failed:`, err);
        return `I couldn't open ${meta.title}.`;
      }
    };
    switch (name) {
      case 'open_dashboard_room':
        return openRoom(String(args.room ?? ''));
      case 'dashboard_room_action':
        // Only the room is opened here; the action itself is not sent. The
        // model is told so, or "Opened Settings." reads as the TTS toggle
        // it asked for having happened (#965).
        return pebbleRoomActionResult(await openRoom(String(args.room ?? '')), String(args.action ?? ''));
      case 'control_dashboard_window': {
        const action = String(args.action ?? '');
        const target = deps.findPanel(sidecarId, args.target ? String(args.target) : undefined);
        if (!target) return "There's no window open to do that with.";
        try {
          if (action === 'close') {
            await deps.dispatchRPC(sidecarId, 'panel.close', { id: target.id });
            deps.untrackPanel(sidecarId, target.id);
            return `Closed ${target.title}.`;
          }
          if (action === 'focus') {
            await deps.dispatchRPC(sidecarId, 'panel.focus', { id: target.id });
            return 'Here it is.';
          }
          const state = windowState(action);
          if (state) {
            await deps.dispatchRPC(sidecarId, 'panel.set_window_state', { id: target.id, state });
            return `Done.`;
          }
          return "I'm not sure how to do that with the window.";
        } catch {
          return "I couldn't do that with the window.";
        }
      }
      case 'go_back_to_thread':
        return 'Okay.'; // the pebble has no dashboard thread to return to
      default:
        return null;
    }
  };
}

export type PalettePickDeps = PebbleRoomDeps & {
  /** The sidecar whose palette is open, else the first connected one. */
  pickSidecar: () => string | null;
  closePalette: (sidecarId: string) => Promise<void>;
};

/**
 * The palette's room pick. It reuses the same panel.spawn path that voice
 * "open workflows" uses, so the room shows up tracked exactly the same way.
 */
export function makePalettePick(deps: PalettePickDeps) {
  return async ({ kind, key }: { kind: string; key: string }): Promise<void> => {
    if (kind !== 'room') return; // object picks not yet wired in panel mode
    const meta = pebbleRoom(key);
    if (!meta) {
      console.warn(`[palette] pick: unknown room "${key}"`);
      return;
    }
    const sidecarId = deps.pickSidecar();
    if (!sidecarId) return;
    // Close palette before spawning the room so the focus doesn't
    // bounce. Spawn returns an `id` we track for window-mgmt
    // commands.
    await deps.closePalette(sidecarId);
    try {
      const result = await deps.dispatchRPC(sidecarId, 'panel.spawn', {
        url: deps.dashboardURL(key),
        title: meta.title,
        bounds: deps.boundsForRoom(key, meta.w, meta.h),
        resizable: true,
        always_on_top: meta.alwaysOnTop ?? false,
        multi_instance: false,
      });
      const id = panelId(result);
      if (id) deps.trackPanel(sidecarId, { id, key, title: meta.title });
    } catch (err) {
      console.warn(`[palette] panel.spawn(${key}) from pick failed:`, err);
    }
  };
}
