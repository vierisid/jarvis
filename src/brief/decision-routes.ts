import type { BriefCapabilities } from './capabilities';
import { DecisionError, type DecisionQueue } from './decisions';
import type { DecisionResolution } from './decision-contracts';

type Params = Request & { params: { id: string } };
function decisionId(req: Params): string {
  // The daemon router retains escaped path segments (our typed IDs contain ':').
  try { return decodeURIComponent(req.params.id); }
  catch { throw new DecisionError('Invalid decision ID encoding'); }
}
async function body(req: Request): Promise<Record<string, unknown>> {
  if (!req.body) throw new DecisionError('A request body is required');
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 48_000) { await reader.cancel(); throw new DecisionError('Request is too large', 413); }
      chunks.push(next.value);
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch (e) { if (e instanceof DecisionError) throw e; throw new DecisionError('Expected a JSON object'); }
  finally { reader.releaseLock(); }
}
export function createDecisionRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: DecisionQueue) {
  const wrap = <R extends Request = Request>(fn: (req: R) => unknown | Promise<unknown>) => async (req: R): Promise<Response> => {
    let response: Response;
    try {
      if (!provider || !capabilities.hasProvider('decisions', provider)) throw new DecisionError('Decisions are unsupported', 501, 'unsupported');
      if (!capabilities.snapshot().capabilities.decisions.enabled) throw new DecisionError('Decisions are unavailable or disabled', 503, 'unavailable');
      response = json(await fn(req));
    } catch (e) {
      response = e instanceof DecisionError ? json({ error: e.message, code: e.code }, e.status)
        : json({ error: 'Decision outcome is unavailable; reconcile by ID before retrying', code: 'unavailable' }, 503);
    }
    response.headers.set('Cache-Control', 'no-store'); return response;
  };
  const base = '/api/brief/decisions';
  return {
    [base]: { GET: wrap(req => {
      const params = new URL(req.url).searchParams;
      if ([...params.keys()].some(k => !['cursor','limit','runId'].includes(k)) || [...params.keys()].some(k => params.getAll(k).length > 1)) throw new DecisionError('Unknown or duplicate query field');
      return provider!.read({
        ...(params.has('cursor') ? { cursor: params.get('cursor')! } : {}),
        ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
        ...(params.has('runId') ? { runId: params.get('runId')! } : {}),
      });
    }) },
    [`${base}/:id`]: { GET: wrap<Params>(req => provider!.get(decisionId(req))) },
    [`${base}/:id/placement`]: { POST: wrap<Params>(async req => {
      const data = await body(req);
      if (Object.keys(data).some(k => !['revision','position'].includes(k)) || typeof data.revision !== 'string' || typeof data.position !== 'number') throw new DecisionError('Supply revision and position');
      return provider!.place(decisionId(req), data.revision, data.position);
    }) },
    [`${base}/:id/resolve`]: { POST: wrap<Params>(async req => provider!.resolve(decisionId(req), await body(req) as unknown as DecisionResolution)) },
  };
}
