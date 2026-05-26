/**
 * Phase B — conversational onboarding interviewer.
 *
 * A lightweight, single-purpose agent loop that talks to the user
 * during first-run onboarding to capture a rich user profile. NOT a
 * full sub-agent — we deliberately skip the orchestrator's spawn
 * machinery (authority bands, message-history persistence, browser
 * state) because the interviewer doesn't need any of it.
 *
 * What it has:
 *   - A dedicated system prompt covering 9 themes the agent must hit
 *   - Two tools (record_profile_facts, wrap_interview) called inline,
 *     no tool registry, no authority gate
 *   - Per-session in-memory message history (lives on the WS session,
 *     dies when the user closes the tab — that's fine, the captured
 *     facts are persisted via the tool, not the transcript)
 *
 * Lifecycle (per WS connection):
 *   1. UI sends `interview_start` → daemon creates an `InterviewSession`
 *      and runs the first turn (the agent introduces itself + asks Q1).
 *   2. UI streams TTS of the assistant text + records the user's reply.
 *   3. UI sends `interview_user_message` with the transcript → daemon
 *      runs another turn → repeat.
 *   4. Agent calls `wrap_interview` (or user clicks "wrap up" / hits
 *      MAX_TURNS) → session ends, profile_completed flag flips.
 */

import type { LLMManager } from '../llm/manager.ts';
import type { LLMMessage, LLMTool, LLMToolCall } from '../llm/provider.ts';
import { appendUserProfileFact, markInterviewWrapped } from '../vault/user-profile.ts';

/** Hard cap on agent turns per session — defends against forget-to-wrap loops. */
export const MAX_INTERVIEW_TURNS = 30;

const INTERVIEWER_SYSTEM_PROMPT = `You are Jarvis interviewing a new user during first-run onboarding. Your job is to build a durable, structured profile so future Jarvis turns have rich context about who this person is and how to serve them.

You will be talking to the user in a real conversation — short turns, warm and curious tone, never a wall of text. Read what they say, react to it, then ask a thoughtful follow-up or move to the next theme.

# Themes you must cover (in any natural order — interleave if it flows)

1. **Identity** — name (preferred + pronunciation if non-obvious), pronouns, location/timezone.
2. **Work / role** — what they do day-to-day, what context they operate in.
3. **Current projects** — active threads of work that should be top of mind.
4. **Goals (30–90 days)** — what they're trying to accomplish in the near term.
5. **Long-horizon ambitions** — north star, the bigger why.
6. **Communication preferences** — formal vs casual, verbosity tolerance, humor tolerance, when they want push-back vs agreement, response style.
7. **Daily rhythm** — when they work, focus blocks, quiet hours, weekend vs weekday.
8. **Tools & ecosystem** — other apps Jarvis should know about (calendar, email, IDE, comms platforms).
9. **What they want Jarvis to do** — proactive vs reactive, autonomy band, what's in vs out of scope.

# How to behave

- Open with a brief, warm intro ("I'm Jarvis. I'd love to spend a few minutes getting to know you so I can be more useful from day one. Sound good?") and dive into the first question.
- One topic per turn. Don't stack three questions. After the user answers, REACT briefly (one sentence reflection or follow-up) before moving on.
- If an answer is vague ("I work in tech"), ask ONE concrete follow-up ("What kind of work — engineering, design, product?"). Don't interrogate; one follow-up max.
- If the user says "skip" or "next", move on without judgment.
- If the user says "wrap up" or "let's stop", call \`wrap_interview\` immediately, no further questions.
- After every meaningful answer, call \`record_profile_facts\` with one or more facts. Each fact is a short summary line (under 120 chars) plus the theme it belongs to. Pull a raw quote from the user when their phrasing is distinctive ("I'm allergic to small talk before noon" — keep that exact wording in raw_quote).
- Keep the conversation flowing — don't pause to confirm every fact you record. The tool calls happen silently between turns.
- When you've covered ~7+ of the 9 themes (or the user has been chatting for ~10 minutes), wrap with a short thank-you and call \`wrap_interview\`.

# What NOT to do

- Don't ask for personal data the user hasn't volunteered (no DOB, no SSN, no salary numbers).
- Don't lecture or moralize.
- Don't promise specific Jarvis features you don't know exist.
- Don't echo every fact you record back to the user — silently capture and move on.
- Don't call \`wrap_interview\` early just because the user gave terse answers; ask one more thing on a different theme first.

The user's spoken/typed text comes in the user role. Your reply text becomes the next thing Jarvis speaks aloud (or shows in chat-bubble form when TTS is off). Keep replies under 3 sentences whenever possible.`;

