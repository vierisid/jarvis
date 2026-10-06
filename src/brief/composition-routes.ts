import type { BriefCapabilities } from './capabilities';
import { CompositionRequestError, type BriefCompositionProvider } from './composition';
import { COMPOSITION_LIMITS, type BriefComposeRequest } from './composition-contracts';

type JobRequest = Request & { params: { id: string } };
async function body(req: Request): Promise<BriefComposeRequest> {
  if (!req.body) throw new CompositionRequestError('A composition request is required');
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > COMPOSITION_LIMITS.bodyBytes) { await reader.cancel(); throw new CompositionRequestError('Request body exceeds its size limit', 413); }
      chunks.push(next.value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new CompositionRequestError('Invalid composition JSON'); }
  } finally { reader.releaseLock(); }
}

/** Only mounted behind the daemon's authenticated API. Identity is server-owned, never in the body. */
export function createCompositionRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: BriefCompositionProvider) {
  const response = (body: unknown, status = 200) => { const out = json(body, status); out.headers.set('Cache-Control', 'no-store'); return out; };
  const gated = <T extends Request = Request>(operation: (req: T, provider: BriefCompositionProvider) => Response | Promise<Response>) => async (req: T) => {
    if (!provider || !capabilities.hasProvider('workflowComposition', provider)) return response({ error: 'Workflow composition is unsupported' }, 501);
    if (!capabilities.snapshot().capabilities.workflowComposition.enabled) return response({ error: 'Workflow composition is not available' }, 503);
    try { return await operation(req, provider); }
    catch (error) {
      if (error instanceof CompositionRequestError) return response({ error: error.message }, error.status);
      return response({ error: 'Workflow composition service is unavailable' }, 503);
    }
  };
  const requireIngredients = (p: BriefCompositionProvider) => {
    if (!capabilities.hasProvider('compositionIngredients', p)) throw new CompositionRequestError('Composition ingredients are unsupported', 501);
    if (!capabilities.snapshot().capabilities.compositionIngredients.enabled) throw new CompositionRequestError('Composition ingredients are not available', 503);
  };
  return {
    '/api/brief/composition-ingredients': { GET: gated((req, p) => {
      requireIngredients(p);
      const params = new URL(req.url).searchParams, offset = Number(params.get('offset') ?? '0'), query = params.get('q') ?? '';
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 || query.length > 128) throw new CompositionRequestError('Invalid ingredient query');
      return response(p.ingredients(offset, query));
    }) },
    '/api/brief/workflow-compositions': {
      GET: gated((req, p) => response({ jobs: p.list(new URL(req.url).searchParams.get('requestId') ?? undefined) })),
      POST: gated(async (req, p) => {
        const input = await body(req);
        // Reject selections behind a disabled/missing provider; never silently ignore chips.
        if (input && Object.hasOwn(input, 'ingredients')) requireIngredients(p);
        const result = p.submit(input); return response(result, result.created ? 202 : 200);
      }),
    },
    '/api/brief/workflow-compositions/:id': { GET: gated<JobRequest>((req, p) => response(p.get(req.params.id))) },
    '/api/brief/workflow-compositions/:id/cancel': { POST: gated<JobRequest>((req, p) => response(p.cancel(req.params.id))) },
  };
}
