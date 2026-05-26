/**
 * Voice Intent Classifier — turns a raw STT transcript into a structured
 * `Intent` with confidence. Single LLM call; fast and cheap.
 *
 * Failure modes are swallowed: any classifier error returns a "permissive"
 * Intent (verb=ask, impact=read, confidence=0.85) so the daemon falls back
 * to the existing chat flow rather than wedging on bad classifier output.
 * The cost of a classifier outage is just losing the clarifier/repeat-back
 * routing — voice still works.
 */

import type { LLMManager } from '../llm/manager.ts';
import type { LLMMessage } from '../llm/provider.ts';
import { generateId } from '../vault/schema.ts';
import {
  type Impact,
  type Intent,
  type ObjectRef,
  type ObjectRefType,
  type RoomAction,
  type RoomKey,
  type Verb,
} from '../voice/intent.ts';

const VALID_ROOMS: ReadonlySet<RoomKey> = new Set([
  'workflows',
  'memory',
  'tools',
  'agents',
  'authority',
  'logs',
  'calendar',
  'goals',
  'tasks',
  'content',
  'workspaces',
  'settings',
]);

const VALID_VERBS: ReadonlySet<Verb> = new Set([
  'ask',
  'show',
  'run',
  'create',
  'update',
  'delete',
  'grant',
  'revoke',
  'pause',
  'resume',
  'unknown',
]);

const VALID_IMPACTS: ReadonlySet<Impact> = new Set(['read', 'write', 'destructive', 'external']);

const VALID_OBJECT_TYPES: ReadonlySet<ObjectRefType> = new Set([
  'workflow',
  'memory',
  'tool',
  'agent',
  'authority',
  'log',
  'goal',
  'calendar',
  'task',
  'content',
  'workspace',
  'settings',
  'file',
  'url',
  'thread',
]);

