import { createRecommendationRoutes } from './recommendation-routes';
import type { Recommendations } from './recommendations';
import { createDecisionRoutes } from './decision-routes';
import type { DecisionQueue } from './decisions';
import { createOpportunityActivationRoutes } from './opportunity-activation-routes';
import type { OpportunityActivation } from './opportunity-activation';
import { createPreparedOpportunityRoutes } from './prepared-opportunity-routes';
import type { PreparedOpportunities } from '../awareness/prepared-opportunities';
import { createAttachmentRoutes } from './attachment-routes';
import type { BriefAttachmentProvider } from './attachments';
import type { BriefCapabilities } from './capabilities.ts';
import type { BriefConversationProvider } from './conversations.ts';
import { createConversationRoutes } from './conversation-routes.ts';
import { createCompositionRoutes } from './composition-routes';
import type { BriefCompositionProvider } from './composition';

/** Mounted only inside the daemon's existing authenticated API route table. */
export function createBriefRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, conversations?: BriefConversationProvider, attachments?: BriefAttachmentProvider, composition?: BriefCompositionProvider, prepared?: PreparedOpportunities, activation?: OpportunityActivation, decisions?: DecisionQueue, recommendations?: Recommendations) {
  return {
    ...createRecommendationRoutes(capabilities, json, recommendations),
    ...createDecisionRoutes(capabilities, json, decisions),
    ...createOpportunityActivationRoutes(capabilities, json, activation),
    ...createPreparedOpportunityRoutes(capabilities, json, prepared),
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
