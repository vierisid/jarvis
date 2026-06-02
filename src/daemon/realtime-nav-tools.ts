/**
 * Dashboard navigation + in-room actions exposed as TOOLS the realtime voice
 * model (gpt-realtime-2) can call. This is the "as intended" way to do voice
 * navigation: the LLM decides to act and calls a function, rather than a
 * parallel transcript classifier guessing (which fought the session and added
 * latency). Executed in ws-service against the existing broadcast* methods, so
 * the dashboard reacts exactly as it did for the old voice path.
 *
 * Keep the in-room action vocabulary here in sync with the classifier prompt in
 * src/agents/voice-intent-classifier.ts (the standard voice path's source).
 */

import type { LLMTool } from '../llm/provider.ts';

/** Room keys that map 1:1 to RoomKey in src/voice/intent.ts. */
export const REALTIME_ROOM_KEYS = [
  'workflows', 'memory', 'tools', 'agents', 'authority', 'logs',
  'calendar', 'goals', 'tasks', 'content', 'workspaces', 'settings',
] as const;

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
- settings: switch_tab{tab: general|profile|llm|channels|integrations|sidecar}, set_primary_llm{provider}, set_fallback_llm{fallback}, set_model{provider,model}, test_provider{provider}, enable_telegram, disable_telegram, enable_discord, disable_discord, set_stt_provider{provider}, enable_tts, disable_tts, set_tts_provider{provider}, set_tts_voice{voice}, set_heartbeat_interval{minutes}, set_heartbeat_aggressiveness{level: passive|moderate|aggressive}, restart_daemon, replay_onboarding{scope?: all|setup|profile|tutorial}. (Do NOT set API keys by voice.)
- tools: set_filter{filter: all|read|write|external|destructive}, search{query}, select{name}
- workflows: switch_tab{tab: list|editor|builder}, search{query}, set_filter{filter: all|active|paused}, select{name}, run{name?}, pause{name?}, enable{name?}, create_from_nl{prompt}
- agents: switch_tab{tab: command|orbital}, open_spawn_dialog, close_dialog, set_search{query}, spawn_agent{specialist,task?,context?}
- content: switch_view{view: kanban|list}, search{query}, set_filter{field: stage|type, value}, select{name}, create_content{title,type?}, advance{name?}, regress{name?}, schedule{name?,when}
- tasks: set_filter{status}, search{query}
- goals: set_filter{health}`;

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
        action: { type: 'string', enum: ['close', 'minimize', 'expand', 'restore'] },
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
