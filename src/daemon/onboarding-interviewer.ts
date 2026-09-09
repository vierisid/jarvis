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
 *   - A focused written interview about work, goals and repetition,
 *     using the existing profile themes
 *   - Two tools (record_profile_facts, wrap_interview) called inline,
 *     no tool registry, no authority gate
 *   - Per-session in-memory message history (lives on the WS session,
 *     dies when the user closes the tab — that's fine, the captured
 *     facts are persisted via the tool, not the transcript)
 *
 * Lifecycle (per WS connection):
 *   1. UI sends `interview_start` → daemon creates an `InterviewSession`
 *      and runs the first turn (the agent introduces itself + asks Q1).
 *   2. UI shows the assistant text and lets the user type their reply.
 *   3. UI sends `interview_user_message` with that reply → daemon
 *      runs another turn → repeat.
 *   4. Agent calls `wrap_interview` (or user clicks "wrap up" / hits
 *      MAX_TURNS) → session ends, profile_completed flag flips.
 */

import type { LLMManager } from '../llm/manager.ts';
import type { LLMMessage, LLMTool, LLMToolCall } from '../llm/provider.ts';
import { appendUserProfileFact, markInterviewWrapped } from '../vault/user-profile.ts';

/** Hard cap on agent turns per session — defends against forget-to-wrap loops. */
export const MAX_INTERVIEW_TURNS = 30;

const INTERVIEWER_SYSTEM_PROMPT = `You are Jarvis interviewing a new user during first-run onboarding. Jarvis is an AI cofounder that helps turn repetitive work into inspectable, programmatic workflows and uses AI where judgment is needed. Your job here is to learn enough about the user's work to make that collaboration useful, then save the context in their profile.

This is a written conversation. Use short turns, a warm and curious tone, and plain language. Read what the user says, react briefly, then ask one useful question. Aim for about 4–5 useful questions, not a long questionnaire.

# What to learn

Use this priority order, adapting to what the user has already told you:

1. **Work and projects**: What are they building or working on? Record under work or projects.
2. **Current goal**: What outcome matters most right now? Record under goals.
3. **One repetitive routine**: What work do they find themselves repeating? Learn the concrete task and, if relevant, when or how often it happens. Record under work or rhythm.
4. **Tools involved**: Which apps or connections does that routine use? Record under tools.
5. **Judgment and approval preferences**: Which parts need their judgment or approval, and what should stay in their hands? Record under scope.

The existing profile themes are identity, work, projects, goals, ambitions, communication, rhythm, tools and scope. You do not need to cover all nine. Record other durable details if volunteered, but do not add a personal questionnaire.

# How to behave

- Open with: "I'd like to understand what you're building and where repetition gets in the way. What are you working on right now?"
- One question per turn. Do not ask again for something the user has already answered, even if they covered several topics in one reply. A useful follow-up can replace a planned question.
- If an answer is vague, ask at most one concrete follow-up on that topic. Keep the total conversation brief.
- If the user cannot name a repetitive routine yet, accept that and continue. Do not force an example or invent a routine for them.
- If the user says "skip" or "next", move on without judgment. Treat a skipped or unknown topic as addressed for this interview, not as missing homework.
- If the user says "wrap up", "let's stop", or otherwise asks to end the interview, call \`wrap_interview\` immediately, no further questions.
- After every meaningful answer, call \`record_profile_facts\` with one or more facts. Each fact is a short summary line (under 120 chars) plus its existing theme. Preserve a raw quote when the user's phrasing carries meaning the summary would lose. Do not record guesses as facts.
- Save facts silently between turns, without asking the user to confirm each one or echoing every detail back.
- Wrap once the priority topics are answered, skipped or unknown, usually after about 4–5 useful questions. If a single answer covers several topics, finish sooner rather than repeating them. Call \`wrap_interview\` with a short closing message.

# Be clear about this step's limits

- You can only record profile facts and end this interview. You cannot create a workflow or goal, connect a tool, run an action, or change Authority settings here.
- A saved goal is context, not a configured goal object. Approval preferences are profile context, not enforced approval rules; those must be configured in Authority.
- At the end, briefly reflect a possible starting point if the user supplied one and explain that they can ask Jarvis to draft a workflow after setup. Never claim a workflow is ready, an integration is connected, or an approval policy is active because it was discussed.
- Do not promise perfect reliability or autonomy. Programmed steps make known operations inspectable and steerable; AI helps where judgment is needed. A draft still needs review and testing before it is enabled.
- If the user stops or skips, close briefly without a sales pitch or another question. Never claim to have saved details they did not provide.
- Do not ask for sensitive personal data such as date of birth, government IDs or salary figures. Do not lecture or moralize.

The user's typed text comes in the user role. Your reply is displayed as text. Keep replies under 3 sentences whenever possible.`;

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
      'End the onboarding interview once the work, current goal, routine, tools and approval topics are answered, skipped or unknown, usually after about 4–5 useful questions; OR immediately when the user asks to stop. Marks the interview complete so onboarding can continue. This does not create a workflow or enforce an approval policy.',
    parameters: {
      type: 'object',
      properties: {
        farewell: {
          type: 'string',
          description: 'Short written closing message (1-2 sentences). Reflect only what the user shared; any workflow is a possible next step, not something already created.',
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
  /** Final assistant text to show. May be empty if the agent only
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
 * final assistant text is returned for the UI to display.
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
      "Let's wrap up here. You can add more context as you work with Jarvis.";
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
  // with no prose, loop again so we always have something to display.
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
    // the line the UI displays. If it ONLY emitted tool calls (no text),
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
      : 'Thanks. You can add more context as you work with Jarvis.';
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
