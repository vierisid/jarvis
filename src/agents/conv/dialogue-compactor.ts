/**
 * DialogueCompactor - condenses old turns of a long conversation into a
 * single summary system message, leaving the most-recent N turns verbatim.
 *
 * Critical UX property: compact() NEVER blocks on an LLM call. It uses the
 * latest cached summary if available, and fires recompaction in the
 * background when the head boundary has shifted. This means a long
 * conversation's first slow turn pays no compaction latency (just truncates
 * to the tail), and subsequent turns see the freshly-built summary.
 *
 * Why this matters: the compactor runs on the `low` tier. With slow local
 * models (ollama) the LLM call can take 5-10 seconds. Blocking the chat on
 * that every turn ruins the conversation-tier responsiveness gain. The
 * background pattern preserves continuity for long conversations while
 * keeping the foreground path fast.
 */

import type { LLMManager } from '../../llm/manager.ts';
import type { LLMMessage } from '../../llm/provider.ts';

type CacheEntry = {
  /** Head slice size at the time we summarized. */
  headCount: number;
  /** The summary text. */
  summary: string;
  /** Wall-clock timestamp - used to drop stale entries. */
  builtAt: number;
};

const CACHE_TTL_MS = 30 * 60_000;  // 30 min: idle convos get re-summarized fresh

export class DialogueCompactor {
  private cache: Map<string, CacheEntry> = new Map();
  private pending: Set<string> = new Set();

  constructor(
    private readonly llm: LLMManager,
    // Keep the last 20 turns (~10 user + 10 assistant pairs) verbatim. Modern
    // conv-tier models (gpt-4o-mini, claude haiku, llama 3.x) have 128K+
    // context, so this is cheap and lets the conv LLM follow multi-turn
    // threads without leaning on the summarizer for everything.
    private readonly keepRecent: number = 20,
    // Only compact when the conversation is genuinely long. Below this we
    // pass everything through verbatim - no summarizer call, no head bucket.
    private readonly compactionThreshold: number = 40,
  ) {}

  /**
   * Compact a conversation history. Always synchronous-ish: never awaits an
   * LLM call on the hot path.
   *
   * Behavior:
   *   - Short conversation (under threshold): pass through unchanged.
   *   - Long conversation, cache hit: return cached summary + current tail.
   *     If the head boundary shifted, fire a background recompaction so the
   *     next turn sees fresh summary.
   *   - Long conversation, no cache: return ONLY the tail (lose head context
   *     for this turn) and fire a background compaction. Next turn benefits.
   */
  async compact(conversationId: string, messages: LLMMessage[]): Promise<LLMMessage[]> {
    if (messages.length <= this.compactionThreshold) {
      return messages;
    }

    const tail = messages.slice(-this.keepRecent);
    const currentHeadCount = messages.length - this.keepRecent;
    const cached = this.cache.get(conversationId);
    const fresh = cached && Date.now() - cached.builtAt < CACHE_TTL_MS;

    if (cached && fresh) {
      // If the boundary has shifted, queue a background recompact for next
      // turn. The current turn still uses the slightly-stale cached summary.
      if (cached.headCount < currentHeadCount) {
        this.scheduleRecompact(conversationId, messages);
      }
      return [
        {
          role: 'system',
          content: `Earlier in this conversation (summary of ${cached.headCount} prior turns):\n${cached.summary}`,
        },
        ...tail,
      ];
    }

    // No usable cache - this is the first long-conversation turn we've seen.
    // Don't block; just truncate to the tail and compact in the background
    // so the NEXT turn gets a proper summary.
    this.scheduleRecompact(conversationId, messages);
    return tail;
  }

  /** Discard a cached summary - call when a conversation thread is reset/replaced. */
  invalidate(conversationId: string): void {
    this.cache.delete(conversationId);
    this.pending.delete(conversationId);
  }

  /**
   * Fire-and-forget recompaction. Guards against stampedes (multiple
   * concurrent compactions for the same conversation).
   */
  private scheduleRecompact(conversationId: string, messages: LLMMessage[]): void {
    if (this.pending.has(conversationId)) return;
    this.pending.add(conversationId);
    const headCount = messages.length - this.keepRecent;
    const head = messages.slice(0, headCount);
    this.summarizeHead(head)
      .then(summary => {
        this.cache.set(conversationId, {
          headCount,
          summary,
          builtAt: Date.now(),
        });
      })
      .catch(err => {
        console.warn('[DialogueCompactor] Background recompact failed:', err);
      })
      .finally(() => {
        this.pending.delete(conversationId);
      });
  }

  private async summarizeHead(head: LLMMessage[]): Promise<string> {
    const transcript = head
      .map(m => {
        const content = typeof m.content === 'string' ? m.content : '[non-text content]';
        const role = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'JARVIS' : m.role.toUpperCase();
        return `${role}: ${content.slice(0, 800)}`;
      })
      .join('\n');

    const response = await this.llm.chatTier('low', 'dialogue_compactor', [
      {
        role: 'system',
        content: `Summarize the conversation below in 4-6 short bullet points. Preserve concrete facts the conversation could refer back to (names, decisions, commitments, blockers). Drop greetings and filler. Output ONLY the bullets - no preamble.`,
      },
      { role: 'user', content: transcript },
    ], { temperature: 0.1, max_tokens: 400 });
    return response.content?.trim() || '(prior turns omitted)';
  }
}
