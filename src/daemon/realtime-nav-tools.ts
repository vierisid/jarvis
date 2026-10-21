/**
 * Dashboard navigation + in-room actions exposed as TOOLS the realtime voice
 * model (gpt-realtime-2) can call. This is the "as intended" way to do voice
 * navigation: the LLM decides to act and calls a function, rather than a
 * parallel transcript classifier guessing (which fought the session and added
 * latency). Executed in ws-service against the existing broadcast* methods, so
 * the dashboard reacts exactly as it did for the old voice path.
 *
 * The in-room action vocabulary here, like the classifier prompt in
 * src/agents/voice-intent-classifier.ts, may only name actions in
 * ROOM_ACTIONS (room-actions.ts); room-actions-vocabulary.test.ts holds both
 * to it, and ws-service refuses anything else before sending it (#969).
 */

import type { LLMTool } from '../llm/provider.ts';
import { ROOM_TABS, type TabbedRoom } from './room-tabs.ts';

/**
 * A room's switch_tab entry, built from ROOM_TABS so the model is only offered
 * tabs the room's handler accepts, and only rooms that have one (#965). The
 * hand-typed list offered Workflows tabs that do not exist and left real
 * Settings and Agents tabs out.
 */
const switchTab = (room: TabbedRoom): string => `switch_tab{tab: ${ROOM_TABS[room].join('|')}}`;

/** Room keys that map 1:1 to RoomKey in src/voice/intent.ts. */
export const REALTIME_ROOM_KEYS = [
  'workflows', 'memory', 'tools', 'agents', 'authority', 'logs',
  'calendar', 'goals', 'tasks', 'content', 'workspaces', 'usage', 'settings',
] as const;

/** The window actions control_dashboard_window offers, and the only ones it sends. */
export const REALTIME_WINDOW_ACTIONS = ['close', 'minimize', 'expand', 'restore'] as const;

export const REALTIME_NAV_TOOL_NAMES = new Set([
  'open_dashboard_room',
  'go_back_to_thread',
  'control_dashboard_window',
  'dashboard_room_action',
]);

// Compact action reference — action names + arg keys per room (the verbose
// "matches ..." examples from the classifier are omitted to keep token cost
// low; the GPT-5-class model infers usage from names + args).
const ROOM_ACTION_REFERENCE = `Available actions by room (pass via dashboard_room_action):
- settings: ${switchTab('settings')}, set_model{provider,model}, test_provider{provider}, enable_telegram, disable_telegram, enable_discord, disable_discord, set_stt_provider{provider}, enable_tts, disable_tts, set_tts_provider{provider}, set_tts_voice{voice}, restart_daemon, replay_onboarding{scope?: all|setup|profile|tutorial}. (Do NOT set API keys by voice.)
- tools: set_filter{filter: all|read|write|external|destructive}, search{query}, select{name}
- workflows: create_from_nl{prompt}
- agents: ${switchTab('agents')}, open_spawn_dialog, close_dialog, set_search{query}, spawn_agent{specialist,task?,context?}
- content: switch_view{view: kanban|list}, search{query}, set_filter{field: stage|type, value}, select{name}, create_content{title,type?}, advance{name?}, regress{name?}, schedule{name?,when}
- tasks: set_filter{field: status|priority|assigned_to, value}, search{query}
- goals: ${switchTab('goals')}, set_filter{field: status|health, value}
- memory: ${switchTab('memory')}
A "when" is a day and/or a time, like 'tomorrow at 3pm', 'friday at 10am', 'friday' or 'in an hour': an hour needs am/pm, a 24-hour clock or a part of day.`;
// Every action named here must be one its room carries out (ROOM_ACTIONS);
// anything else is refused before it is sent (#969), and
// room-actions-vocabulary.test.ts holds this list to the table.
// Authority is deliberately not listed, not even its tabs: nothing there
// needs voice, and its grants and revokes are clicks only (#965 review, #969).

/**
 * Navigation + in-room-action tools. Appended to the realtime toolset so the
 * model can drive the dashboard by voice ("open settings", "turn off TTS",
 * "go back to the thread", "close this window").
 */
export const REALTIME_NAV_TOOLS: LLMTool[] = [
  {
    name: 'open_dashboard_room',
    description:
      'Open a room/page in the JARVIS dashboard (navigate the UI). Use when the user asks to open, show, or go to a section.',
    parameters: {
      type: 'object',
      properties: {
        room: {
          type: 'string',
          enum: [...REALTIME_ROOM_KEYS],
          description: 'Which dashboard room to open.',
        },
      },
      required: ['room'],
    },
  },
  {
    name: 'go_back_to_thread',
    description:
      'Close any open room and return to the main conversation thread (home). Use for "back to the thread", "close the room", "go home".',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'control_dashboard_window',
    description:
      'Control an open room window: close, minimize, expand (fullscreen), or restore it.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...REALTIME_WINDOW_ACTIONS] },
        target: {
          type: 'string',
          description: 'Room key to target, or "most_recent" for the most recently opened window (default).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'dashboard_room_action',
    description:
      'Perform an action INSIDE a dashboard room — filtering, switching tabs, toggling a setting, running a workflow, etc. The room is auto-opened first, so use this (not open_dashboard_room) when the user asks to DO something in a room (e.g. "turn off TTS in settings", "show paused workflows").\n\n' +
      ROOM_ACTION_REFERENCE,
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', enum: [...REALTIME_ROOM_KEYS], description: 'Room the action belongs to.' },
        action: { type: 'string', description: 'Action name from the reference for that room.' },
        args: { type: 'object', description: 'Action arguments object (may be empty).' },
      },
      required: ['room', 'action'],
    },
  },
];

/**
 * The pebble's realtime session answers dashboard_room_action by opening the
 * room only; it does not send the action (#965). The tool result says so, so
 * the model does not report the action as done.
 */
export function pebbleRoomActionResult(opened: string, action: string): string {
  const what = action ? `"${action}"` : 'the action';
  return `${opened} I did not run ${what} inside it; tell the user it has not been done.`;
}