const INTERVIEWER_TOOLS: LLMTool[] = [
  {
    name: 'record_profile_facts',
    description:
      'Save one or more facts about the user to their profile. Call this silently between turns whenever the user reveals something durable (work, goals, preferences, projects, rhythm, etc.). Idempotent on (theme, summary).',
    parameters: {
      type: 'object',
      properties: {
        facts: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              theme: {
                type: 'string',
                description:
                  'One of the 9 themes: identity, work, projects, goals, ambitions, communication, rhythm, tools, scope.',
              },
              summary: {
                type: 'string',
                description: 'Short fact line, under 120 chars. e.g. "Based in Italy, CEST timezone." or "Prefers concise direct replies, dislikes hedge language."',
              },
              raw_quote: {
                type: 'string',
                description: 'Optional: the user\'s distinctive phrasing if it captures something the summary loses.',
              },
            },
            required: ['theme', 'summary'],
          },
        },
      },
      required: ['facts'],
    },
  },
  {
    name: 'wrap_interview',
    description:
      'End the onboarding interview. Call when ~7+ themes are covered OR the user explicitly asks to stop. Marks the profile complete and returns the user to the regular dashboard.',
    parameters: {
      type: 'object',
      properties: {
        farewell: {
          type: 'string',
          description: 'Short closing message to speak to the user (1-2 sentences).',
        },
      },
      required: ['farewell'],
    },
  },
];

export interface InterviewSession {
  /** In-memory transcript — never persisted to vault conversations. */
  messages: LLMMessage[];
  /** Defensive turn counter — stops runaway loops. */
  turnCount: number;
  /** Set to true once `wrap_interview` fires (or MAX_INTERVIEW_TURNS hit). */
  done: boolean;
  /** Closing line the agent (or the safeguard) emits on wrap. */
  farewell?: string;
  /** Count of facts recorded so far — surfaced to the UI for progress. */
  factsRecorded: number;
}

export function createInterviewSession(): InterviewSession {
  return {
    messages: [
      { role: 'system', content: INTERVIEWER_SYSTEM_PROMPT },
    ],
    turnCount: 0,
    done: false,
    factsRecorded: 0,
  };
}

export interface InterviewTurnResult {
  /** Final assistant text to speak/show. May be empty if the agent only
   *  emitted tool calls without prose this turn (rare — we coax it via
   *  the system prompt to always say something). */
  assistantText: string;
  /** True when this turn ended the interview (wrap_interview fired or
   *  MAX_INTERVIEW_TURNS hit). */
  done: boolean;
  /** Closing line if the interview ended this turn. */
  farewell?: string;
  /** Cumulative facts-recorded count after this turn. */
  factsRecorded: number;
}

/**
 * Run a single interviewer turn. The caller appends the user's text
 * (when present), then calls this; we drive the LLM with our 2-tool
 * registry, execute any tool calls inline, and repeat the LLM call
 * until the agent emits a stop response (no more tool calls). The
 * final assistant text is returned for the UI to speak.
 *
 * `userText` is null on the very first turn — we want the agent to
 * open with its intro without the user having said anything yet.
 */
