/**
 * W3-T2 — Per-room window state persistence.
 *
 * Stores the last known bounds (x, y, w, h) for each spawnable room so
 * voice / palette / direct opens land the panel where the user left it.
 * Lives at ~/.jarvis/window-state.json so it's per-machine — different
 * monitors warrant different positions.
 *
 * Keyed by room key (workflows / memory / settings / …) rather than panel
 * id because panel ids are ephemeral — every spawn gets a fresh UUID. We
 * trade some precision (multiple workflows windows would overwrite each
 * other) for the common case (one panel per room).
 *
 * Writes are debounced 400 ms so an active drag doesn't fsync at 60 Hz.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type RoomBounds = { x: number; y: number; w: number; h: number };

type WindowStateFile = {
  version: 1;
  rooms: Record<string, RoomBounds>;
};

const STATE_DIR = path.join(os.homedir(), '.jarvis');
const STATE_PATH = path.join(STATE_DIR, 'window-state.json');
const WRITE_DEBOUNCE_MS = 400;

let state: WindowStateFile | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function loadFromDisk(): WindowStateFile {
  if (!existsSync(STATE_PATH)) {
    return { version: 1, rooms: {} };
  }
  try {
    const raw = readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WindowStateFile>;
    if (parsed && parsed.version === 1 && parsed.rooms && typeof parsed.rooms === 'object') {
      return { version: 1, rooms: parsed.rooms };
    }
  } catch (err) {
    console.warn('[window-state] failed to parse — starting fresh:', err);
  }
  return { version: 1, rooms: {} };
}

function ensureLoaded(): WindowStateFile {
  if (state === null) state = loadFromDisk();
  return state;
}

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushWindowState();
  }, WRITE_DEBOUNCE_MS);
}

/** Sync write — used on shutdown to flush a pending debounce. */
export function flushWindowState(): void {
  if (!state) return;
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[window-state] failed to write:', err);
  }
}

/** Returns the saved bounds for a room key, or null if none saved. */
export function getRoomBounds(roomKey: string): RoomBounds | null {
  const s = ensureLoaded();
  return s.rooms[roomKey] ?? null;
}

/** Save / overwrite bounds for a room key (debounced to disk). */
export function setRoomBounds(roomKey: string, bounds: RoomBounds): void {
  const s = ensureLoaded();
  const cur = s.rooms[roomKey];
  if (cur && cur.x === bounds.x && cur.y === bounds.y && cur.w === bounds.w && cur.h === bounds.h) {
    return; // no change
  }
  s.rooms[roomKey] = { ...bounds };
  scheduleWrite();
}

/**
 * Clamp saved bounds against a viewport so a window that was last on a
 * monitor that's no longer plugged in doesn't end up stranded off-screen.
 * Returns adjusted bounds if any axis was outside; returns the original
 * if everything fits.
 *
 * `viewport` is the virtual-screen rect in OS pixels: { x, y, w, h }.
 * Pass the result of `platformGetVirtualScreenOrigin()` + total screen
 * size, or just `{ x: 0, y: 0, w, h }` for the primary monitor.
 */
export function clampBoundsToViewport(
  bounds: RoomBounds,
  viewport: { x: number; y: number; w: number; h: number },
): RoomBounds {
  const MIN_VISIBLE = 80; // at least this many pixels of the panel must be in the viewport
  const maxX = viewport.x + viewport.w - MIN_VISIBLE;
  const maxY = viewport.y + viewport.h - MIN_VISIBLE;
  const minX = viewport.x - bounds.w + MIN_VISIBLE;
  const minY = viewport.y - bounds.h + MIN_VISIBLE;
  const x = Math.min(Math.max(bounds.x, minX), maxX);
  const y = Math.min(Math.max(bounds.y, minY), maxY);
  if (x === bounds.x && y === bounds.y) return bounds;
  return { x, y, w: bounds.w, h: bounds.h };
}