const SYSTEM_PROMPT = `You are a voice intent classifier for an agentic AI assistant.

Given a user's voice transcript and the recent conversation context, return a single JSON object describing what the user intends. Output JSON only — no prose, no code fences.

Schema:
{
  "verb": "ask" | "show" | "run" | "create" | "update" | "delete" | "grant" | "revoke" | "pause" | "resume" | "unknown",
  "object": { "type": "workflow"|"memory"|"tool"|"agent"|"authority"|"log"|"goal"|"calendar"|"task"|"content"|"workspace"|"settings"|"file"|"url"|"thread", "query": string } | null,
  "args": { ... } (free-form key/value extracted from the utterance, e.g. {"to":"alice@example.com"}),
  "impact": "read" | "write" | "destructive" | "external",
  "confidence": number between 0 and 1,
  "alternatives": [ { "label": string, "verb": ..., "object": ..., "args": ..., "impact": ... } ]  (0-2 items, only when ambiguous),
  "room_action": { "room": RoomKey, "action": string, "args": { ... } } | null,
  "confirmation_response": "approve" | "cancel" | null
}

Object type "thread" is special: it represents the home conversation view
(no Room open). Use it for "back" / "close" / "return" navigation intents.

Verb meanings:
- ask: read-only Q&A AND conversational chat ("what's on my calendar?", "how are you?", "I'm back at my desk", "good morning", "thanks", "what do you think about X")
- show: navigate / open ("open workflows")
- run: execute a workflow or tool ("run morning triage")
- create: new object ("draft a reply")
- update: edit existing
- delete: destructive remove
- grant / revoke: authority changes
- pause / resume: daemon control
- unknown: ONLY for garbled audio (noise, single syllables, broken words, partial phrases that don't form a coherent sentence). Multi-word coherent English is NEVER "unknown" — at minimum it's "ask" since the user can be replied to conversationally.

CRITICAL — conversational chat rule:
If the utterance is a coherent multi-word sentence and you cannot map it to a specific verb/object/room_action above, default to verb="ask", impact="read", confidence>=0.85. Greetings, small talk, status updates ("I'm back at the PC", "I'm ready to start working", "headed to a meeting"), open-ended questions ("how are you", "what do you think"), and any other chitchat ALL go through "ask" so the LLM can reply naturally. Reserve "unknown" with low confidence STRICTLY for transcripts that are not parseable English.

Impact bands (the SAFETY classification, distinct from verb):
- read: no side effects, no off-device access
- write: mutates local state (DB, files, agents) but recoverable
- external: reaches off-device (sends email/message, browser write to remote service)
- destructive: irreversible or costly (delete, payment, install, terminate)

Confidence guidance:
- 0.95+: utterance is clear and unambiguous, intent obvious from words alone
- 0.85-0.94: confident but minor ambiguity (you'd execute with no clarification)
- 0.6-0.84: plausibly two readings; would benefit from a clarifier
- <0.6: garbled, partial, or genuinely unclear; ask the user to repeat
- For garbled audio (just noise, single syllables, broken words), set verb="unknown" and confidence below 0.4
- ALWAYS lower confidence for destructive/external impact unless the utterance is precise

Confirmation responses:

When the utterance is a short affirmative or negative reply — without
naming a Room or a verb-object pair — set "confirmation_response" to
"approve" or "cancel". The daemon will resolve the most-recent pending
approval / clarifier / repeat-back if one exists; if not, it falls back
to the chat agent (so "yes" still works as a conversational reply).

Approve vocabulary: "approve", "approve it", "yes", "yes do it",
"confirm", "confirm it", "go ahead", "do it", "sure", "ok do it",
"sounds good", "looks right", "proceed".

Cancel vocabulary: "cancel", "cancel it", "no", "deny", "deny it",
"don't do it", "stop", "never mind", "nope", "skip", "abort",
"hold off".

Confidence: ≥0.9 for these short, unambiguous phrases. Lower (≤0.7) for
longer utterances that contain "yes" or "no" but mean something else
("yes I was thinking maybe…" → leave confirmation_response null).

Room actions:

When the user is asking the dashboard UI of a specific Room to do
something — switch tabs, open a dialog, fill a form, toggle a filter,
search inside the Room — return a "room_action" object instead of the
normal verb/object routing. Set verb="show", impact="read", confidence
on the room_action's clarity (>=0.85 to act). The dashboard's action bus
dispatches it to the matching Room. If no Room action matches, return
"room_action": null.

**Filter-while-naming-the-room rule:** When the user says something like
"show me the pending tasks", "show me my critical goals", "open the
overdue tasks", they are NOT asking to navigate to the room — they are
asking to filter inside it. Emit a "room_action" with the appropriate
filter; do NOT also set object.type to the room name (or you'll
double-fire navigation + filter and the qualifier gets dropped). The
daemon already knows which Room each action belongs to.

**Compound "go to X and Y" rule:** When the user says "go to settings
and disable TTS", "open the LLM tab and switch to anthropic", "go to
tasks and complete the OAuth one" — emit ONLY the "room_action" for the
follow-up verb (the disable / switch / complete). The daemon
auto-opens the target room before dispatching the action, so a separate
navigation intent would just race the action and add ack noise. Same
goes for "in the X room, do Y" phrasings. Always pick the most
specific room_action; the room is implied.

Examples of this rule:
  "show me the pending tasks"   → room_action: tasks/set_filter status=pending; object: null
  "show critical goals"          → room_action: goals/set_filter health=critical; object: null
  "show me the overdue tasks"    → room_action: tasks/search query="overdue"; object: null
                                   (or set_filter if a status maps better)
  "show me write tools"          → room_action: tools/set_filter filter=write; object: null

Plain navigation utterances WITHOUT qualifiers still use object:
  "open tasks"                   → object: { type: "task" }; no room_action
  "show me the calendar"         → object: { type: "calendar" }; no room_action

Available Room actions:

agents room ("room": "agents"):
- "switch_tab" — args: { "tab": "command" | "orbital" }
   matches "switch to orbital view", "show command center", "go to orbital"
- "open_spawn_dialog" — args: {}
   matches "open spawn dialog", "spawn an agent" (without specifics)
- "close_dialog" — args: {}
   matches "close the dialog", "cancel the spawn"
- "set_search" — args: { "query": string }
   matches "search for analyst", "filter agents by software"
- "spawn_agent" — args: { "specialist": string, "task"?: string, "context"?: string }
   matches "spawn a software engineer with task add OAuth", "spawn the research analyst"
   The "specialist" must match a known specialist id like
   "software-engineer", "research-analyst", "data-analyst",
   "content-writer", "system-administrator", "legal-advisor",
   "financial-analyst", "hr-specialist", "project-coordinator",
   "marketing-strategist", "customer-support".

tools room ("room": "tools"):
- "set_filter" — args: { "filter": "all" | "read" | "write" | "external" | "destructive" }
   matches "filter by destructive", "show all tools", "show read tools"
- "search" — args: { "query": string }
   matches "search for browser", "find git tools"
- "select" — args: { "name": string }
   matches "select web_search", "show the git_commit tool"

workflows room ("room": "workflows"):
- "switch_tab" — args: { "tab": "list" | "editor" | "builder" }
   matches "show the list", "open the editor", "switch to agent builder"
- "search" — args: { "query": string }
   matches "search for morning brief", "filter workflows by triage"
- "set_filter" — args: { "filter": "all" | "active" | "paused" }
   matches "show paused workflows", "show all workflows", "show only active"
- "select" — args: { "name": string }
   matches "open the morning brief workflow", "select daily-summary"
- "run" — args: { "name"?: string }
   matches "run morning brief", "run this workflow", "run the selected one"
- "pause" — args: { "name"?: string }
   matches "pause the daily-summary workflow", "pause this one"
- "enable" — args: { "name"?: string }
   matches "enable morning brief", "turn on this workflow"
- "create_from_nl" — args: { "prompt": string }
   matches "create a workflow that runs every morning at 8 and sends me my calendar",
   "make a new workflow that checks AI news every morning",
   "build a workflow to scrape hacker news daily at 9am",
   "just create a new empty workflow" (prompt: "" or omitted for blank)
   The "prompt" should be the imperative content of what the workflow
   should do, with leading "create / make / build / a / new / workflow /
   that / which / to" stripped. Keep the action + schedule + targets.
   Examples:
     "make a new workflow that checks AI news every morning"
       → prompt: "checks AI news every morning"
     "build a workflow to scrape hacker news daily at 9am"
       → prompt: "scrapes hacker news daily at 9am"

content room ("room": "content"):
- "switch_view" — args: { "view": "kanban" | "list" }
   matches "switch to list view", "show kanban"
- "search" — args: { "query": string }
   matches "search content for q3", "find launch posts"
- "set_filter" — args: { "field": "stage" | "type", "value": string }
   value (stage): "all" | "idea" | "research" | "outline" | "draft" | "assets" | "review" | "scheduled" | "published"
   value (type): "all" | "youtube" | "blog" | "twitter" | "instagram" | "tiktok" | "linkedin" | "podcast" | "newsletter" | "short_form" | "other"
   matches "show only drafts", "show scheduled posts", "filter to youtube"
- "select" — args: { "name": string }
   matches "open the q3 launch post", "select my morning newsletter"
- "create_content" — args: { "title": string, "type"?: ContentType }
   matches "create a blog post draft titled q3 launch",
   "new youtube video script about ai workflows",
   "draft a newsletter about agent tools"
   IMPORTANT — do NOT extract "create_content" for utterances that mention
   "site", "website", "landing page", "web app", "homepage", "page", "build
   a page", "site builder", "use the site builder", "edit the site". Those
   are SITE BUILDER requests (the user wants Jarvis to write code into a
   project), not content-pipeline drafts. Leave "room_action" null and let
   the chat agent handle them — its "site_*" tools will write the files.
- "advance" — args: { "name"?: string }
   matches "advance the q3 launch", "move this to the next stage"
- "regress" — args: { "name"?: string }
   matches "move the q3 launch back", "regress this one stage"
- "schedule" — args: { "name"?: string, "when": string }
   matches "schedule the launch post for next monday at 9am",
   "schedule this for tomorrow at noon"
   The "when" field uses the same parseRelativeDate format as Calendar.

settings room ("room": "settings"):
- "switch_tab" — args: { "tab": "general" | "profile" | "llm" | "channels" | "integrations" | "sidecar" }
   matches "open the LLM tab", "switch to channels", "go to general settings"
- "read_status" — args: {}
   matches "read the current status", "what's the LLM config", "what's connected"
- "set_primary_llm" — args: { "provider": "anthropic"|"openai"|"groq"|"gemini"|"ollama"|"openrouter"|"nvidia"|"litellm" }
   matches "set primary to anthropic", "make openai the default", "switch to ollama"
- "set_fallback_llm" — args: { "fallback": string[] | string }
   matches "set the fallback chain to openai and ollama", "use openai as fallback"
   The "fallback" can be an array of provider names or a comma-separated string.
- "set_model" — args: { "provider": LLMProvider, "model": string }
   matches "set the anthropic model to claude-opus-4-7",
   "use gpt-5.4 for openai", "switch ollama to llama3.1"
- "test_provider" — args: { "provider": LLMProvider }
   matches "test the anthropic connection", "test ollama"
- "enable_telegram" — args: {}    matches "enable telegram", "turn on the telegram bot"
- "disable_telegram" — args: {}   matches "disable telegram", "turn off telegram"
- "enable_discord" — args: {}     matches "enable discord", "turn on discord"
- "disable_discord" — args: {}    matches "disable discord", "turn off discord"
- "set_stt_provider" — args: { "provider": "openai"|"groq"|"sarvam"|"local" }
   matches "use groq for transcription", "set stt to local whisper"
- "enable_tts" — args: {}    matches "turn on TTS", "enable text to speech"
- "disable_tts" — args: {}   matches "turn off TTS", "disable text to speech"
- "set_tts_provider" — args: { "provider": "edge"|"elevenlabs"|"sarvam" }
   matches "use elevenlabs for tts", "switch tts to edge"
- "set_tts_voice" — args: { "voice": string }
   matches "change the voice to aria", "set the tts voice to Guy"
   The "voice" is the voice ID — for edge it looks like "en-US-AriaNeural";
   for elevenlabs it's the elevenlabs voice_id; for sarvam it's the speaker name.
- "set_heartbeat_interval" — args: { "minutes": number }
   matches "set heartbeat to 30 minutes", "check in every hour"
- "set_heartbeat_aggressiveness" — args: { "level": "passive"|"moderate"|"aggressive" }
   matches "make jarvis more aggressive", "set heartbeat to passive"
- "restart_daemon" — args: {}
   matches "restart jarvis", "restart the daemon", "apply the changes"
   Confirmation required — disconnects the WebSocket briefly. Voice should
   only fire this when the user is explicit; do NOT infer it from indirect
   utterances ("apply settings" is fine; "save settings" is not).
- "replay_onboarding" — args: { "scope"?: "all" | "setup" | "profile" | "tutorial" }
   matches "replay onboarding", "reset onboarding", "redo the onboarding",
   "show the onboarding again", "redo the tutorial" (scope=tutorial),
   "redo the profile interview" (scope=profile), "rerun setup" (scope=setup).
   When the user doesn't specify which part, default scope=all. Triggers a
   page reload after the reset fires — confirmation NOT required (it's
   non-destructive aside from clearing the user's saved profile when
   scope is "all" or "profile"; the user knows what they asked for).
- IMPORTANT: do NOT extract API key entry as a room_action — keys must be
   typed via keyboard for security (voice transcripts persist). If the user
   says "set my anthropic api key to ...", route through normal chat with a
   warning rather than emitting a room_action.

workspaces room ("room": "workspaces"):
- "switch_view" — args: { "view": "list" | "detail" }
   matches "back to the list", "show all projects", "show the detail view"
- "search" — args: { "query": string }
   matches "search projects for dashboard", "filter to react projects"
- "select_project" — args: { "name": string }
   matches "open the dashboard project", "select my-app", "open jarvis-ui"
- "back_to_list" — args: {}
   matches "go back", "back to projects", "close this project"
- "create_project" — args: { "name": string, "template"?: string }
   matches "create a new project called dashboard",
   "new vite-react project named landing",
   "make a project called blog with the next.js template"
   The "template" must be one of: "vite-react", "next-app", "vanilla-html",
   "react-vite-tailwind", "vue-vite". Defaults to "vite-react" when omitted.
- "start_server" — args: { "name"?: string }
   matches "start the dev server", "run the dashboard project",
   "start dashboard"
   When "name" is omitted, the currently-open project is targeted.
- "stop_server" — args: { "name"?: string }
   matches "stop the dev server", "kill the dashboard server",
   "stop dashboard"

tasks room ("room": "tasks"):
- "switch_view" — args: { "view": "kanban" | "list" }
   matches "switch to list view", "show kanban", "go to list"
- "search" — args: { "query": string }
   matches "search tasks for OAuth", "find email tasks"
- "set_filter" — args: { "field": "status" | "priority" | "assigned_to", "value": string }
   value (status): "all" | "pending" | "active" | "completed" | "failed" | "escalated"
   value (priority): "all" | "low" | "normal" | "high" | "critical"
   value (assigned_to): assignee name verbatim, or "all" or "unassigned"
   matches "show only active tasks", "filter by critical priority", "show jarvis's tasks"
- "select" — args: { "name": string }
   matches "find the OAuth task", "select the standup"
- "create_task" — args: { "title": string, "when"?: string, "priority"?: "low"|"normal"|"high"|"critical", "assigned_to"?: string }
   matches "create a task to ship OAuth tomorrow",
   "add a high priority task to email Alice by friday at 3pm",
   "remind me to review the PR"
   The "when" field is parsed by the daemon's parseRelativeDate
   (same format as Calendar's schedule_event: today/tomorrow/weekday
   names/in N units/HH:MM). Optional — undated tasks are valid.
- "complete_task" — args: { "name": string }
   matches "mark the OAuth task done", "complete the standup"
- "update_priority" — args: { "name": string, "level": "low"|"normal"|"high"|"critical" }
   matches "bump the OAuth task to high priority", "make this critical"
- "reassign" — args: { "name": string, "agent": string }
   matches "reassign the OAuth task to alice", "give this to jarvis"

goals room ("room": "goals"):
- "switch_tab" — args: { "tab": "constellation" | "timeline" | "metrics" }
   matches "show me the constellation", "switch to timeline", "open the metrics"
- "search" — args: { "query": string }
   matches "search goals for q3", "find the launch goal"
- "set_filter" — args: { "field": "status" | "health", "value": string }
   value (status): "all" | "draft" | "active" | "paused" | "completed" | "failed" | "killed"
   value (health): "all" | "on_track" | "at_risk" | "behind" | "critical"
   matches "show only active goals", "filter by health critical", "show all"
- "select" — args: { "name": string }
   matches "open the q3 launch goal", "select the marketing objective"
- "create_goal" — args: { "title": string, "level"?: "objective"|"key_result"|"milestone"|"task"|"daily_action" }
   matches "create a new goal to ship the OAuth feature",
   "add a key result for q3 — get to 100 active users"
   Defaults to level=task when not specified.

calendar room ("room": "calendar"):
- "switch_view" — args: { "view": "week" | "day" }
   matches "switch to day view", "show me the week", "go to week view"
- "search" — args: { "query": string }
   matches "search calendar for meeting", "find events about q3"
- "select_event" — args: { "title": string }
   matches "open the morning standup", "select the launch event"
- "schedule_event" — args: { "title": string, "when": string, "duration"?: string, "with"?: string, "priority"?: "low"|"normal"|"high"|"critical" }
   matches "schedule a meeting Tuesday at 3 with Alice for an hour",
   "block off tomorrow morning to write the spec",
   "add a task to email the team next monday at 9am",
   "remind me to call mom Thursday at 2pm"
   Extract:
     "title" — the imperative content ("call mom", "email the team", "meeting with Alice")
     "when" — the natural-language time spec verbatim ("Tuesday at 3", "tomorrow morning", "next monday at 9am"). The daemon parses this with parseRelativeDate; supported formats include "today / tomorrow / yesterday + at HH(am|pm)?", weekday names ("monday / tuesday / next friday"), "in N days/hours/minutes", absolute "YYYY-MM-DD HH:MM".
     "duration" — only if the user said one ("for an hour", "30 minutes")
     "with" — only if the user named a person
     "priority" — only if the user said "urgent"/"high priority" etc.

authority room ("room": "authority"):
- "switch_tab" — args: { "tab": "approvals" | "audit" | "grants" | "learning" }
   matches "show approvals", "open the audit", "switch to grants", "go to learning"
- "set_filter" — args: { "decision": "all" | "allowed" | "denied" | "approval_required" }
   matches "show only denied", "filter audit by approval required", "show all decisions"
- "grant_access" — args: { "action": ActionCategory }
   matches "grant Jarvis email access", "allow send_email globally",
   "grant access to send messages", "let agents access the browser"
   The "action" must be one of: read_data, write_data, delete_data,
   send_message, send_email, execute_command, install_software,
   make_payment, modify_settings, spawn_agent, terminate_agent,
   access_browser, control_app.
- "revoke_access" — args: { "action": ActionCategory }
   matches "revoke email access", "remove send_email permission",
   "deny browser access for everyone"
- IMPORTANT: do NOT extract emergency commands (pause, kill, resume,
   reset) as room_actions — they are deliberately UI-button-only for
   safety. If the user says "pause everything" or "kill all agents",
   route through normal chat; never emit a room_action for them.

memory room ("room": "memory"):
- "switch_tab" — args: { "tab": "constellation" | "explorer" | "browser" }
   matches "show the constellation", "switch to explorer", "open the browser"
- "search" — args: { "query": string }
   matches "search memory for alice", "find facts about q3"
- "set_filter" — args: { "type": "all" | "person" | "project" | "tool" | "place" | "concept" | "event" }
   matches "show only people", "filter to projects", "show all entities"
- "select" — args: { "name": string }
   matches "select alice", "open the q3 launch entity"
- "remember_that" — args: { "subject": string, "predicate": string, "object": string }
   matches "remember that alice's birthday is march 15",
   "remember that the bone paper project ships in june",
   "remember that q3 launch happens on may 5"
   Extract: subject is the entity name (will be created if missing as a
   "concept"); predicate is the relation in lowercase ("birthday is" →
   "birthday", "ships in" → "ships", "happens on" → "happens"); object
   is the value verbatim. Verb=create, impact=write, confidence ≥0.85
   when the utterance is unambiguous.

logs room ("room": "logs"):
- "toggle_source" — args: { "source": "awareness" | "authority" | "agents" | "tasks" | "sidecar" }
   matches "toggle awareness", "hide tasks", "show only authority logs"
- "set_time_window" — args: { "window": "1h" | "24h" | "7d" | "all" }
   matches "show last hour", "show all time", "filter to last day"
- "toggle_live_tail" — args: {}
   matches "turn on live tail", "stop live updates", "live mode"
- "refresh" — args: {}
   matches "refresh logs", "reload"

Examples:

Transcript: "what did i miss this morning?"
{"verb":"ask","object":{"type":"log","query":"this morning"},"args":{},"impact":"read","confidence":0.97}

Transcript: "open workflows"
{"verb":"show","object":{"type":"workflow"},"args":{},"impact":"read","confidence":0.98}

Transcript: "open goals"
{"verb":"show","object":{"type":"goal"},"args":{},"impact":"read","confidence":0.98}

Transcript: "show me my calendar"
{"verb":"show","object":{"type":"calendar"},"args":{},"impact":"read","confidence":0.97}

Transcript: "open settings"
{"verb":"show","object":{"type":"settings"},"args":{},"impact":"read","confidence":0.98}

Transcript: "open content"
{"verb":"show","object":{"type":"content"},"args":{},"impact":"read","confidence":0.97}

Transcript: "show me my drafts"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.95,"room_action":{"room":"content","action":"set_filter","args":{"field":"stage","value":"draft"}}}

Transcript: "open workspaces"
{"verb":"show","object":{"type":"workspace"},"args":{},"impact":"read","confidence":0.97}

Transcript: "open the dashboard project"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.94,"room_action":{"room":"workspaces","action":"select_project","args":{"name":"dashboard"}}}

Transcript: "create a new project called landing-page with vite-react"
{"verb":"create","object":null,"args":{},"impact":"write","confidence":0.92,"room_action":{"room":"workspaces","action":"create_project","args":{"name":"landing-page","template":"vite-react"}}}

Transcript: "start the dev server"
{"verb":"run","object":null,"args":{},"impact":"write","confidence":0.93,"room_action":{"room":"workspaces","action":"start_server","args":{}}}

Transcript: "stop the dashboard dev server"
{"verb":"run","object":null,"args":{},"impact":"write","confidence":0.93,"room_action":{"room":"workspaces","action":"stop_server","args":{"name":"dashboard"}}}

Transcript: "back to projects"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.94,"room_action":{"room":"workspaces","action":"back_to_list","args":{}}}

Transcript: "open the LLM tab"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.96,"room_action":{"room":"settings","action":"switch_tab","args":{"tab":"llm"}}}

Transcript: "set the primary LLM to anthropic"
{"verb":"update","object":null,"args":{},"impact":"write","confidence":0.94,"room_action":{"room":"settings","action":"set_primary_llm","args":{"provider":"anthropic"}}}

Transcript: "use gpt-5.4 for openai"
{"verb":"update","object":null,"args":{},"impact":"write","confidence":0.93,"room_action":{"room":"settings","action":"set_model","args":{"provider":"openai","model":"gpt-5.4"}}}

Transcript: "enable telegram"
{"verb":"update","object":null,"args":{},"impact":"write","confidence":0.95,"room_action":{"room":"settings","action":"enable_telegram","args":{}}}

Transcript: "turn off TTS"
{"verb":"update","object":null,"args":{},"impact":"write","confidence":0.95,"room_action":{"room":"settings","action":"disable_tts","args":{}}}

Transcript: "use elevenlabs for tts"
{"verb":"update","object":null,"args":{},"impact":"write","confidence":0.94,"room_action":{"room":"settings","action":"set_tts_provider","args":{"provider":"elevenlabs"}}}

Transcript: "restart jarvis"
{"verb":"run","object":null,"args":{},"impact":"write","confidence":0.93,"room_action":{"room":"settings","action":"restart_daemon","args":{}}}

Transcript: "replay onboarding"
{"verb":"run","object":null,"args":{},"impact":"write","confidence":0.95,"room_action":{"room":"settings","action":"replay_onboarding","args":{"scope":"all"}}}

Transcript: "redo the tutorial"
{"verb":"run","object":null,"args":{},"impact":"write","confidence":0.93,"room_action":{"room":"settings","action":"replay_onboarding","args":{"scope":"tutorial"}}}

Transcript: "go to settings and disable TTS"
{"verb":"update","object":null,"args":{},"impact":"write","confidence":0.95,"room_action":{"room":"settings","action":"disable_tts","args":{}}}

Transcript: "open the LLM tab and switch to anthropic"
{"verb":"update","object":null,"args":{},"impact":"write","confidence":0.94,"room_action":{"room":"settings","action":"set_primary_llm","args":{"provider":"anthropic"}}}

Transcript: "in the tasks room, complete the oauth task"
{"verb":"update","object":null,"args":{},"impact":"write","confidence":0.93,"room_action":{"room":"tasks","action":"complete_task","args":{"name":"oauth"}}}

Transcript: "go to workspaces and open the dashboard project"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.94,"room_action":{"room":"workspaces","action":"select_project","args":{"name":"dashboard"}}}

Transcript: "create a blog post draft about q3 launch"
{"verb":"create","object":null,"args":{},"impact":"write","confidence":0.93,"room_action":{"room":"content","action":"create_content","args":{"title":"q3 launch","type":"blog"}}}

Transcript: "advance the q3 launch to the next stage"
{"verb":"update","object":null,"args":{},"impact":"write","confidence":0.92,"room_action":{"room":"content","action":"advance","args":{"name":"q3 launch"}}}

Transcript: "schedule the launch post for next monday at 9am"
{"verb":"update","object":null,"args":{},"impact":"write","confidence":0.92,"room_action":{"room":"content","action":"schedule","args":{"name":"launch post","when":"next monday at 9am"}}}

Transcript: "open tasks"
{"verb":"show","object":{"type":"task"},"args":{},"impact":"read","confidence":0.98}

Transcript: "show me my to-do list"
{"verb":"show","object":{"type":"task"},"args":{},"impact":"read","confidence":0.95}

Transcript: "create a task to ship oauth tomorrow"
{"verb":"create","object":{"type":"task"},"args":{},"impact":"write","confidence":0.93,"room_action":{"room":"tasks","action":"create_task","args":{"title":"ship oauth","when":"tomorrow"}}}

Transcript: "mark the standup task done"
{"verb":"update","object":null,"args":{},"impact":"write","confidence":0.92,"room_action":{"room":"tasks","action":"complete_task","args":{"name":"standup"}}}

Transcript: "bump the oauth task to high priority"
{"verb":"update","object":null,"args":{},"impact":"write","confidence":0.93,"room_action":{"room":"tasks","action":"update_priority","args":{"name":"oauth","level":"high"}}}

Transcript: "show only critical tasks"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.94,"room_action":{"room":"tasks","action":"set_filter","args":{"field":"priority","value":"critical"}}}

Transcript: "show me the pending tasks"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.95,"room_action":{"room":"tasks","action":"set_filter","args":{"field":"status","value":"pending"}}}

Transcript: "show me my active tasks"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.94,"room_action":{"room":"tasks","action":"set_filter","args":{"field":"status","value":"active"}}}

Transcript: "go back to the thread"
{"verb":"show","object":{"type":"thread"},"args":{},"impact":"read","confidence":0.98}

Transcript: "close the room"
{"verb":"show","object":{"type":"thread"},"args":{},"impact":"read","confidence":0.95}

Transcript: "back"
{"verb":"show","object":{"type":"thread"},"args":{},"impact":"read","confidence":0.85}

Transcript: "return to the home view"
{"verb":"show","object":{"type":"thread"},"args":{},"impact":"read","confidence":0.95}

Transcript: "send an email to alice about the meeting"
{"verb":"create","object":{"type":"url","query":"email to alice"},"args":{"to":"alice","topic":"meeting"},"impact":"external","confidence":0.78,"alternatives":[{"label":"Send the email now","verb":"run","object":null,"args":{"to":"alice"},"impact":"external"},{"label":"Just draft it for review","verb":"create","object":null,"args":{"to":"alice"},"impact":"write"}]}

Transcript: "delete everything in downloads"
{"verb":"delete","object":{"type":"file","query":"~/Downloads/*"},"args":{},"impact":"destructive","confidence":0.72,"alternatives":[{"label":"Move to trash","verb":"update","object":{"type":"file","query":"~/Downloads"},"args":{"action":"trash"},"impact":"write"}]}

Transcript: "uhh hey um"
{"verb":"unknown","object":null,"args":{},"impact":"read","confidence":0.15}

Transcript: "I'm back at the PC after lunch how are you"
{"verb":"ask","object":null,"args":{},"impact":"read","confidence":0.92}

Transcript: "I'm ready to go back to work how are you"
{"verb":"ask","object":null,"args":{},"impact":"read","confidence":0.92}

Transcript: "good morning jarvis"
{"verb":"ask","object":null,"args":{},"impact":"read","confidence":0.95}

Transcript: "thanks that's all I needed"
{"verb":"ask","object":null,"args":{},"impact":"read","confidence":0.93}

Transcript: "what do you think about the design we landed yesterday"
{"verb":"ask","object":null,"args":{},"impact":"read","confidence":0.95}

Transcript: "headed to a meeting in five"
{"verb":"ask","object":null,"args":{},"impact":"read","confidence":0.9}

Transcript: "switch to orbital view"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.96,"room_action":{"room":"agents","action":"switch_tab","args":{"tab":"orbital"}}}

Transcript: "open the spawn dialog"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.95,"room_action":{"room":"agents","action":"open_spawn_dialog","args":{}}}

Transcript: "spawn a software engineer with task add OAuth"
{"verb":"create","object":{"type":"agent","query":"software-engineer"},"args":{},"impact":"write","confidence":0.92,"room_action":{"room":"agents","action":"spawn_agent","args":{"specialist":"software-engineer","task":"add OAuth"}}}

Transcript: "filter by destructive"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.94,"room_action":{"room":"tools","action":"set_filter","args":{"filter":"destructive"}}}

Transcript: "show last hour"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.92,"room_action":{"room":"logs","action":"set_time_window","args":{"window":"1h"}}}

Transcript: "turn on live tail"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.95,"room_action":{"room":"logs","action":"toggle_live_tail","args":{}}}

Transcript: "run morning brief"
{"verb":"run","object":{"type":"workflow","query":"morning brief"},"args":{},"impact":"write","confidence":0.92,"room_action":{"room":"workflows","action":"run","args":{"name":"morning brief"}}}

Transcript: "show paused workflows"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.94,"room_action":{"room":"workflows","action":"set_filter","args":{"filter":"paused"}}}

Transcript: "make a new workflow that checks AI news every morning"
{"verb":"create","object":{"type":"workflow"},"args":{},"impact":"write","confidence":0.92,"room_action":{"room":"workflows","action":"create_from_nl","args":{"prompt":"checks AI news every morning"}}}

Transcript: "just create a new empty workflow"
{"verb":"create","object":{"type":"workflow"},"args":{},"impact":"write","confidence":0.94,"room_action":{"room":"workflows","action":"create_from_nl","args":{"prompt":""}}}

Transcript: "approve"
{"verb":"unknown","object":null,"args":{},"impact":"read","confidence":0.96,"confirmation_response":"approve"}

Transcript: "yes do it"
{"verb":"unknown","object":null,"args":{},"impact":"read","confidence":0.95,"confirmation_response":"approve"}

Transcript: "cancel"
{"verb":"unknown","object":null,"args":{},"impact":"read","confidence":0.96,"confirmation_response":"cancel"}

Transcript: "never mind"
{"verb":"unknown","object":null,"args":{},"impact":"read","confidence":0.92,"confirmation_response":"cancel"}

Transcript: "remember that alice's birthday is march 15"
{"verb":"create","object":{"type":"memory","query":"alice"},"args":{},"impact":"write","confidence":0.92,"room_action":{"room":"memory","action":"remember_that","args":{"subject":"alice","predicate":"birthday","object":"march 15"}}}

Transcript: "show only people"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.94,"room_action":{"room":"memory","action":"set_filter","args":{"type":"person"}}}

Transcript: "switch to constellation"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.96,"room_action":{"room":"memory","action":"switch_tab","args":{"tab":"constellation"}}}

Transcript: "grant Jarvis email access"
{"verb":"grant","object":{"type":"authority","query":"send_email"},"args":{},"impact":"write","confidence":0.92,"room_action":{"room":"authority","action":"grant_access","args":{"action":"send_email"}}}

Transcript: "show only denied audit entries"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.94,"room_action":{"room":"authority","action":"set_filter","args":{"decision":"denied"}}}

Transcript: "revoke browser access"
{"verb":"revoke","object":{"type":"authority","query":"access_browser"},"args":{},"impact":"write","confidence":0.9,"room_action":{"room":"authority","action":"revoke_access","args":{"action":"access_browser"}}}

Transcript: "schedule a meeting tuesday at 3 with alice for an hour"
{"verb":"create","object":null,"args":{},"impact":"write","confidence":0.92,"room_action":{"room":"calendar","action":"schedule_event","args":{"title":"meeting with alice","when":"tuesday at 3pm","duration":"1 hour","with":"alice"}}}

Transcript: "remind me to call mom tomorrow at 2"
{"verb":"create","object":null,"args":{},"impact":"write","confidence":0.93,"room_action":{"room":"calendar","action":"schedule_event","args":{"title":"call mom","when":"tomorrow at 2pm"}}}

Transcript: "switch to day view"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.96,"room_action":{"room":"calendar","action":"switch_view","args":{"view":"day"}}}

Transcript: "create a new goal to ship oauth"
{"verb":"create","object":{"type":"goals","query":"ship oauth"},"args":{},"impact":"write","confidence":0.93,"room_action":{"room":"goals","action":"create_goal","args":{"title":"ship oauth","level":"task"}}}

Transcript: "show only critical goals"
{"verb":"show","object":null,"args":{},"impact":"read","confidence":0.94,"room_action":{"room":"goals","action":"set_filter","args":{"field":"health","value":"critical"}}}`;

