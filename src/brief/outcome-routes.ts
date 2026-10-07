import type { BriefCapabilities } from './capabilities';
import type { Outcomes } from './outcomes';
import { GoalValidationError } from '../goals/validation';
import { OutcomeConflict, outcomeId } from './outcome-time';

type Params = Request & { params?: { id?: string } };
export function createOutcomeRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: Outcomes) {
  const wrap = (fn: (req: Params) => unknown | Promise<unknown>) => async (req: Params) => {
    let response: Response;
    try {
      if (!provider || !capabilities.hasProvider('outcomes', provider)) response = json({ state: 'unsupported' }, 501);
      else if (!capabilities.snapshot().capabilities.outcomes.enabled) response = json({ state: 'unavailable' }, 503);
      else response = json(await fn(req));
    } catch (e) {
      response = e instanceof GoalValidationError ? json({ code: 'INVALID_OUTCOME', error: e.message }, 400)
        : e instanceof OutcomeConflict ? json({ code: 'OUTCOME_CONFLICT', error: e.message }, 409)
        : e instanceof SyntaxError || e instanceof URIError ? json({ code: 'INVALID_REQUEST' }, 400)
        : json({ state: 'unavailable', error: 'Outcome evidence unavailable' }, 503);
    }
    response.headers.set('Cache-Control', 'no-store'); return response;
  };
  const query = (req: Request, names: string[], required = names) => {
    const q = new URL(req.url).searchParams;
    if ([...q.keys()].some(k => !names.includes(k) || q.getAll(k).length !== 1) || required.some(k => !q.get(k)?.trim())) throw new GoalValidationError('query', 'has missing, duplicate or unsupported parameters');
    return q;
  };
  const id = (req: Params) => decodeURIComponent(outcomeId(req.params?.id, 'workItemId'));
  return {
    '/api/brief/outcomes': { GET: wrap(req => {
      const q = query(req, ['start', 'end', 'timezone']);
      return provider!.read({ start: Number(q.get('start')), end: Number(q.get('end')), timezone: q.get('timezone')! });
    }) },
    '/api/brief/outcomes/summary': { GET: wrap(req => {
      const q = query(req, ['timezone', 'at'], ['timezone']);
      if (q.has('at') && !q.get('at')?.trim()) throw new GoalValidationError('at', 'must not be blank');
      return provider!.summary({ timezone: q.get('timezone')!, ...(q.has('at') ? { at: Number(q.get('at')) } : {}) });
    }) },
    '/api/brief/outcomes/:id/time': {
      GET: wrap(req => { const q = query(req, ['requestId']); return { receipt: provider!.timeReceipt(id(req), q.get('requestId')!) }; }),
      POST: wrap(async req => {
        query(req, []); if (!req.body) throw new GoalValidationError('request', 'requires a body');
        const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) { const next = await reader.read(); if (next.done) break;
            size += next.value.byteLength; if (size > 32768) { await reader.cancel(); throw new GoalValidationError('request', 'exceeds 32768 bytes'); }
            chunks.push(next.value);
          }
          let command: unknown;
          try { command = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
          catch { throw new GoalValidationError('request', 'must be valid UTF-8 JSON'); }
          return provider!.recordTime(id(req), command);
        } finally { reader.releaseLock(); }
      }),
    },
  };
}
