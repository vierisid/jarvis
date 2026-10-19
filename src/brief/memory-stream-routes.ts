import type { BriefCapabilities } from './capabilities';
import { MemoryQueryError, type MemoryStream } from './memory-stream';
import type { MemoryStreamQuery } from './memory-stream-contracts';

type RequestWithId = Request & { params?: { id?: string } };
export function createMemoryStreamRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: MemoryStream) {
  const wrap = (fn: (req: RequestWithId) => unknown | Promise<unknown>) => async (req: RequestWithId) => {
    let response: Response;
    try {
      if (!provider || !capabilities.hasProvider('memoryStream', provider)) response = json({ state: 'unsupported' }, 501);
      else if (!capabilities.snapshot().capabilities.memoryStream.enabled || !provider.usage || !capabilities.hasProvider('memoryUsage', provider.usage)) response = json({ state: 'unavailable' }, 503);
      else {
        const result = await fn(req) as { state: string };
        response = json(result, result.state === 'unavailable' ? 503 : result.state === 'stale' ? 409 : result.state === 'not_found' ? 404 : 200);
      }
    } catch (e) {
      response = e instanceof MemoryQueryError || e instanceof URIError ? json({ code: 'INVALID_MEMORY_QUERY' }, 400)
        : json({ state: 'unavailable' }, 503);
    }
    response.headers.set('Cache-Control', 'no-store'); return response;
  };
  const parse = (req: Request, detail = false) => {
    if (req.url.length > 8192) throw new MemoryQueryError('Query too long');
    const params = new URL(req.url).searchParams, query: Record<string, string | number> = {};
    for (const [key, value] of params) {
      if (detail || !['q', 'source', 'usedIn', 'updatedFrom', 'updatedBefore', 'cursor', 'limit'].includes(key)
        || params.getAll(key).length !== 1 || !value.trim()) throw new MemoryQueryError('Invalid query');
      if (['updatedFrom', 'updatedBefore', 'limit'].includes(key)) {
        if (!/^-?[0-9]+$/.test(value)) throw new MemoryQueryError('Invalid number');
        query[key] = Number(value);
      } else query[key] = value;
    }
    return query as MemoryStreamQuery;
  };
  return {
    '/api/brief/memory': { GET: wrap(req => provider!.read(parse(req))) },
    '/api/brief/memory/:id': { GET: wrap(req => { parse(req, true); return provider!.detail(decodeURIComponent(req.params?.id ?? '')); }) },
    '/api/brief/memory/:id/history': { GET: wrap(req => { parse(req, true); return provider!.detail(decodeURIComponent(req.params?.id ?? ''), true); }) },
  };
}
