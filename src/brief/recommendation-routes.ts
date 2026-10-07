import type { BriefCapabilities } from './capabilities';
import { RecommendationError, type Recommendations } from './recommendations';
import { DecisionError } from './decisions';
type Params = Request & { params: { id: string } };
function recommendationId(req: Params): string {
  try { return decodeURIComponent(req.params.id); }
  catch { throw new RecommendationError('Invalid recommendation ID encoding'); }
}
async function body(req: Request): Promise<Record<string, unknown>> {
  if (!req.body) throw new RecommendationError('A request body is required');
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 8_000) { await reader.cancel(); throw new RecommendationError('Request is too large', 413); }
      chunks.push(next.value);
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch (e) { if (e instanceof RecommendationError) throw e; throw new RecommendationError('Expected a JSON object'); }
  finally { reader.releaseLock(); }
}
export function createRecommendationRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: Recommendations) {
  const wrap = <R extends Request = Request>(fn: (req: R) => unknown | Promise<unknown>) => async (req: R): Promise<Response> => {
    let response: Response;
    try {
      if (!provider || !capabilities.hasProvider('recommendations', provider)) throw new RecommendationError('Recommendations are unsupported', 501, 'unsupported');
      if (!capabilities.snapshot().capabilities.recommendations.enabled) throw new RecommendationError('Recommendations are unavailable or disabled', 503, 'unavailable');
      response = json(await fn(req));
    } catch (e) {
      response = e instanceof RecommendationError || e instanceof DecisionError ? json({ error: e.message, code: e.code }, e.status)
        : json({ error: 'Recommendation outcome is unavailable; read by ID before retrying', code: 'unavailable' }, 503);
    }
    response.headers.set('Cache-Control', 'no-store'); return response;
  };
  const input = async (req: Request, fields: string[]) => {
    const value = await body(req);
    if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => typeof value[key] !== 'string')) throw new RecommendationError('Invalid request fields');
    return value as Record<string, string>;
  };
  const base = '/api/brief/recommendations';
  return {
    [base]: {
      GET: wrap(req => {
        const params = new URL(req.url).searchParams;
        if ([...params.keys()].some(k => k !== 'requestId') || params.getAll('requestId').length > 1) throw new RecommendationError('Unknown or duplicate query field');
        return provider!.read(params.get('requestId') ?? undefined);
      }),
      POST: wrap(async req => provider!.generate((await input(req, ['requestId'])).requestId!)),
    },
    [`${base}/:id`]: { GET: wrap<Params>(req => provider!.get(recommendationId(req))) },
    [`${base}/:id/accept`]: { POST: wrap<Params>(async req => {
      const data = await input(req, ['requestId','revision']);
      return provider!.accept(recommendationId(req), data.requestId!, data.revision!);
    }) },
    [`${base}/:id/dismiss`]: { POST: wrap<Params>(async req => provider!.dismiss(recommendationId(req), (await input(req, ['revision'])).revision!)) },
  };
}
