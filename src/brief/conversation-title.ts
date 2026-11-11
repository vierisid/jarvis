/** A local, deterministic topic label. Never sends message content to a second model. */
export function conversationTitle(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  const topic = clean.replace(/^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:tell me|help me (?:with|to)|I'd like to|I would like to)\s+/i, '') || clean;
  const shortened = topic.length > 60 ? topic.slice(0, 57).replace(/\s+\S*$/, '') + '…' : topic.replace(/[.!?]+$/, '');
  return shortened.charAt(0).toLocaleUpperCase() + shortened.slice(1);
}

/** Channels whose threads are titled after their sender, as the channel is named in a sentence. */
const CHANNEL_NAMES: Record<string, string> = { telegram: 'Telegram', discord: 'Discord' };
/** How a channel is named in a thread title, or null for the dashboard's own conversations. */
export function threadChannelName(channel: string | null | undefined): string | null {
  return channel && Object.hasOwn(CHANNEL_NAMES, channel) ? CHANNEL_NAMES[channel]! : null;
}
const SENDER_NAME_MAX = 40;
/** Letters that draw nothing (Hangul fillers, the blank Braille pattern): a name of only these would look empty. */
const INVISIBLE_LETTERS = /[\u115F\u1160\u3164\uFFA0\u2800]/g;

/**
 * The title a Telegram or Discord thread is created with, so closed threads
 * can be told apart (#1313 follow-up). Who the sender is comes from the
 * server, never from the name: the owner's own private chat is "Telegram -
 * you, <day>", the owner in a group "Telegram group - you, <day>", and anyone
 * else "Telegram guest - <name>, <day>", so no name can pass for the owner's.
 * The name is what the sender chose: untrusted. It is normalised (NFKC),
 * loses control, format and invisible characters and stacked combining
 * marks, collapses whitespace and is capped; it is only ever rendered as
 * text. Undefined (a channel without threads of its own) keeps the default title.
 */
export function channelThreadTitle(channel: string, sender: unknown, who: 'owner' | 'shared' | 'guest',
  where: { privateChat: boolean; startedAt: number }): string | undefined {
  const label = threadChannelName(channel);
  if (!label) return undefined;
  // A sender has a thread per chat and a new one after a quiet spell: the kind
  // of chat and the day it started tell them apart.
  const place = where.privateChat ? label : `${label} group`;
  // UTC: the daemon does not know the viewer's time zone.
  const day = `, ${new Date(where.startedAt).toISOString().slice(0, 10)}`;
  if (who !== 'guest') return `${place} - you${day}`;
  // A guest with no usable name is still marked a guest, never left on the
  // neutral default an owner's older thread shows.
  const nameless = `${place} guest${day}`;
  if (typeof sender !== 'string') return nameless;
  const clean = sender.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(INVISIBLE_LETTERS, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}\p{S}\p{P}]/u.test(clean)) return nameless;
  const chars = [...clean];
  return `${place} guest - ${chars.length > SENDER_NAME_MAX ? `${chars.slice(0, SENDER_NAME_MAX).join('').trimEnd()}...` : clean}${day}`;
}