/**
 * Permissive default — used when the LLM is unavailable or returns garbage.
 * Confidence:0.85 ensures the daemon proceeds with the existing chat flow
 * and never strands a user mid-utterance just because the classifier failed.
 */
export function permissiveIntent(transcript: string): Intent {
  return {
    id: generateId(),
    utterance: transcript,
    verb: 'ask',
    object: null,
    args: {},
    impact: 'read',
    confidence: 0.85,
  };
}

function isVerb(v: unknown): v is Verb {
  return typeof v === 'string' && VALID_VERBS.has(v as Verb);
}

function isImpact(v: unknown): v is Impact {
  return typeof v === 'string' && VALID_IMPACTS.has(v as Impact);
}

function parseObject(raw: unknown): ObjectRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { type?: unknown; id?: unknown; query?: unknown };
  if (typeof obj.type !== 'string' || !VALID_OBJECT_TYPES.has(obj.type as ObjectRefType)) {
    return null;
  }
  return {
    type: obj.type as ObjectRefType,
    id: typeof obj.id === 'string' ? obj.id : undefined,
    query: typeof obj.query === 'string' ? obj.query : undefined,
  };
}

function parseRoomAction(raw: unknown): RoomAction | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as { room?: unknown; action?: unknown; args?: unknown };
  if (typeof obj.room !== 'string' || !VALID_ROOMS.has(obj.room as RoomKey)) return undefined;
  if (typeof obj.action !== 'string' || obj.action.trim().length === 0) return undefined;
  return {
    room: obj.room as RoomKey,
    action: obj.action,
    args:
      obj.args && typeof obj.args === 'object'
        ? (obj.args as Record<string, unknown>)
        : undefined,
  };
}

