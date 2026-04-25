import { useEffect, useMemo, useRef, useState } from "react";
import type { ThreadItem } from "../thread/types";

/**
 * Heuristic suggestion generator (Phase 4A — kept as fallback in 4B).
 *
 * Surfaces 3–5 next-move utterances from the last few thread items so the
 * voice rail's "Try saying" panel is context-aware. Phase 4B layered on a
 * server-side LLM generator (`useLLMSuggestions`) and falls back to this
 * heuristic when the daemon is offline or the LLM call fails.
 *
 * Hard rules per the design handoff (`COMPONENTS.md` + `VOICE_SCHEMA.md`):
 *  - Never include destructive verbs (delete, send, pay, install, terminate,
 *    modify) — those must be spoken or typed deliberately, never suggested.
 *  - Suggestions are *Intents* downstream — clicking them produces the same
 *    user-text ThreadItem as the user typing the phrase.
 *
 * Strategy:
 *  - Empty thread → curated welcome set
 *  - Last item is `jarvis-speech` → continuation prompts ("Tell me more",
 *    "Why?", "What about X?")
 *  - Last item is `card` → drill-down prompts ("Open it", "Show details",
 *    "What's its status?")
 *  - Last item is `result` → follow-up prompts ("What's next?", "Why?")
 *  - Last item is `approval` → keep the rail quiet (the user is mid-decision)
 *  - Otherwise → general prompts
 *
 * Always returns 0–5 strings, never destructive.
 */

const DESTRUCTIVE_VERB_PATTERNS = [
  /\b(delete|remove|drop|wipe|purge|trash)\b/i,
  /\b(send|email|text|message|post|publish|tweet)\b/i,
  /\b(pay|buy|charge|subscribe|purchase|transfer|withdraw)\b/i,
  /\b(install|uninstall|upgrade|downgrade|deploy)\b/i,
  /\b(terminate|kill|stop the|shut down|reboot|restart)\b/i,
  /\b(modify|change settings|edit settings|update settings)\b/i,
];

function isDestructive(s: string): boolean {
  return DESTRUCTIVE_VERB_PATTERNS.some((rx) => rx.test(s));
}

const WELCOME_SET = [
  "What's on my calendar today?",
  "Summarize yesterday's logs",
  "Open workflows",
  "What did the researcher finish overnight?",
];

const SPEECH_FOLLOWUPS = [
  "Tell me more",
  "Why?",
  "What's the source?",
  "Take me back",
];

const CARD_FOLLOWUPS = [
  "Open it",
  "Show details",
  "What's its status?",
  "Take me back",
];

const RESULT_FOLLOWUPS = [
  "What's next?",
  "Show me the details",
  "Why?",
];

const GENERAL = [
  "What's the latest?",
  "What can you do?",
  "Open workflows",
];

function pickSet(items: ThreadItem[]): string[] {
  if (items.length === 0) return WELCOME_SET;

  // If we're mid-approval, suggest nothing — the user is making a decision.
  const lastFew = items.slice(-3);
  if (lastFew.some((i) => i.kind === "approval")) return [];

  const last = items[items.length - 1];
  if (!last) return GENERAL;

  switch (last.kind) {
    case "jarvis-speech":
    case "jarvis-thought":
      return SPEECH_FOLLOWUPS;
    case "card":
      return CARD_FOLLOWUPS;
    case "result":
      return RESULT_FOLLOWUPS;
    default:
      return GENERAL;
  }
}

export function useSuggestions(items: ThreadItem[]): string[] {
  return useMemo(() => {
    const candidates = pickSet(items);
    return candidates.filter((s) => !isDestructive(s)).slice(0, 5);
  }, [items]);
}

/**
 * LLM-backed suggestions (Phase 4B). Calls `/api/voice/suggestions` with the
 * last few user/assistant turns; debounced 600ms so rapid streaming updates
 * don't thrash the endpoint. Falls back to the heuristic on error or when
 * the API returns an empty list.
 *
 * Pass `enabled={false}` (e.g. when WS is offline) to skip the network call
 * entirely and use the heuristic immediately.
 */
export function useLLMSuggestions(items: ThreadItem[], opts: { enabled: boolean }): string[] {
  const heuristic = useSuggestions(items);
  const [llm, setLLM] = useState<string[] | null>(null);
  const lastKeyRef = useRef("");

  useEffect(() => {
    if (!opts.enabled) {
      setLLM(null);
      return;
    }

    // Build a stable key from the last 5 user/assistant items so we only
    // re-fetch when the relevant context changes.
    const turns = itemsToTurns(items);
    const key = turns.map((t) => `${t.role}:${t.text.slice(0, 80)}`).join("|");
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;

    if (turns.length === 0) {
      setLLM(null);
      return;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const resp = await fetch("/api/voice/suggestions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recentTurns: turns }),
          signal: ctrl.signal,
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as { suggestions?: unknown };
        if (Array.isArray(data.suggestions) && data.suggestions.length > 0) {
          const cleaned = data.suggestions
            .filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
            .filter((s) => !isDestructive(s))
            .slice(0, 5);
          if (cleaned.length > 0) setLLM(cleaned);
        }
      } catch {
        // Swallow — heuristic stays in place
      }
    }, 600);

    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [items, opts.enabled]);

  return llm && llm.length > 0 ? llm : heuristic;
}

function itemsToTurns(items: ThreadItem[]): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const item of items.slice(-12)) {
    if (item.kind === "user-text" || item.kind === "user-voice") {
      out.push({ role: "user", text: item.text });
    } else if (item.kind === "jarvis-speech") {
      out.push({ role: "assistant", text: item.text });
    }
  }
  return out.slice(-5);
}
