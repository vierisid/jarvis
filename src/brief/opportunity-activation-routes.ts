import type { BriefCapabilities } from './capabilities';
import { OpportunityActionError, type OpportunityActivation } from './opportunity-activation';

type Params = Request & { params: { id: string } };
async function body(req: Request): Promise<{ revision: string; idempotencyKey: string }> {
  if (!req.body) throw new OpportunityActionError('A request body is required');
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 2048) { await reader.cancel(); throw new OpportunityActionError('Request is too large', 413); }
      chunks.push(next.value);
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || Array.isArray(value) || Object.keys(value).length !== 2
      || Object.keys(value).some(k => k !== 'revision' && k !== 'idempotencyKey')) throw Error();
    return value;
  } catch (e) { if (e instanceof OpportunityActionError) throw e; throw new OpportunityActionError('Supply only revision and idempotencyKey'); }
  finally { reader.releaseLock(); }
}
export function createOpportunityActivationRoutes(capabilities: BriefCapabilities, json: (value: unknown, status?: number) => Response, provider?: OpportunityActivation) {
  const wrap = (action?: 'approve' | 'dismiss') => async (req: Params) => {
    let response: Response;
    try {
      if (!provider || !capabilities.hasProvider('opportunityActivation', provider)) throw new OpportunityActionError('Opportunity activation is unsupported', 501);
      if (!capabilities.snapshot().capabilities.opportunityActivation.enabled) throw new OpportunityActionError('Opportunity activation is disabled or unavailable', 503);
      if (action) {
        const input = await body(req);
        const result = provider.submit(req.params.id, input.revision, input.idempotencyKey, action);
        response = json(result, result.receipt.registration.state === 'pending' ? 202 : 200);
      } else response = json(provider.get(req.params.id));
    } catch (e) { response = e instanceof OpportunityActionError ? json({ error: e.message }, e.status) : json({ error: 'Opportunity activation is unavailable' }, 503); }
    response.headers.set('Cache-Control', 'no-store'); return response;
  };
  const base = '/api/brief/opportunity-actions/:id';
  return { [base]: { GET: wrap() }, [`${base}/approve`]: { POST: wrap('approve') }, [`${base}/dismiss`]: { POST: wrap('dismiss') } };
}