function parseAlternatives(raw: unknown): Intent['alternatives'] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: NonNullable<Intent['alternatives']> = [];
  for (const item of raw.slice(0, 3)) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (!isVerb(a.verb) || !isImpact(a.impact)) continue;
    out.push({
      label: typeof a.label === 'string' ? a.label : `${a.verb}`,
      verb: a.verb,
      object: parseObject(a.object),
      args: typeof a.args === 'object' && a.args !== null ? (a.args as Record<string, unknown>) : {},
      impact: a.impact,
    });
  }
  return out.length > 0 ? out : undefined;
}

export function parseIntent(raw: string, transcript: string): Intent {
  // Strip code fences if the LLM ignored instructions
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract the first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return permissiveIntent(transcript);
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return permissiveIntent(transcript);
    }
  }

  if (!parsed || typeof parsed !== 'object') return permissiveIntent(transcript);
  const p = parsed as Record<string, unknown>;

  const verb = isVerb(p.verb) ? p.verb : 'unknown';
  const impact = isImpact(p.impact) ? p.impact : 'read';
  const confidenceRaw = typeof p.confidence === 'number' ? p.confidence : 0.5;
  const confidence = Math.max(0, Math.min(1, confidenceRaw));

  const confirmation =
    p.confirmation_response === 'approve' || p.confirmation_response === 'cancel'
      ? p.confirmation_response
      : undefined;

  return {
    id: generateId(),
    utterance: transcript,
    verb,
    object: parseObject(p.object),
    args: typeof p.args === 'object' && p.args !== null ? (p.args as Record<string, unknown>) : {},
    impact,
    confidence,
    alternatives: parseAlternatives(p.alternatives),
    room_action: parseRoomAction(p.room_action),
    confirmation_response: confirmation,
  };
}

