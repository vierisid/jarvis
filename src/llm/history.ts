/**
 * Message History Compaction — Tool-Call Aware
 *
 * Intelligently trims long message histories while preserving:
 * - System prompt (first message)
 * - Latest conversation turns
 * - Complete tool-call exchange chains
 *
 * This prevents "request too large" errors and orphaned tool messages
 * that break LLM tool-calling APIs.
 */

import type { LLMMessage } from './provider.ts';

const SYSTEM_RESERVE = 500;          // Tokens reserved for system prompt
const MINIMUM_BUDGET_PER_TURN = 100;  // Minimum tokens per turn

/**
 * Eviction page size as a fraction of the budget. When trimming becomes
 * necessary, the front cut is extended to the next multiple of
 * `budget * HYSTERESIS_FRACTION` (measured in cumulative chunk size from the
 * start of history) instead of trimming to fit exactly. Cut candidates depend
 * only on the immutable prefix of an append-only history, so consecutive
 * calls pick the identical cut until growth crosses the next page - keeping
 * the retained prefix byte-stable between eviction events, which is what
 * provider prompt caches need to score hits.
 */
const HYSTERESIS_FRACTION = 0.35;

/**
 * Compact message history for LLM API requests.
 *
 * @param messages - Full message history starting with system prompt(s)
 * @param budgetTokens - Token budget (typically max_tokens * 3 to leave room for output)
 * @returns Compacted message list: leading system prompts + latest turns that fit budget
 */
export function compactHistory(messages: LLMMessage[], budgetTokens: number): LLMMessage[] {
  if (messages.length === 0) return [];
  if (messages.length === 1) return messages; // Only system prompt

  // Always keep the LEADING RUN of system messages (there may be more than
  // one: e.g. a cacheable static prompt followed by a dynamic-context one).
  let systemEnd = 0;
  while (systemEnd < messages.length && messages[systemEnd]!.role === 'system') {
    systemEnd++;
  }
  const systemMessages = messages.slice(0, systemEnd);
  const rest = messages.slice(systemEnd);

  const budget = budgetTokens - SYSTEM_RESERVE;
  const systemSize = systemMessages.reduce((total, m) => total + measureMessage(m), 0);

  // Group remaining messages into atomic chunks
  // Each chunk = assistant with tool_calls + all subsequent tool results
  // Or just individual regular messages
  const chunks = chunkMessages(rest);
  const chunkSizes = chunks.map(measureChunk);
  const chunkTotal = chunkSizes.reduce((a, b) => a + b, 0);

  // Under budget: return everything untouched (the common case, and the one
  // that must stay byte-stable for prompt caching).
  if (systemSize + chunkTotal <= budget) {
    return [...systemMessages, ...rest];
  }

  const page = Math.max(1, Math.floor(budget * HYSTERESIS_FRACTION));

  // Step 1 - minimal cut: drop oldest chunks until the remainder fits.
  // Always keep the newest chunk, even if oversized on its own.
  let dropped = 0;
  let cut = 0;
  while (cut < chunks.length - 1 && systemSize + (chunkTotal - dropped) > budget) {
    dropped += chunkSizes[cut]!;
    cut++;
  }

  // Step 2 - extend the cut forward to the next page-aligned cumulative
  // boundary so the boundary stays put until ~one page of new growth.
  const target = Math.ceil(dropped / page) * page;
  while (cut < chunks.length - 1 && dropped < target) {
    dropped += chunkSizes[cut]!;
    cut++;
  }

  return [...systemMessages, ...chunks.slice(cut).flat()];
}

/**
 * Group messages into atomic chunks for preservation during compaction.
 *
 * A chunk is either:
 * - An assistant message with tool_calls + all its subsequent tool result messages
 * - A single regular message
 *
 * This ensures tool-call exchanges stay together (required by OpenAI/Groq/etc).
 */
function chunkMessages(messages: LLMMessage[]): LLMMessage[][] {
  const chunks: LLMMessage[][] = [];

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i]!;

    // Start of a tool-use exchange
    if (current.role === 'assistant' && current.tool_calls && current.tool_calls.length > 0) {
      const chunk: LLMMessage[] = [current];
      i++;

      // Collect all subsequent tool result messages
      while (i < messages.length && messages[i]!.role === 'tool') {
        chunk.push(messages[i]!);
        i++;
      }

      // Back up one because the loop will increment
      i--;
      chunks.push(chunk);
    } else {
      // Regular message (user, system, or assistant without tool_calls)
      chunks.push([current]);
    }
  }

  return chunks;
}

/**
 * Estimate token count for a message (rough heuristic).
 * 1 token ≈ 4 characters + fixed overhead per message
 * Exported so history holders (AgentInstance) can keep a running total
 * with the same arithmetic compactHistory uses to enforce its budget.
 */
export function measureMessage(message: LLMMessage): number {
  const contentStr = typeof message.content === 'string'
    ? message.content
    : message.content.map(b => b.type === 'text' ? b.text : '[image]').join('\n');

  let size = Math.ceil(contentStr.length / 4) + 10; // 10 token overhead

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      const argsStr = JSON.stringify(tc.arguments);
      size += Math.ceil(argsStr.length / 4) + 5;
    }
  }

  return size;
}

/**
 * Estimate token count for a message chunk (multiple messages).
 */
function measureChunk(messages: LLMMessage[]): number {
  return messages.reduce((total, msg) => total + measureMessage(msg), 0);
}

/**
 * Calculate effective budget for history compaction.
 * Reserve space in token limit for: system prompt + response generation
 */
export function calculateHistoryBudget(
  requestTokenLimit: number,
  systemPromptTokens: number = 500,
  responseReserve: number = 1000,
): number {
  return Math.max(
    requestTokenLimit - systemPromptTokens - responseReserve,
    0
  );
}
