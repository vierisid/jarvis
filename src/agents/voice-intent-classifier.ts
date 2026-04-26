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
  'sites',
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
  'file',
  'url',
  'thread',
]);

const SYSTEM_PROMPT = `You are a voice intent classifier for an agentic AI assistant.

Given a user's voice transcript and the recent conversation context, return a single JSON object describing what the user intends. Output JSON only — no prose, no code fences.

Schema:
{
  "verb": "ask" | "show" | "run" | "create" | "update" | "delete" | "grant" | "revoke" | "pause" | "resume" | "unknown",
  "object": { "type": "workflow"|"memory"|"tool"|"agent"|"authority"|"log"|"file"|"url"|"thread", "query": string } | null,
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
- ask: read-only Q&A ("what's on my calendar?")
- show: navigate / open ("open workflows")
- run: execute a workflow or tool ("run morning triage")
- create: new object ("draft a reply")
- update: edit existing
- delete: destructive remove
- grant / revoke: authority changes
- pause / resume: daemon control
- unknown: cannot tell

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
{"verb":"unknown","object":null,"args":{},"impact":"read","confidence":0.92,"confirmation_response":"cancel"}`;

/**
 * Permissive default — used when the LLM is unavailable or returns garbage.
 * Confidence:0.85 ensures the daemon proceeds with the existing chat flow
 * and never strands a user mid-utterance just because the classifier failed.
 */
function permissiveIntent(transcript: string): Intent {
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

function parseIntent(raw: string, transcript: string): Intent {
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
 */
export async function classifyVoiceIntent(
  transcript: string,
  recentTurns: RecentTurn[],
  llm: LLMManager,
): Promise<Intent> {
  const text = transcript.trim();
  if (!text) {
    return { ...permissiveIntent(text), verb: 'unknown', confidence: 0 };
  }

  const contextLines = recentTurns
    .slice(-3)
    .map((t) => `${t.role === 'user' ? 'USER' : 'JARVIS'}: ${t.text.replace(/\s+/g, ' ').slice(0, 240)}`)
    .join('\n');

  const userPrompt = contextLines
    ? `Recent conversation (oldest first):\n${contextLines}\n\nNew user transcript: "${text}"\n\nReturn the JSON intent.`
    : `New user transcript: "${text}"\n\nReturn the JSON intent.`;

  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  try {
    const response = await llm.chat(messages, { temperature: 0, max_tokens: 400 });
    return parseIntent(response.content ?? '', text);
  } catch (err) {
    console.warn('[VoiceIntent] Classifier failed, falling back to permissive:', err);
    return permissiveIntent(text);
  }
}
