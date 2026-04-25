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
  type Verb,
} from '../voice/intent.ts';

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
  "alternatives": [ { "label": string, "verb": ..., "object": ..., "args": ..., "impact": ... } ]  (0-2 items, only when ambiguous)
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
{"verb":"unknown","object":null,"args":{},"impact":"read","confidence":0.15}`;

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

  return {
    id: generateId(),
    utterance: transcript,
    verb,
    object: parseObject(p.object),
    args: typeof p.args === 'object' && p.args !== null ? (p.args as Record<string, unknown>) : {},
    impact,
    confidence,
    alternatives: parseAlternatives(p.alternatives),
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
