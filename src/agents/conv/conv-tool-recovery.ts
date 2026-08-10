import type { LLMToolCall } from '../../llm/provider.ts';
import { CONV_TOOL_NAMES } from './conv-tools.ts';

const SERIALIZED_TOOL_NAMES = new Set<string>(Object.values(CONV_TOOL_NAMES));
/** Both syntaxes we've seen models print: `/delegate{...}` and `(delegate {...})`. */
const CALL_OPENERS = ['/', '('] as const;
const CALL_PREFIXES = CALL_OPENERS.flatMap(
  (opener) => [...SERIALIZED_TOOL_NAMES].map((name) => `${opener}${name}`),
);
const FALLBACK_MARKER = 'FALLBACK_OK';
/** Longest ambiguous tail we ever need to hold back. */
const MAX_PREFIX_LEN = Math.max(FALLBACK_MARKER.length, ...CALL_PREFIXES.map((p) => p.length));

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Derived from CONV_TOOL_NAMES rather than hardcoded, so adding a conv tool
// can't leave the recovery scanner silently blind to it (which would leak the
// serialized call to the chat UI and TTS instead of executing it).
const TOOL_NAME_ALTERNATION = [...SERIALIZED_TOOL_NAMES].map(escapeForRegex).join('|');
const CALL_PATTERN = new RegExp(`([/(])(${TOOL_NAME_ALTERNATION})\\s*(?=\\{)`, 'gi');
/** Same as CALL_PATTERN but without the `{` lookahead — used while streaming,
 *  where the JSON may not have arrived yet. */
const PARTIAL_CALL_PATTERN = new RegExp(`([/(])(${TOOL_NAME_ALTERNATION})`, 'gi');
const FALLBACK_PATTERN = new RegExp(`\\b${escapeForRegex(FALLBACK_MARKER)}\\b\\s*`, 'gi');

function jsonObjectEnd(text: string, start: number): number | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return index + 1;
  }
  return null;
}

/**
 * True when `tail` could still grow into an internal marker, so it is not yet
 * safe to show or speak. Covers complete markers too: `FALLBACK_OK` may still
 * become `FALLBACK_OKAY` (which the word-boundary strip would leave alone).
 */
function isMarkerPrefix(tail: string): boolean {
  if (FALLBACK_MARKER.startsWith(tail.toUpperCase())) return true;
  const lower = tail.toLowerCase();
  return CALL_PREFIXES.some((prefix) => prefix.startsWith(lower));
}

/**
 * True when `rest` (everything after a complete `/name` or `(name`) has not yet
 * settled into either a parseable call or ordinary prose.
 */
function isUnresolvedCallTail(opener: string, rest: string): boolean {
  const jsonStart = rest.length - rest.trimStart().length;
  // Nothing but whitespace so far — the `{` may still be coming.
  if (jsonStart === rest.length) return true;
  // Anything other than `{` means this was prose all along (e.g. "/delegated").
  if (rest[jsonStart] !== '{') return false;
  const end = jsonObjectEnd(rest, jsonStart);
  if (end === null) return true; // JSON arguments still streaming
  if (opener !== '(') return false;
  // Paren syntax: the closing `)` is part of the call and may still arrive.
  return rest.slice(end).trim().length === 0;
}

/**
 * Number of trailing characters of `text` that must be withheld from the chat
 * UI and TTS because they may still turn out to be part of a serialized tool
 * call. Returns 0 when all of `text` is safe to emit.
 *
 * Callers stream `text.slice(0, text.length - pending)` through
 * `stripSerializedConvTools` and emit only the delta they haven't shown yet.
 * Checking every position (rather than only the start of the response) is what
 * keeps a call the model prints *after* its acknowledgment from leaking.
 */
