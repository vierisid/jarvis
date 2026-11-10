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

/**
 * The title a Telegram or Discord thread is created with, so closed threads
 * can be told apart (#1313 follow-up). The name is what the sender chose:
 * untrusted. Control and format characters (bidi overrides, zero-width) go,
 * whitespace collapses and it is capped; it is only ever rendered as text.
 * Undefined keeps the default title.
 */
export function channelThreadTitle(channel: string, sender: unknown): string | undefined {
  const label = threadChannelName(channel);
  if (!label || typeof sender !== 'string') return undefined;
  const clean = sender.replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  const chars = [...clean];
  return `${label} - ${chars.length > SENDER_NAME_MAX ? `${chars.slice(0, SENDER_NAME_MAX).join('').trimEnd()}...` : clean}`;
}
