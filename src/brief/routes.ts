import { createAttachmentRoutes } from './attachment-routes';
import type { BriefAttachmentProvider } from './attachments';
import type { BriefCapabilities } from './capabilities.ts';
import type { BriefConversationProvider } from './conversations.ts';
import { createConversationRoutes } from './conversation-routes.ts';
import { createCompositionRoutes } from './composition-routes';
import type { BriefCompositionProvider } from './composition';

/** Mounted only inside the daemon's existing authenticated API route table. */
export function createBriefRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, conversations?: BriefConversationProvider, attachments?: BriefAttachmentProvider, composition?: BriefCompositionProvider) {
  return {
    ...createCompositionRoutes(capabilities, json, composition),
    ...createAttachmentRoutes(capabilities, json, attachments),
    ...createConversationRoutes(capabilities, json, conversations),
    '/api/brief/capabilities': {
      GET: () => {
        const response = json(capabilities.snapshot());
        response.headers.set('Cache-Control', 'no-store');
        return response;
      },
    },
  };
}
