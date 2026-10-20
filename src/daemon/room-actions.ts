/**
 * The actions each dashboard room's `useRoomActions` handler carries out, and
 * therefore the only room actions a voice path may send (#969), with what
 * each one does beyond the screen it runs on (#973, #974).
 *
 * One table, read from both sides, the way room-tabs.ts is for tabs: the
 * RoomActionBus hands a room only the actions listed for it, the daemon
 * refuses anything else before it sends, and the voice vocabularies (the
 * classifier prompt and the realtime nav tool) may only offer what is here.
 * room-actions.test.ts reads every room's handler and fails if this table and
 * the handler's cases differ in either direction.
 *
 * Each action's impact is either `view`, when the handler changes only what
 * that dashboard shows (a tab, a filter, a dialog, a search), or the
 * authority categories of what its handler makes the daemon do, named the way
 * a tool's authorityGate names them. The handler's REST calls reach the
 * daemon as clicks, which no authority check sees, so this is the only place
 * a voice path can learn what an action really does:
 *
 *  - a `view` action is presentation, and goes to every dashboard so they
 *    stay in step; any other goes only to the dashboard that asked, or it
 *    runs once per open dashboard (#974);
 *  - the categories say what a voice path is held to before it sends one
 *    (#973).
 *
 * The categories are the worst the handler's own calls can do, not the usual
 * case: `select_project` starts the project's dev server when it is stopped,
 * which runs `make dev` from a Makefile the model may have written. What
 * happens later, on the daemon's own schedule, is not counted: a task with a
 * due date is a `write_data` now, and the agent turn the CommitmentExecutor
 * runs when it falls due is judged by the background profile then.
 *
 * Authority grants and revokes are deliberately absent: they write a lasting
 * override into config.yaml, and no voice path is gated by the authority
 * engine, so they are clicks in the Grants tab only.
 *
 * A room that is not listed takes no actions. NO IMPORTS: the UI bundles this
 * file.
 */

/**
 * The authority categories a room action can reach. A subset of ActionCategory
 * (src/roles/authority.ts); room-actions.test.ts holds it to that type.
 */
export type RoomActionCategory =
  | 'read_data'
  | 'write_data'
  | 'delete_data'
  | 'execute_command'
  | 'install_software'
  | 'modify_settings'
  | 'spawn_agent';

export type RoomActionImpact = 'view' | readonly [RoomActionCategory, ...RoomActionCategory[]];

const VIEW = 'view';

export const ROOM_ACTIONS = {
  settings: {
    switch_tab: VIEW,
    read_status: VIEW,
    set_default_model: ['modify_settings'],
    set_model: ['modify_settings'],
    // An outbound call to the provider with the stored key; changes nothing.
    test_provider: ['read_data'],
    enable_telegram: ['modify_settings'],
    disable_telegram: ['modify_settings'],
    enable_discord: ['modify_settings'],
    disable_discord: ['modify_settings'],
    set_stt_provider: ['modify_settings'],
    enable_tts: ['modify_settings'],
    disable_tts: ['modify_settings'],
    set_tts_provider: ['modify_settings'],
    set_tts_voice: ['modify_settings'],
    // Restarts the 24/7 service through launchctl or systemctl.
    restart_daemon: ['execute_command'],
    // Scope "all" (the default) clears the user profile.
    replay_onboarding: ['delete_data', 'modify_settings'],
  },
  agents: {
    switch_tab: VIEW,
    open_spawn_dialog: VIEW,
    close_dialog: VIEW,
    set_search: VIEW,
    spawn_agent: ['spawn_agent'],
  },
  authority: { switch_tab: VIEW, set_filter: VIEW },
  memory: {
    switch_tab: VIEW,
    search: VIEW,
    set_filter: VIEW,
    select: VIEW,
    // Stored as source "dashboard", i.e. as if the person typed it.
    remember_that: ['write_data'],
  },
  goals: { switch_tab: VIEW, search: VIEW, set_filter: VIEW, select: VIEW, create_goal: ['write_data'] },
  tasks: {
    switch_view: VIEW,
    search: VIEW,
    set_filter: VIEW,
    select: VIEW,
    // A task with a due date is a commitment the CommitmentExecutor runs as
    // an agent turn once it falls due.
    create_task: ['write_data'],
    complete_task: ['write_data'],
    update_priority: ['write_data'],
    reassign: ['write_data'],
  },
  workspaces: {
    switch_view: VIEW,
    search: VIEW,
    // Opening a stopped project starts its dev server (`make dev`).
    select_project: ['execute_command'],
    back_to_list: VIEW,
    // Scaffolds with the template's CLI and `make install`, then opens it.
    create_project: ['install_software', 'execute_command'],
    start_server: ['execute_command'],
    stop_server: ['execute_command'],
  },
  content: {
    switch_view: VIEW,
    search: VIEW,
    set_filter: VIEW,
    select: VIEW,
    create_content: ['write_data'],
    advance: ['write_data'],
    regress: ['write_data'],
    schedule: ['write_data'],
  },
  tools: { set_filter: VIEW, search: VIEW, select: VIEW },
  logs: { toggle_source: VIEW, set_time_window: VIEW, toggle_live_tail: VIEW, refresh: VIEW },
  calendar: {
    switch_view: VIEW,
    search: VIEW,
    select_event: VIEW,
    // A commitment, like create_task.
    schedule_event: ['write_data'],
  },
  workflows: { create_from_nl: ['write_data'] },
} as const satisfies Record<string, Record<string, RoomActionImpact>>;

export type ActionRoom = keyof typeof ROOM_ACTIONS;
export type RoomActionName<R extends ActionRoom> = keyof (typeof ROOM_ACTIONS)[R] & string;

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** What `room`'s `action` does, or null when its handler does not carry it out. */
export function roomActionImpact(room: string, action: unknown): RoomActionImpact | null {
  if (!own(ROOM_ACTIONS, room) || typeof action !== 'string') return null;
  const actions = ROOM_ACTIONS[room as ActionRoom] as Record<string, RoomActionImpact>;
  return own(actions, action) ? actions[action]! : null;
}

/** Whether `room`'s handler carries out `action`. False for any room not listed. */
export function isRoomAction(room: string, action: unknown): boolean {
  return roomActionImpact(room, action) !== null;
}

/**
 * Whether `action` only changes what the dashboard running it shows, so it
 * may go to every dashboard. False for anything not listed: an action the
 * table does not know is never presentation.
 */
export function isPresentationRoomAction(room: string, action: unknown): boolean {
  return roomActionImpact(room, action) === VIEW;
}

/** The categories a listed, non-view action reaches; empty for a view or unlisted one. */
export function roomActionCategories(room: string, action: unknown): readonly RoomActionCategory[] {
  const impact = roomActionImpact(room, action);
  return impact === null || impact === VIEW ? [] : impact;
}
