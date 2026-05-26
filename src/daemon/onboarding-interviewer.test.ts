import { describe, expect, test, beforeEach } from 'bun:test';
import { initDatabase } from '../vault/schema.ts';
import {
  createInterviewSession,
  runInterviewTurn,
  MAX_INTERVIEW_TURNS,
} from './onboarding-interviewer.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { LLMResponse, LLMToolCall } from '../llm/provider.ts';

// Build a fake LLMManager whose `chat()` returns a queued sequence of
// canned responses. The interviewer's `runInterviewTurn` only uses
// `llm.chat`, so we can satisfy the type with a tiny shim.
function fakeLLM(responses: LLMResponse[]): LLMManager {
  const queue = [...responses];
  const chat = async (): Promise<LLMResponse> => {
    const next = queue.shift();
    if (!next) {
      // Default tail response: text-only with no tool calls. Lets tests
      // rely on responses[] without padding the array for inner-loop edge cases.
      return {
        content: '…',
        tool_calls: [],
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'fake',
        finish_reason: 'stop',
      };
    }
    return next;
  };
  return {
    chat,
    // The interviewer routes through chatTier (conversation tier when
    // configured, else medium). Both paths land here.
    chatTier: async () => chat(),
    hasConversationTier: () => false,
  } as unknown as LLMManager;
}

function textResponse(content: string): LLMResponse {
  return {
    content,
    tool_calls: [],
    usage: { input_tokens: 10, output_tokens: 20 },
    model: 'fake',
    finish_reason: 'stop',
  };
}

function toolResponse(content: string, calls: LLMToolCall[]): LLMResponse {
  return {
    content,
    tool_calls: calls,
    usage: { input_tokens: 10, output_tokens: 20 },
    model: 'fake',
    finish_reason: 'tool_use',
  };
}

describe('createInterviewSession', () => {
  beforeEach(() => initDatabase(':memory:'));

  test('starts with one system message, zero turns, not done', () => {
    const session = createInterviewSession();
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.role).toBe('system');
    expect(session.turnCount).toBe(0);
    expect(session.done).toBe(false);
    expect(session.factsRecorded).toBe(0);
    expect(session.farewell).toBeUndefined();
  });
});

