import type { BriefAttachmentProvider } from '../attachments';
import type { BriefRegistration } from '../capabilities';

export function registerChatAttachments(provider: BriefAttachmentProvider): BriefRegistration[] {
  return [{ id: 'chatAttachments', provider }];
}
