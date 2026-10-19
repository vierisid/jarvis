import type { BriefCapabilities } from './capabilities';
import { DecisionError } from './decisions';
import type { DecisionDocuments, DocumentCommand } from './decision-documents';
type Params = Request & { params: { id: string } };
export function createDecisionDocumentRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: DecisionDocuments) {
  const wrap = (fn: (req: Params, id: string) => unknown | Promise<unknown>) => async (req: Params): Promise<Response> => {
    let response: Response;
    try {
      if (!provider || !capabilities.hasProvider('decisionEdits', provider)) throw new DecisionError('Document reviews are unsupported', 501, 'unsupported');
      if (!capabilities.snapshot().capabilities.decisionEdits.enabled) throw new DecisionError('Document reviews are disabled or unavailable', 503, 'unavailable');
      let id: string; try { id = decodeURIComponent(req.params.id); } catch { throw new DecisionError('Invalid decision ID encoding'); }
      response = json(await fn(req, id));
    } catch (e) {
      response = e instanceof DecisionError ? json({ error: e.message, code: e.code }, e.status)
        : json({ error: 'Document outcome unavailable; recover by request ID before retrying', code: 'unavailable' }, 503);
    }
    response.headers.set('Cache-Control', 'no-store'); return response;
  };
  const base = '/api/brief/decisions/:id/document';
  return { [base]: {
    GET: wrap((req, id) => {
      const params = new URL(req.url).searchParams;
      if ([...params.keys()].some(k => k !== 'requestId') || params.getAll('requestId').length > 1) throw new DecisionError('Unknown or duplicate query field');
      return params.has('requestId') ? { receipt: provider!.receipt(id, params.get('requestId')!) } : provider!.get(id);
    }),
    POST: wrap(async (req, id) => {
      if (new URL(req.url).search) throw new DecisionError('Unexpected query fields');
      if (!req.body) throw new DecisionError('A request body is required');
      const reader = req.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 128_000) { await reader.cancel(); throw new DecisionError('Request is too large', 413); }
          chunks.push(next.value);
        }
        let value: DocumentCommand;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new DecisionError('Expected a JSON object'); }
        return provider!.act(id, value);
      } finally { reader.releaseLock(); }
    }),
  } };
}
