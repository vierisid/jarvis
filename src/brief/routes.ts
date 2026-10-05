import type { BriefCapabilities } from './capabilities.ts';
import type { BriefConversationProvider } from './conversations.ts';
import { createConversationRoutes } from './conversation-routes.ts';

/** Mounted only inside the daemon's existing authenticated API route table. */
export function createBriefRoutes(capabilities: BriefCapabilities, json: (body: unknown) => Response, conversations?: BriefConversationProvider) {
  return {
    ...createConversationRoutes(capabilities, conversations),
    '/api/brief/capabilities': {
      GET: () => {
        const response = json(capabilities.snapshot());
        response.headers.set('Cache-Control', 'no-store');
        return response;
      },
    },
  };
}
