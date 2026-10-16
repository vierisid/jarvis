import type { BriefChatTransport } from '../chat-transport.ts';
import type { BriefRegistration } from '../capabilities.ts';

export function registerChatProgress(provider: BriefChatTransport): BriefRegistration[] {
  return [{ id: 'chatProgress', provider }];
}
