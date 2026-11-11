import type { BriefCapabilities } from './capabilities';
import { awarenessHistoryHidden } from '../awareness/history-guard.ts';
import { PreparedRequestError, type PreparedOpportunities } from '../awareness/prepared-opportunities';

type Params = Request & { params: { id: string } };
async function field(req: Request, name: 'opportunityId' | 'revision'): Promise<string> {
  if (!req.body) throw new PreparedRequestError('A request body is required');
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 2048) { await reader.cancel(); throw new PreparedRequestError('Request is too large', 413); }
      chunks.push(next.value);
    }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!data || Array.isArray(data) || Object.keys(data).length !== 1 || typeof data[name] !== 'string' || !data[name].trim() || data[name].length > 256) throw Error();
    return data[name];
  } catch (e) { if (e instanceof PreparedRequestError) throw e; throw new PreparedRequestError(`Supply only ${name}`); }
  finally { reader.releaseLock(); }
}
export function createPreparedOpportunityRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: PreparedOpportunities) {
  const wrap = <R extends Request = Request>(fn: (req: R) => unknown | Promise<unknown>, status = 200) => async (req: R): Promise<Response> => {
    let response: Response;
    try {
      if (!provider || !capabilities.hasProvider('preparedOpportunities', provider)) throw new PreparedRequestError('Prepared opportunities are unsupported', 501);
      if (!capabilities.snapshot().capabilities.preparedOpportunities.enabled) throw new PreparedRequestError('Prepared opportunities are unavailable or disabled', 503);
      response = json(await fn(req), status);
    } catch (e) { response = e instanceof PreparedRequestError ? json({ error: e.message }, e.status) : json({ error: 'Prepared opportunities are unavailable' }, 503); }
    response.headers.set('Cache-Control', 'no-store'); return response;
  };
  // Prepared opportunities cite recorded captures: hidden while awareness is off (#1314), and so are the
  // writes, which answer with the view they changed (#1314 review).
  const hiddenWhenOff = <R extends Request>(read: (req: R) => Promise<Response>) => async (req: R): Promise<Response> => {
    const hidden = awarenessHistoryHidden(json);
    if (hidden) { hidden.headers.set('Cache-Control', 'no-store'); return hidden; }
    return read(req);
  };
  const base = '/api/brief/prepared-opportunities';
  return {
    [base]: { GET: hiddenWhenOff(wrap(req => { const url = new URL(req.url); return provider!.read({
      ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
    }); })), POST: hiddenWhenOff(wrap(async req => provider!.ensure(await field(req, 'opportunityId')), 202)) },
    [`${base}/:id`]: { GET: hiddenWhenOff(wrap<Params>(req => provider!.get(req.params.id))) },
    [`${base}/:id/dismiss`]: { POST: hiddenWhenOff(wrap<Params>(async req => provider!.dismiss(req.params.id, await field(req, 'revision')))) },
    [`${base}/:id/retry`]: { POST: hiddenWhenOff(wrap<Params>(async req => provider!.retry(req.params.id, await field(req, 'revision')), 202)) },
  };
}