export type RecentTurn = { role: 'user' | 'assistant'; text: string };

/**
 * Classify a voice transcript into an Intent. Never throws — returns a
 * permissive default on any error so the voice flow stays unblocked.
 *
 * `userProfilePrompt` (Phase B): rendered "About the user" markdown
 * block from `formatUserProfileForPrompt(getUserProfile())`. When
 * present, prepended to the system prompt so the classifier resolves
 * deictic phrases ("open my project", "remind me of my standup")
 * against the user's actual context. Daemon callers pass it through;
 * undefined is fine.
 */
export async function classifyVoiceIntent(
  transcript: string,
  recentTurns: RecentTurn[],
  llm: LLMManager,
  currentRoom?: string,
  userProfilePrompt?: string,
): Promise<Intent> {
  const text = transcript.trim();
  if (!text) {
    return { ...permissiveIntent(text), verb: 'unknown', confidence: 0 };
  }

  const contextLines = recentTurns
    .slice(-3)
    .map((t) => `${t.role === 'user' ? 'USER' : 'JARVIS'}: ${t.text.replace(/\s+/g, ' ').slice(0, 240)}`)
    .join('\n');

  // Phase 6.7.C — surface where the user is right now so the classifier
  // can disambiguate utterances that read both as chat questions and as
  // room actions ("show me active tasks" — when in tasks room, that's a
  // filter; on the home thread, it's a chat answer).
  const roomContext =
    currentRoom && currentRoom !== 'home'
      ? `User is currently inside the "${currentRoom}" room. STRONGLY PREFER room_action over a chat answer for utterances that map to a known action of this room. Only fall back to a chat answer if no action of this room could plausibly satisfy the request.`
      : `User is on the home thread (no Room open). Navigation utterances ("open tasks", "show me my goals") should set object.type. Filter-style utterances ("show me active tasks") still emit a room_action so the room opens already filtered.`;

  const userPrompt = contextLines
    ? `${roomContext}\n\nRecent conversation (oldest first):\n${contextLines}\n\nNew user transcript: "${text}"\n\nReturn the JSON intent.`
    : `${roomContext}\n\nNew user transcript: "${text}"\n\nReturn the JSON intent.`;

  // Phase B — prepend the user-profile block to the system prompt
  // when available so the classifier knows who it's serving.
  const systemContent = userProfilePrompt
    ? `# About the user\n${userProfilePrompt}\n\n---\n\n${SYSTEM_PROMPT}`
    : SYSTEM_PROMPT;

  const messages: LLMMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userPrompt },
  ];

  try {
    const response = await llm.chatTier('low', 'voice_intent', messages, { temperature: 0, max_tokens: 400 });
    return parseIntent(response.content ?? '', text);
  } catch (err) {
    console.warn('[VoiceIntent] Classifier failed, falling back to permissive:', err);
    return permissiveIntent(text);
  }
}
