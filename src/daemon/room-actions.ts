/**
 * The actions each dashboard room's `useRoomActions` handler carries out, and
 * therefore the only room actions a voice path may send (#969).
 *
 * One table, read from both sides, the way room-tabs.ts is for tabs: the
 * RoomActionBus hands a room only the actions listed for it, the daemon
 * refuses anything else before it broadcasts, and the voice vocabularies (the
 * classifier prompt and the realtime nav tool) may only offer what is here.
 * room-actions.test.ts reads every room's handler and fails if this table and
 * the handler's cases differ in either direction.
 *
 * Authority grants and revokes are deliberately absent: they write a lasting
 * override into config.yaml, and no voice path is gated by the authority
 * engine, so they are clicks in the Grants tab only.
 *
 * A room that is not listed takes no actions. NO IMPORTS: the UI bundles this
 * file.
 */

export const ROOM_ACTIONS = {
  settings: [
    'switch_tab', 'read_status', 'set_default_model', 'set_model', 'test_provider',
    'enable_telegram', 'disable_telegram', 'enable_discord', 'disable_discord',
    'set_stt_provider', 'enable_tts', 'disable_tts', 'set_tts_provider', 'set_tts_voice',
    'set_heartbeat_interval', 'set_heartbeat_aggressiveness', 'restart_daemon', 'replay_onboarding',
  ],
  agents: ['switch_tab', 'open_spawn_dialog', 'close_dialog', 'set_search', 'spawn_agent'],
  authority: ['switch_tab', 'set_filter'],
  memory: ['switch_tab', 'search', 'set_filter', 'select', 'remember_that'],
  goals: ['switch_tab', 'search', 'set_filter', 'select', 'create_goal'],
  tasks: ['switch_view', 'search', 'set_filter', 'select', 'create_task', 'complete_task', 'update_priority', 'reassign'],
  workspaces: ['switch_view', 'search', 'select_project', 'back_to_list', 'create_project', 'start_server', 'stop_server'],
  content: ['switch_view', 'search', 'set_filter', 'select', 'create_content', 'advance', 'regress', 'schedule'],
  tools: ['set_filter', 'search', 'select'],
  logs: ['toggle_source', 'set_time_window', 'toggle_live_tail', 'refresh'],
  calendar: ['switch_view', 'search', 'select_event', 'schedule_event'],
  workflows: ['create_from_nl'],
} as const;

export type ActionRoom = keyof typeof ROOM_ACTIONS;
export type RoomActionName<R extends ActionRoom> = (typeof ROOM_ACTIONS)[R][number];

/** Whether `room`'s handler carries out `action`. False for any room not listed. */
export function isRoomAction(room: string, action: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(ROOM_ACTIONS, room)
    && typeof action === 'string'
    && (ROOM_ACTIONS[room as ActionRoom] as readonly string[]).includes(action);
}
