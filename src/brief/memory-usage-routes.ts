import type { BriefCapabilities } from './capabilities';
import { MemoryUsageError, type MemoryUsageLedger } from '../vault/memory-usage';

export function createMemoryUsageRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: MemoryUsageLedger) {
  return { '/api/brief/memory-usage': { GET: async (req: Request) => {
    let response: Response;
    try {
      if (!provider || !capabilities.hasProvider('memoryUsage', provider)) response = json({ state: 'unsupported' }, 501);
      else if (!capabilities.snapshot().capabilities.memoryUsage.enabled) response = json({ state: 'unavailable' }, 503);
      else {
        if (req.url.length > 1024) throw new MemoryUsageError('Query too long');
        const params = new URL(req.url).searchParams, query: Record<string, string> = {};
        for (const [key, value] of params) {
          if (!['conversationId', 'runId'].includes(key) || params.getAll(key).length !== 1 || !value.trim()) throw new MemoryUsageError('Invalid memory target');
          query[key] = value;
        }
        const result = provider.readTarget(query);
        response = json(result, result.state === 'unavailable' ? 503 : 200);
      }
    } catch (error) {
      response = error instanceof MemoryUsageError ? json({ code: 'INVALID_MEMORY_USAGE_QUERY' }, 400) : json({ state: 'unavailable' }, 503);
    }
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } } };
}