export async function runInterviewTurn(
  session: InterviewSession,
  llm: LLMManager,
  userText: string | null,
): Promise<InterviewTurnResult> {
  if (session.done) {
    return {
      assistantText: '',
      done: true,
      farewell: session.farewell,
      factsRecorded: session.factsRecorded,
    };
  }

  if (userText !== null) {
    session.messages.push({ role: 'user', content: userText.trim() });
  } else if (session.messages.length === 1) {
    // First turn: the user hasn't said anything yet, but Anthropic
    // (and a strict reading of the OpenAI spec) require `messages` to
    // contain at least one non-system turn — a system-only call returns
    // 400 invalid_request_error. Seed a synthetic kick-off user turn so
    // the agent has something to respond to. The agent's system prompt
    // already tells it to open with a warm intro + the first question.
    session.messages.push({
      role: 'user',
      content: '[The user has just opened the onboarding interview. Greet them warmly and begin with your first question.]',
    });
  }

  session.turnCount++;
  if (session.turnCount > MAX_INTERVIEW_TURNS) {
    // Safeguard: stop the loop if the agent never wrapped on its own.
    session.done = true;
    session.farewell =
      "We've covered a lot. Let me wrap here — I have plenty to start with. Welcome aboard.";
    markInterviewWrapped();
    return {
      assistantText: session.farewell,
      done: true,
      farewell: session.farewell,
      factsRecorded: session.factsRecorded,
    };
  }

  // Inline tool-loop. Most turns will be one LLM call (text reply +
  // optional silent tool calls). If the agent emits ONLY tool calls
  // with no prose, loop again so we always have something to speak.
  for (let inner = 0; inner < 4; inner++) {
    // Onboarding is conversational - prefer the conversation tier when
    // configured, falling back through the standard tier chain. Phase 4 will
    // migrate this to the router-first conversation flow proper.
    const response = await llm.chatTier(
      llm.hasConversationTier() ? 'conversation' : 'medium',
      'onboarding_interviewer',
      session.messages,
      {
        tools: INTERVIEWER_TOOLS,
        tool_choice: 'auto',
        temperature: 0.6,
        max_tokens: 800,
      },
    );

    // Persist the assistant turn (text + tool_use) so the LLM sees its
    // own previous tool calls on the next iteration.
    session.messages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.tool_calls.length > 0 ? response.tool_calls : undefined,
    });

    // Execute any tool calls inline. Each call adds a tool-result
    // message back to the history.
    let wrappedThisTurn = false;
    for (const call of response.tool_calls) {
      const result = executeInterviewerTool(session, call);
      session.messages.push({
        role: 'tool',
        content: result.message,
        tool_call_id: call.id,
      });
      if (result.wrapped) wrappedThisTurn = true;
    }

    if (wrappedThisTurn) {
      session.done = true;
      return {
        assistantText: response.content || session.farewell || 'Done.',
        done: true,
        farewell: session.farewell,
        factsRecorded: session.factsRecorded,
      };
    }

    // If the agent gave us prose, we're done with this turn — that's
    // the line the UI speaks. If it ONLY emitted tool calls (no text),
    // loop and let the LLM produce the actual reply now that it sees
    // the tool results.
    if (response.content && response.content.trim().length > 0) {
      return {
        assistantText: response.content,
        done: false,
        factsRecorded: session.factsRecorded,
      };
    }

    if (response.tool_calls.length === 0) {
      // No text AND no tool calls — broken response. Bail out gracefully.
      return {
        assistantText: '…',
        done: false,
        factsRecorded: session.factsRecorded,
      };
    }
  }

  // Hit the inner-loop cap — should be very rare. Return whatever we have.
  return {
    assistantText: '…',
    done: false,
    factsRecorded: session.factsRecorded,
  };
}

/**
 * Execute one tool call from the interviewer. Returns the string we
 * push back as the tool's result message, plus a flag indicating
 * whether the call ended the interview.
 */
function executeInterviewerTool(
  session: InterviewSession,
  call: LLMToolCall,
): { message: string; wrapped: boolean } {
  if (call.name === 'record_profile_facts') {
    const args = call.arguments as { facts?: Array<{ theme: string; summary: string; raw_quote?: string }> };
    const facts = Array.isArray(args.facts) ? args.facts : [];
    if (facts.length === 0) {
      return { message: 'Error: facts array was empty.', wrapped: false };
    }
    let saved = 0;
    for (const f of facts) {
      if (typeof f?.theme !== 'string' || typeof f?.summary !== 'string') continue;
      try {
        appendUserProfileFact({
          theme: f.theme.trim(),
          summary: f.summary.trim(),
          raw_quote: typeof f.raw_quote === 'string' && f.raw_quote.trim() ? f.raw_quote.trim() : undefined,
        });
        saved++;
      } catch (err) {
        console.warn('[Interviewer] Failed to save fact:', err);
      }
    }
    session.factsRecorded += saved;
    return { message: `Saved ${saved} fact${saved === 1 ? '' : 's'}.`, wrapped: false };
  }

  if (call.name === 'wrap_interview') {
    const args = call.arguments as { farewell?: string };
    const farewell = typeof args.farewell === 'string' && args.farewell.trim()
      ? args.farewell.trim()
      : 'All set — welcome to Jarvis.';
    session.farewell = farewell;
    try {
      markInterviewWrapped();
    } catch (err) {
      console.warn('[Interviewer] Failed to mark interview complete:', err);
    }
    return { message: 'Interview wrapped.', wrapped: true };
  }

  return { message: `Error: unknown tool "${call.name}".`, wrapped: false };
}

/**
 * Skip path — user clicked "Skip" instead of going through the
 * conversation. Sets the `setup_skipped_profile` flag so the gate
 * stops re-rendering Phase B. The user can still revisit the profile
 * later via the Settings → Profile wizard.
 */
export function skipInterview(): void {
  // Vault-side: we DON'T mark the profile complete on skip — leaving
  // completed_at null is what surfaces "no profile saved yet" in the
  // settings wizard. The skip flag lives on the onboarding config
  // separately (handled by the API route caller).
}
