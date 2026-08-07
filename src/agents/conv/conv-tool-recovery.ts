import type { LLMToolCall } from '../../llm/provider.ts';
import { CONV_TOOL_NAMES } from './conv-tools.ts';

const SERIALIZED_TOOL_NAMES = new Set<string>(Object.values(CONV_TOOL_NAMES));
const SERIALIZED_TOOL_PREFIXES = [...SERIALIZED_TOOL_NAMES].map((name) => `/${name}`);
const FALLBACK_MARKER = 'FALLBACK_OK';

/**
 * Some OpenAI-compatible models occasionally print a tool call as ordinary
 * text instead of returning it in the structured tool_calls field. Hold that
 * response back from the UI/TTS while its prefix is still ambiguous.
 */
export function couldStartWithSerializedConvTool(text: string): boolean {
  const candidate = text.trimStart();
  if (!candidate) return true;

  const upper = candidate.toUpperCase();
  if (FALLBACK_MARKER.startsWith(upper) || upper.startsWith(FALLBACK_MARKER)) {
    return true;
  }

  if (!candidate.startsWith('/')) return false;
  const lower = candidate.toLowerCase();
  return SERIALIZED_TOOL_PREFIXES.some((prefix) => (
    prefix.startsWith(lower) || lower.startsWith(prefix)
  ));
}

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

function callSignature(call: Pick<LLMToolCall, 'name' | 'arguments'>): string {
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

/**
 * Convert valid text-serialized conversation tools into the same structured
 * calls the orchestrator already validates and dispatches. Internal protocol
 * markers and JSON are removed from the user-facing text before it can be
 * rendered or spoken.
 */
export function recoverSerializedConvTools(
  text: string,
  existingCalls: LLMToolCall[],
  idPrefix: string,
): { text: string; toolCalls: LLMToolCall[] } {
  const withoutMarker = text.replace(/\bFALLBACK_OK\b\s*/gi, '');
  const recovered: LLMToolCall[] = [];
  const existingSignatures = new Set(existingCalls.map(callSignature));
  const pattern = /\/(delegate|check_task|cancel_task|resume_task)\s*(?=\{)/gi;
  let visible = '';
  let cursor = 0;

  for (const match of withoutMarker.matchAll(pattern)) {
    const matchIndex = match.index;
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

    const name = match[1]!.toLowerCase();
    if (!SERIALIZED_TOOL_NAMES.has(name)) continue;
    visible += withoutMarker.slice(cursor, matchIndex);
    cursor = jsonEnd;

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
  return {
    text: visible.trim(),
    toolCalls: [...existingCalls, ...recovered],
  };
}
