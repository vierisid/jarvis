/**
 * LLM-quality suggestion generator for the voice rail's "Try saying" panel.
 *
 * Replaces the Phase 4A heuristic in `ui/src/v2/voice/useSuggestions.ts`
 * with model-generated next-move utterances grounded in the actual recent
 * conversation. The heuristic stays as a client-side fallback when this
 * endpoint is unreachable or the LLM is offline.
 *
 * Hard rule (per VOICE_SCHEMA.md): never include destructive verbs.
 * Enforced both in the prompt and via a post-filter so prompt regressions
 * can't leak.
 */

import type { LLMManager } from '../llm/manager.ts';
import type { LLMMessage } from '../llm/provider.ts';

export type SuggestionTurn = { role: 'user' | 'assistant' | 'system'; text: string };

const SYSTEM_PROMPT = `You generate 3 to 5 short voice-suggestion phrases for a JARVIS dashboard's "Try saying" panel.

Given a few recent conversation turns, suggest natural next-move utterances the user might want to say.

Rules:
- Each suggestion is a single short imperative or interrogative — 3 to 8 words.
- Match the user's tone and topic. Be specific to what was just discussed.
- NEVER suggest destructive actions: no delete, send, pay, install, terminate, modify, remove, drop.
- NEVER suggest dangerous reads either: no "show passwords", "open private", etc.
- Read-only follow-ups, drill-downs, and steering-the-conversation phrases are ideal.
- No explanation. No numbering. Just one suggestion per line, max 5 lines.

Examples (good):
What's next?
Tell me more
Why?
Open workflows
Show the latest run

Examples (bad — rejected):
Send the email now
Delete that file
Make the payment
Install the latest version`;

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\b(delete|remove|drop|wipe|purge|trash)\b/i,
  /\b(send|email|text|message|post|publish|tweet)\b/i,
  /\b(pay|buy|charge|subscribe|purchase|transfer|withdraw)\b/i,
  /\b(install|uninstall|upgrade|downgrade|deploy)\b/i,
  /\b(terminate|kill|shut\s*down|reboot|restart)\b/i,
  /\b(modify|change\s+settings|edit\s+settings|update\s+settings)\b/i,
];

function isDestructive(s: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((rx) => rx.test(s));
}

export async function generateVoiceSuggestions(
  recentTurns: SuggestionTurn[],
  llm: LLMManager,
): Promise<string[]> {
  const trimmedTurns = recentTurns
    .filter((t) => t.role === 'user' || t.role === 'assistant')
    .slice(-5);

  if (trimmedTurns.length === 0) {
    // Cold-start: let the UI's heuristic welcome set fill in.
    return [];
  }

  const contextLines = trimmedTurns
    .map((t) => `${t.role === 'user' ? 'USER' : 'JARVIS'}: ${t.text.replace(/\s+/g, ' ').slice(0, 200)}`)
    .join('\n');

  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Recent conversation:\n${contextLines}\n\nReturn 3-5 suggestions.` },
  ];

  try {
    const response = await llm.chatTier('low', 'voice_suggestions', messages, { temperature: 0.4, max_tokens: 200 });
    const raw = (response.content ?? '').split('\n');
    const cleaned: string[] = [];
    for (const line of raw) {
      const text = line
        .replace(/^[\d.\-*•\s]+/, '')
        .replace(/^["'""]+|["'""]+$/g, '')
        .trim();
      if (!text) continue;
      if (text.length < 3 || text.length > 80) continue;
      if (isDestructive(text)) continue;
      cleaned.push(text);
      if (cleaned.length >= 5) break;
    }
    return cleaned;
  } catch (err) {
    console.warn('[VoiceSuggestions] LLM call failed:', err);
    return [];
  }
}