describe('runInterviewTurn — happy path', () => {
  beforeEach(() => initDatabase(':memory:'));

  test('first turn (userText null) seeds a synthetic user message and returns the agent intro', async () => {
    const session = createInterviewSession();
    const llm = fakeLLM([textResponse('Hi there! What do you do for work?')]);

    const result = await runInterviewTurn(session, llm, null);

    expect(result.assistantText).toBe('Hi there! What do you do for work?');
    expect(result.done).toBe(false);
    expect(session.turnCount).toBe(1);
    // Message log: system + synthetic user kickoff + assistant reply.
    expect(session.messages).toHaveLength(3);
    expect(session.messages[1]?.role).toBe('user');
    expect(session.messages[2]?.role).toBe('assistant');
  });

  test('subsequent turns append the user message and return the assistant reply', async () => {
    const session = createInterviewSession();
    const firstLLM = fakeLLM([textResponse('Hi! What do you do?')]);
    await runInterviewTurn(session, firstLLM, null);

    const secondLLM = fakeLLM([textResponse('Got it — and what brings you to Jarvis?')]);
    const result = await runInterviewTurn(session, secondLLM, "I'm a software engineer");

    expect(result.assistantText).toBe('Got it — and what brings you to Jarvis?');
    expect(session.turnCount).toBe(2);
    // The "I'm a software engineer" message is in the log.
    const userMessages = session.messages.filter((m) => m.role === 'user');
    expect(userMessages.some((m) => typeof m.content === 'string' && m.content.includes('software engineer'))).toBe(true);
  });

  test('record_profile_facts tool call increments factsRecorded and persists to the in-memory DB', async () => {
    const session = createInterviewSession();
    // Two-step inner loop: first response emits a tool call, second
    // returns the final prose. The interviewer's inner loop drives both.
    const llm = fakeLLM([
      toolResponse('', [
        {
          id: 'call_1',
          name: 'record_profile_facts',
          arguments: {
            facts: [
              { theme: 'work', summary: 'Software engineer at a startup', raw_quote: 'I work in software' },
              { theme: 'goals', summary: 'Wants to ship faster', raw_quote: 'I want to be more productive' },
            ],
          },
        },
      ]),
      textResponse('Great, that helps me a lot. Anything else you want me to know?'),
    ]);

    const result = await runInterviewTurn(session, llm, "I work in software and I want to be more productive");

    expect(result.factsRecorded).toBe(2);
    expect(session.factsRecorded).toBe(2);
    expect(result.done).toBe(false);
    expect(result.assistantText).toBe('Great, that helps me a lot. Anything else you want me to know?');
  });

  test('wrap_interview tool call ends the interview with the agent\'s farewell', async () => {
    const session = createInterviewSession();
    const llm = fakeLLM([
      toolResponse('', [
        {
          id: 'call_wrap',
          name: 'wrap_interview',
          arguments: { farewell: 'All set — welcome to Jarvis. Talk soon!' },
        },
      ]),
    ]);

    const result = await runInterviewTurn(session, llm, "I think that's everything for now");

    expect(result.done).toBe(true);
    expect(result.farewell).toBe('All set — welcome to Jarvis. Talk soon!');
    expect(session.done).toBe(true);
  });

  test('subsequent turns on a done session return immediately without calling the LLM', async () => {
    const session = createInterviewSession();
    session.done = true;
    session.farewell = 'previous farewell';
    session.factsRecorded = 5;

    let chatCalled = false;
    const llm = {
      chat: async () => {
        chatCalled = true;
        return textResponse('should not be called');
      },
      chatTier: async () => {
        chatCalled = true;
        return textResponse('should not be called');
      },
      hasConversationTier: () => false,
    } as unknown as LLMManager;

    const result = await runInterviewTurn(session, llm, 'hello?');

    expect(chatCalled).toBe(false);
    expect(result.done).toBe(true);
    expect(result.farewell).toBe('previous farewell');
    expect(result.factsRecorded).toBe(5);
  });
});

describe('runInterviewTurn — MAX_INTERVIEW_TURNS safeguard', () => {
  beforeEach(() => initDatabase(':memory:'));

  test('the constant is set to a sensible bound (sanity check)', () => {
    // The exact value isn't a contract, but it should be in the
    // "many turns to reach naturally" range — small enough to bail
    // out of a runaway loop, large enough that real interviews don't
    // hit it. Pinning a sane window prevents accidental drift to 5
    // (cuts real interviews short) or 500 (defeats the purpose).
    expect(MAX_INTERVIEW_TURNS).toBeGreaterThanOrEqual(15);
    expect(MAX_INTERVIEW_TURNS).toBeLessThanOrEqual(60);
  });

  test('hitting the cap forces wrap with a synthesized farewell, even if the agent never wrapped on its own', async () => {
    const session = createInterviewSession();
    // Pre-load turnCount to the cap. The next call increments past it.
    session.turnCount = MAX_INTERVIEW_TURNS;

    let chatCalled = false;
    const llm = {
      chat: async () => {
        chatCalled = true;
        return textResponse('this should not be reached');
      },
      chatTier: async () => {
        chatCalled = true;
        return textResponse('this should not be reached');
      },
      hasConversationTier: () => false,
    } as unknown as LLMManager;

    const result = await runInterviewTurn(session, llm, "and another thing...");

    // The safeguard must terminate WITHOUT calling the LLM further —
    // otherwise a misbehaving agent could keep generating tokens forever.
    expect(chatCalled).toBe(false);
    expect(result.done).toBe(true);
    expect(session.done).toBe(true);
    expect(result.farewell).toBeDefined();
    expect(result.farewell!.length).toBeGreaterThan(0);
  });
});
