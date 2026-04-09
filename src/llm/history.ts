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
 * Compact message history for LLM API requests.
 *
 * @param messages - Full message history starting with system prompt
 * @param budgetTokens - Token budget (typically max_tokens * 3 to leave room for output)
 * @returns Compacted message list: system prompt + latest turns that fit budget
 */
export function compactHistory(messages: LLMMessage[], budgetTokens: number): LLMMessage[] {
  if (messages.length === 0) return [];
  if (messages.length === 1) return messages; // Only system prompt

  const compacted: LLMMessage[] = [];
  
  // Always keep system prompt
  if (messages[0]?.role === 'system') {
    compacted.push(messages[0]);
  }

  const budget = budgetTokens - SYSTEM_RESERVE;
  let used = compacted[0] ? measureMessage(compacted[0]) : 0;

  // Group remaining messages into atomic chunks
  // Each chunk = assistant with tool_calls + all subsequent tool results
  // Or just individual regular messages
  const chunks = chunkMessages(messages.slice(1));
  const keptChunks: LLMMessage[][] = [];

  // Work backwards from latest messages
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i]!;
    const size = measureChunk(chunk);

    // Stop if adding this chunk exceeds budget (with previous chunks kept)
    if (keptChunks.length > 0 && used + size > budget) {
      break;
    }

    keptChunks.push(chunk);
    used += size;
  }

  // Reverse back to chronological order and add to compacted
  keptChunks.reverse();
  for (const chunk of keptChunks) {
    compacted.push(...chunk);
  }

  return compacted;
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
 */
function measureMessage(message: LLMMessage): number {
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
