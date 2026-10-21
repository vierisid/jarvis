/** A local, deterministic topic label. Never sends message content to a second model. */
export function conversationTitle(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  const topic = clean.replace(/^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:tell me|help me (?:with|to)|I'd like to|I would like to)\s+/i, '') || clean;
  const shortened = topic.length > 60 ? topic.slice(0, 57).replace(/\s+\S*$/, '') + '…' : topic.replace(/[.!?]+$/, '');
  return shortened.charAt(0).toLocaleUpperCase() + shortened.slice(1);
}
