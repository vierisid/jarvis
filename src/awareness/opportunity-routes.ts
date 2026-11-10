import {
  assessOpportunities, getOpportunity, getOpportunityFeedback, getOpportunityMetrics,
  listOpportunities, OpportunityError, recordOpportunityFeedback,
} from './opportunities.ts';
import { awarenessHistoryHidden } from './history-guard.ts';

export function createOpportunityRoutes(json: (data: unknown, status?: number) => Response) {
  const wrap = (fn: (req: Request & { params: { id: string } }) => unknown) => async (req: Request & { params: { id: string } }) => {
    // Opportunities are built from recorded screen cues: hidden while awareness is off (#1314). Feedback
    // too: it answers with the opportunity, and a replayed request id makes it a plain read (#1314 review).
    const hidden = awarenessHistoryHidden(json); if (hidden) return hidden;
    try { return json(await fn(req)); }
    catch (err) {
      if (err instanceof OpportunityError) return json({ error: err.message }, err.status);
      if (err instanceof SyntaxError) return json({ error: 'Invalid JSON' }, 400);
      console.error('[Opportunities] Request failed:', err);
      return json({ error: 'Opportunity request failed' }, 500);
    }
  };
  return {
    '/api/opportunities': { GET: wrap(() => ({ opportunities: listOpportunities(), assessment: assessOpportunities() })) },
    '/api/opportunities/metrics': { GET: wrap(() => getOpportunityMetrics()) },
    '/api/opportunities/:id': { GET: wrap(req => {
      const opportunity = getOpportunity(req.params.id);
      if (!opportunity) throw new OpportunityError('Opportunity not found', 404);
      return { ...opportunity, feedback: getOpportunityFeedback(req.params.id) };
    }) },
    '/api/opportunities/:id/feedback': { POST: wrap(async req => recordOpportunityFeedback(req.params.id, await req.json())) },
  };
}
