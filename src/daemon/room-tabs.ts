/**
 * The tabs each dashboard room switches between, and therefore the only tab
 * names its `switch_tab` room action accepts (#933).
 *
 * One table, read from both sides: the rooms in ui/src/v2/rooms derive their
 * tab type and validate `switch_tab` against it, and the pebble's voice tab
 * switch (pebble-intents.ts) builds its spoken synonyms from it. The voice
 * table used to be a separate list that named `editor`, `list`, `logs`,
 * `tts` and others that no room had, so a tab switch could be announced for a
 * tab that did not exist.
 *
 * A room that is not listed has no tabs. NO IMPORTS: the UI bundles this file.
 */

export const ROOM_TABS = {
  settings: ['general', 'profile', 'llm', 'channels', 'voice', 'integrations', 'billing', 'sidecar'],
  agents: ['command', 'orbital', 'builder'],
  authority: ['approvals', 'audit', 'grants', 'learning'],
  memory: ['constellation', 'explorer', 'browser'],
  goals: ['constellation', 'timeline', 'metrics'],
} as const;

export type TabbedRoom = keyof typeof ROOM_TABS;
export type RoomTab<R extends TabbedRoom> = (typeof ROOM_TABS)[R][number];

/** The tabs `room` has, or null when it has none. */
export function roomTabs(room: string): readonly string[] | null {
  return Object.prototype.hasOwnProperty.call(ROOM_TABS, room)
    ? ROOM_TABS[room as TabbedRoom]
    : null;
}

/** Whether `tab` is one of `room`'s tabs. */
export function isRoomTab<R extends TabbedRoom>(room: R, tab: unknown): tab is RoomTab<R> {
  return typeof tab === 'string' && (ROOM_TABS[room] as readonly string[]).includes(tab);
}
