/**
 * The Pebble's turns, kept as a conversation of their own (#927).
 *
 * The conv router reads a channel's recent dialogue from the vault
 * (AgentService.loadRecentDialogue), and nothing ever stored a Pebble turn,
 * so every Pebble turn reached the router with no history: "do that" or
 * "close it again" had nothing to resolve against.
 *
 * Stored AFTER the reply, as one user/assistant pair, and only for a turn
 * that finished. A turn the user dismissed, or one whose stream failed, is
 * left out whole: storing the request alone would leave an unanswered user
 * message in the history, and storing the fallback "say it again?" line
 * would teach the router a reply nobody gave.
 *
 * One conversation for the channel, shared by every machine's Pebble, which
 * is what the dashboard chat already does for every dashboard socket.
 *
 * Only the conversation tier reads this back (classic mode keeps its own
 * in-memory history), so the daemon stores through
 * AgentService.recordPebbleExchange, which does nothing in classic mode.
 *
 * Nothing expires stored messages: the 4h window below limits what the
 * router READS, not what stays in the vault. Retention for channel
 * conversations is a separate, open question.
 */
import { getDb } from '../vault/schema.ts';
import { addMessage, getOrCreateConversation } from '../vault/conversations.ts';

export const PEBBLE_CHANNEL = 'pebble';

/**
 * How long a Pebble exchange counts as the dialogue the next turn continues.
 * The same 4 hours getOrCreateConversation uses to decide a channel's
 * conversation is still the active one (vault/conversations.ts). The READ side
 * (getRecentConversation) has no cutoff, so without this a Pebble turn after a
 * week away would hand the router last week's "open the browser" as the
 * antecedent of "do that again", next to a note telling it to act at once.
 */
export const PEBBLE_DIALOGUE_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * Store one finished Pebble exchange. Returns whether it was stored. Never
 * throws: the reply has already been spoken, so failing to remember it must
 * not end the turn.
 */
export function recordPebbleExchange(userText: string, reply: string): boolean {
  if (!userText.trim() || !reply.trim()) return false;
  try {
    getDb().transaction(() => {
      const conversation = getOrCreateConversation(PEBBLE_CHANNEL);
      addMessage(conversation.id, { role: 'user', content: userText });
      addMessage(conversation.id, { role: 'assistant', content: reply });
    })();
    return true;
  } catch (err) {
    console.warn('[pebble] failed to store the exchange:', err instanceof Error ? err.message : err);
    return false;
  }
}
