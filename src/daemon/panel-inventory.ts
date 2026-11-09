import { pebbleRoom } from './pebble-intents.ts';

/**
 * One native window the daemon opened on a sidecar and can target by voice
 * ("close it", "expand the tasks window"): a room panel, a full answer or a
 * sub-agent result. `key` is the room key, or `answer_full` / `task_full`.
 */
export type PanelEntry = { id: string; key: string; title: string };

/**
 * Track a window as this sidecar's most recent. One entry per id: a window
 * tracked again (a rebuild that listed it while its spawn was answering, or a
 * focus) moves to the end rather than appearing twice, so closing it leaves
 * nothing behind (#1157).
 */
export function trackPanelIn(panels: Map<string, PanelEntry[]>, sidecarId: string, entry: PanelEntry): void {
  const list = (panels.get(sidecarId) ?? []).filter(e => e.id !== entry.id);
  list.push(entry);
  panels.set(sidecarId, list);
}

/** Forget a window that closed. */
export function untrackPanelIn(panels: Map<string, PanelEntry[]>, sidecarId: string, id: string): void {
  const list = panels.get(sidecarId);
  if (!list) return;
  const kept = list.filter(e => e.id !== id);
  if (kept.length === 0) panels.delete(sidecarId);
  else panels.set(sidecarId, kept);
}

/** Panel ids are the sidecar's (uuids, or the daemon's own fixed ids). */
const PANEL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The tracked entry a panel the sidecar lists stands for, read from the URL
 * the daemon spawned it with; null for any window the daemon does not track
 * (the palette, the pebble, a page it does not recognise). The title is the
 * daemon's own, never the listed one, because it reaches the model's context.
 */
export function trackedPanelFrom(listed: unknown): PanelEntry | null {
  if (!listed || typeof listed !== 'object') return null;
  const { id, url } = listed as { id?: unknown; url?: unknown };
  if (typeof id !== 'string' || !PANEL_ID.test(id) || typeof url !== 'string') return null;
  let hash: string;
  try { hash = new URL(url).hash; } catch { return null; }
  const room = /^#\/_panel_([A-Za-z0-9_]+)$/.exec(hash);
  if (room) {
    const meta = pebbleRoom(room[1]);
    return meta ? { id, key: room[1]!, title: meta.title } : null;
  }
  if (/^#\/_answer_[^\s/]+$/.test(hash)) return { id, key: 'answer_full', title: 'JARVIS answer' };
  if (/^#\/_task_[^\s/]+$/.test(hash)) return { id, key: 'task_full', title: 'Sub-agent result' };
  return null;
}

/**
 * The panels a `panel.list` answer describes, oldest first, or null when the
 * sidecar predates the `panels` field (it sends only `ids`), so the caller
 * keeps what it has.
 */
export function listedPanels(result: unknown): PanelEntry[] | null {
  const panels = result && typeof result === 'object' ? (result as { panels?: unknown }).panels : undefined;
  if (!Array.isArray(panels)) return null;
  const seen = new Set<string>();
  const out: PanelEntry[] = [];
  for (const listed of panels) {
    const entry = trackedPanelFrom(listed);
    if (entry && !seen.has(entry.id)) { seen.add(entry.id); out.push(entry); }
  }
  return out;
}

/**
 * Rebuild one sidecar's inventory after it connects (#1157). A sidecar keeps
 * its windows across a dropped link and a daemon restart, but the daemon
 * forgets them on disconnect, so without this "close it" or "expand the tasks
 * window" finds nothing after a reconnect. The listed panels come first, as
 * they are older than anything tracked while the list was in flight; a window
 * that closed meanwhile is left out. `closedSince` answers null once this
 * connection is gone (a disconnect, or a newer connection's rebuild), and
 * then nothing is applied. Returns how many were added.
 */
export async function rebuildPanelInventory(
  sidecarId: string,
  panels: Map<string, PanelEntry[]>,
  list: (sidecarId: string) => Promise<unknown>,
  closedSince: () => ReadonlySet<string> | null,
): Promise<number> {
  const listed = listedPanels(await list(sidecarId));
  const closed = closedSince();
  if (!listed?.length || !closed) return 0;
  const current = panels.get(sidecarId) ?? [];
  const known = new Set(current.map(e => e.id));
  const added = listed.filter(e => !known.has(e.id) && !closed.has(e.id));
  if (added.length) panels.set(sidecarId, [...added, ...current]);
  return added.length;
}
