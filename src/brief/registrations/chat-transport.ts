import type { BriefChatTransport } from '../chat-transport.ts';
import type { BriefRegistration } from '../capabilities.ts';

export function registerChatTransport(provider: BriefChatTransport): BriefRegistration[] {
  return [{ id: 'chatTransport', provider }];
}
