/**
 * DialogueCompactor - condenses old turns of a long conversation into a
 * single summary system message, leaving the most-recent N turns verbatim.
 *
 * Strategy:
 *   - When the conversation has <= keepRecent + 2 turns, no compaction; return
 *     all turns as-is.
 *   - Otherwise compact the head slice (older turns) into one short summary
 *     via the `low` tier and prepend it as a synthetic system note. The tail
 *     slice (keepRecent most recent turns) stays verbatim.
 *
 * Cache: per-conversation, keyed by the number of head messages we already
 * summarized. If subsequent turns only add to the tail, the cached summary
 * is reused without another low-tier call. When the head boundary shifts
 * (new turns push older ones out of the tail window), we recompact.
 */

import type { LLMManager } from '../../llm/manager.ts';
import type { LLMMessage } from '../../llm/provider.ts';

type CacheEntry = {
  /** Number of messages we summarized (the head slice size). */
  headCount: number;
  /** The summary text. */
  summary: string;
  /** Wall-clock timestamp - used to drop stale entries. */
  builtAt: number;
};

const CACHE_TTL_MS = 30 * 60_000;  // 30 min: longer convos that idle get re-summarized

export class DialogueCompactor {
  private cache: Map<string, CacheEntry> = new Map();
  constructor(
    private readonly llm: LLMManager,
    private readonly keepRecent: number = 8,
    private readonly compactionThreshold: number = 14,
  ) {}

  /**
   * Compact a conversation history. Returns the messages to pass to the
   * conv LLM (possibly with a leading summary system message).
   *
   * @param conversationId - key for the summary cache (one cache entry per
   *   live conversation thread).
   * @param messages - the full known message list, oldest first.
   */
  async compact(conversationId: string, messages: LLMMessage[]): Promise<LLMMessage[]> {
    if (messages.length <= this.compactionThreshold) {
      return messages;
    }

    const headCount = messages.length - this.keepRecent;
    const head = messages.slice(0, headCount);
    const tail = messages.slice(headCount);

    const cached = this.cache.get(conversationId);
    const fresh = cached && Date.now() - cached.builtAt < CACHE_TTL_MS;

    let summary: string;
    if (cached && fresh && cached.headCount === headCount) {
      summary = cached.summary;
    } else {
      summary = await this.summarizeHead(head);
      this.cache.set(conversationId, {
        headCount,
        summary,
        builtAt: Date.now(),
      });
    }

    return [
      {
        role: 'system',
        content: `Earlier in this conversation (summary of ${headCount} prior turns):\n${summary}`,
      },
      ...tail,
    ];
  }

  /** Discard a cached summary - call when a conversation thread is reset/replaced. */
  invalidate(conversationId: string): void {
    this.cache.delete(conversationId);
  }

  private async summarizeHead(head: LLMMessage[]): Promise<string> {
    const transcript = head
      .map(m => {
        const content = typeof m.content === 'string' ? m.content : '[non-text content]';
        const role = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'JARVIS' : m.role.toUpperCase();
        return `${role}: ${content.slice(0, 800)}`;
      })
      .join('\n');

    try {
      const response = await this.llm.chatTier('low', 'dialogue_compactor', [
        {
          role: 'system',
          content: `Summarize the conversation below in 4-6 short bullet points. Preserve concrete facts the conversation could refer back to (names, decisions, commitments, blockers). Drop greetings and filler. Output ONLY the bullets - no preamble.`,
        },
        { role: 'user', content: transcript },
      ], { temperature: 0.1, max_tokens: 400 });
      return response.content?.trim() || '(prior turns omitted)';
    } catch (err) {
      console.warn('[DialogueCompactor] Summarization failed:', err);
      return '(prior turns omitted due to summarization error)';
    }
  }
}