export function pendingSerializedToolSuffix(text: string): number {
  let pending = 0;

  // A complete `/name` / `(name` whose call hasn't finished arriving. Scan all
  // occurrences: an unresolved marker can sit before a resolved one that the
  // pattern also matched inside the unfinished JSON.
  for (const match of text.matchAll(PARTIAL_CALL_PATTERN)) {
    const rest = text.slice(match.index + match[0].length);
    if (isUnresolvedCallTail(match[1]!, rest)) {
      pending = Math.max(pending, text.length - match.index);
    }
  }
  if (pending > 0) return pending;

  // A partial marker at the very end, e.g. "…now. /deleg" or "FALLB".
  const windowStart = Math.max(0, text.length - MAX_PREFIX_LEN);
  for (let index = windowStart; index < text.length; index++) {
    if (isMarkerPrefix(text.slice(index))) return text.length - index;
  }
  return 0;
}

/**
 * The visible text a streaming caller may show or speak given everything
 * received so far. Withholds any tail that could still become a serialized tool
 * call and removes the ones that already resolved.
 *
 * The result only ever extends as `text` grows, so callers keep what they last
 * emitted and yield the delta.
 */
export function visibleStreamText(text: string): string {
  const safe = text.slice(0, text.length - pendingSerializedToolSuffix(text));
  // trimStart is monotone once any non-whitespace has arrived, so applying it on
  // every pass never shifts a delta the caller already emitted.
  return stripSerializedConvTools(safe, [], 'stream').text.trimStart();
}

function callSignature(call: Pick<LLMToolCall, 'name' | 'arguments'>): string {
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

/**
 * Core of the recovery: turn valid text-serialized conversation tools into the
 * same structured calls the orchestrator already validates and dispatches, and
 * remove the internal protocol markers and JSON from the user-facing text.
 * Whitespace is not trimmed, so callers can diff successive results while
 * streaming.
 */
export function stripSerializedConvTools(
  text: string,
  existingCalls: LLMToolCall[],
  idPrefix: string,
): { text: string; toolCalls: LLMToolCall[] } {
  const withoutMarker = text.replace(FALLBACK_PATTERN, '');
  const recovered: LLMToolCall[] = [];
  const existingSignatures = new Set(existingCalls.map(callSignature));
  let visible = '';
  let cursor = 0;

  for (const match of withoutMarker.matchAll(CALL_PATTERN)) {
    const matchIndex = match.index;
    if (matchIndex < cursor) continue; // inside a call we already consumed
    const jsonStart = matchIndex + match[0].length;
    const jsonEnd = jsonObjectEnd(withoutMarker, jsonStart);
    if (jsonEnd === null) continue;

    let args: unknown;
    try {
      args = JSON.parse(withoutMarker.slice(jsonStart, jsonEnd));
    } catch {
      continue;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;

    const name = match[2]!.toLowerCase();
    if (!SERIALIZED_TOOL_NAMES.has(name)) continue;
    visible += withoutMarker.slice(cursor, matchIndex);
    cursor = jsonEnd;
    // Groq may print `(delegate {...})` rather than `/delegate{...}`.
    // Consume the protocol's closing parenthesis along with the call.
    if (match[1] === '(') {
      while (/\s/.test(withoutMarker[cursor] ?? '')) cursor++;
      if (withoutMarker[cursor] === ')') cursor++;
    }
    // Close the seam the removal left behind so surrounding prose doesn't gain
    // a leading or doubled space (which would also shift streaming deltas).
    if (!visible || /\s$/.test(visible)) {
      while (/\s/.test(withoutMarker[cursor] ?? '')) cursor++;
    }

    const call: LLMToolCall = {
      id: `${idPrefix}_${recovered.length}`,
      name,
      arguments: args as Record<string, unknown>,
    };
    const signature = callSignature(call);
    if (!existingSignatures.has(signature)) {
      recovered.push(call);
      existingSignatures.add(signature);
    }
  }

  visible += withoutMarker.slice(cursor);
  return { text: visible, toolCalls: [...existingCalls, ...recovered] };
}

/**
 * `stripSerializedConvTools` with the user-facing text trimmed — use this for
 * the finished response content.
 */
export function recoverSerializedConvTools(
  text: string,
  existingCalls: LLMToolCall[],
  idPrefix: string,
): { text: string; toolCalls: LLMToolCall[] } {
  const stripped = stripSerializedConvTools(text, existingCalls, idPrefix);
  return { ...stripped, text: stripped.text.trim() };
}
