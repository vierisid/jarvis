import type { BriefCapabilities } from './capabilities';
import type { GoalMeasurements } from './goal-measurements';
import { GoalMeasurementConflict } from '../goals/measurements';
import { GoalValidationError, text } from '../goals/validation';

type Params = Request & { params: { id: string } };
export function createGoalMeasurementRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: GoalMeasurements) {
  const wrap = (fn: (req: Params, id: string) => unknown | Promise<unknown>) => async (req: Params) => {
    let response: Response;
    try {
      if (!provider || !capabilities.hasProvider('goalMeasurements', provider)) response = json({ state: 'unsupported' }, 501);
      else if (!capabilities.snapshot().capabilities.goalMeasurements.enabled) response = json({ state: 'unavailable' }, 503);
      else {
        const id = text(decodeURIComponent(req.params.id), 'goalId', true, 512);
        response = json(await fn(req, id));
      }
    } catch (e) {
      response = e instanceof GoalValidationError ? json({ code: 'INVALID_GOAL_MEASUREMENT', error: e.message }, 400)
        : e instanceof GoalMeasurementConflict ? json({ code: 'MEASUREMENT_CONFLICT', error: e.message }, 409)
        : e instanceof SyntaxError || e instanceof URIError ? json({ code: 'INVALID_REQUEST' }, 400)
        : json({ state: 'unavailable', error: 'Measurement unavailable; recover the request receipt before retrying' }, 503);
    }
    response.headers.set('Cache-Control', 'no-store'); return response;
  };
  const base = '/api/brief/goals/:id';
  return {
    [base]: { GET: wrap((req, id) => {
      if (new URL(req.url).search) throw new GoalValidationError('query', 'is not supported');
      return provider!.read({ goalId: id });
    }) },
    [`${base}/measurement`]: {
      GET: wrap((req, id) => {
        const query = new URL(req.url).searchParams;
        if ([...query.keys()].some(k => k !== 'requestId') || query.getAll('requestId').length !== 1) throw new GoalValidationError('query', 'requires one requestId');
        return { receipt: provider!.receipt(id, query.get('requestId')!) };
      }),
      POST: wrap(async (req, id) => {
        if (new URL(req.url).search) throw new GoalValidationError('query', 'is not supported');
        if (!req.body) throw new GoalValidationError('request', 'a body is required');
        const reader = req.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
        try {
          while (true) {
            const next = await reader.read(); if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > 8192) { await reader.cancel(); throw new GoalValidationError('request', 'exceeds 8192 bytes'); }
            chunks.push(next.value);
          }
          let command: unknown;
          try { command = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
          catch { throw new GoalValidationError('request', 'must be valid UTF-8 JSON'); }
          return provider!.record(id, command);
        } finally { reader.releaseLock(); }
      }),
    },
  };
}
