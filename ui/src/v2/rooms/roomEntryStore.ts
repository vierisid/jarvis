import { useSyncExternalStore } from "react";
import type { RoomKey } from "../router";

/**
 * Per-Room entry source store (Phase 6.8).
 *
 * Records HOW the user got into each Room so RoomShell can render a
 * contextual breadcrumb prefix. Without this, every Room shows the
 * same lonely "Workflows" breadcrumb regardless of whether the user
 * arrived via the palette, by Focusing an InlineCard in the thread,
 * by voice, or by deep-link refresh — and the user loses the trail
 * back to where they came from.
 *
 * Module-level state (not React) because the openers and the
 * RoomShell live in different parts of the tree, and the value is set
 * synchronously around `openRoom()` calls. `useSyncExternalStore`
 * gives us subscription semantics for the read side.
 *
 * Per-Room map (not global) so opening Room A with context X and then
 * opening Room B doesn't clobber X. When the user re-enters Room A,
 * its entry is still there.
 */

export type RoomEntrySource = "palette" | "thread" | "voice" | "direct";

export interface RoomEntry {
  source: RoomEntrySource;
  /** Optional label — e.g. an object title for palette object picks
   *  ("Q3 launch") or the InlineCard title for thread Focus picks. */
  context?: string;
  ts: number;
}

const SOURCE_LABEL: Record<RoomEntrySource, string> = {
  palette: "Palette",
  thread: "Thread",
  voice: "Voice",
  direct: "",
};

let entries: Partial<Record<RoomKey, RoomEntry>> = {};
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function setRoomEntry(
  room: RoomKey,
  source: RoomEntrySource,
  context?: string,
): void {
  entries = {
    ...entries,
    [room]: { source, context, ts: Date.now() },
  };
  emit();
}

export function getRoomEntry(room: RoomKey): RoomEntry | null {
  return entries[room] ?? null;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Read + subscribe to the entry record for a specific room. RoomShell
 * uses this to derive its breadcrumb prefix.
 */
export function useRoomEntry(room: RoomKey): RoomEntry | null {
  return useSyncExternalStore(
    subscribe,
    () => entries[room] ?? null,
    () => entries[room] ?? null,
  );
}

/**
 * Compose the breadcrumb segments for a Room given its entry record
 * and the Room's own static title. Empty source → just `[title]`.
 *
 * Examples:
 *   palette + no context     → ["Palette", "Tasks"]
 *   palette + "Q3 launch"    → ["Palette", "Q3 launch", "Tasks"]
 *   thread  + "Daily standup" → ["Thread", "Daily standup", "Tasks"]
 *   voice                    → ["Voice", "Tasks"]
 *   direct                   → ["Tasks"]
 */
export function composeBreadcrumb(
  entry: RoomEntry | null,
  roomTitle: string,
): string[] {
  if (!entry || entry.source === "direct") return [roomTitle];
  const prefix = SOURCE_LABEL[entry.source];
  const parts: string[] = [];
  if (prefix) parts.push(prefix);
  if (entry.context) parts.push(entry.context);
  parts.push(roomTitle);
  return parts;
}
