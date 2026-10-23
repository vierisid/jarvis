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
  /** A bounded JSON command body: 8 KiB, valid UTF-8, no query string. */
  const command = async (req: Params): Promise<unknown> => {
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
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new GoalValidationError('request', 'must be valid UTF-8 JSON'); }
    } finally { reader.releaseLock(); }
  };
  /** The one `requestId` a receipt recovery names. */
  const requestId = (req: Params): string => {
    const query = new URL(req.url).searchParams;
    if ([...query.keys()].some(k => k !== 'requestId') || query.getAll('requestId').length !== 1) throw new GoalValidationError('query', 'requires one requestId');
    return query.get('requestId')!;
  };
  const base = '/api/brief/goals/:id';
  return {
    '/api/brief/goals': { GET: async (req: Request) => {
      let response: Response;
      if (!provider || !capabilities.hasProvider('goalMeasurements', provider)) response = json({ state: 'unsupported' }, 501);
      else if (!capabilities.snapshot().capabilities.goalMeasurements.enabled) response = json({ state: 'unavailable' }, 503);
      else if (new URL(req.url).search) response = json({ state: 'unavailable', code: 'invalid_query' }, 400);
      else { try { response = json(provider.list()); } catch { response = json({ state: 'unavailable' }, 503); } }
      response.headers.set('Cache-Control', 'no-store'); return response;
    } },
    '/api/brief/initial-goal': { GET: async (req: Request) => {
      let response: Response;
      if (!provider || !capabilities.hasProvider('goalMeasurements', provider)) response = json({ state: 'unsupported' }, 501);
      else if (!capabilities.snapshot().capabilities.goalMeasurements.enabled) response = json({ state: 'unavailable' }, 503);
      else if (new URL(req.url).search) response = json({ state: 'unavailable', code: 'invalid_query' }, 400);
      else { try { response = json(provider.initialGoal()); } catch { response = json({ state: 'unavailable' }, 503); } }
      response.headers.set('Cache-Control', 'no-store'); return response;
    } },
    [base]: { GET: wrap((req, id) => {
      if (new URL(req.url).search) throw new GoalValidationError('query', 'is not supported');
      return provider!.read({ goalId: id });
    }) },
    [`${base}/measurement`]: {
      GET: wrap((req, id) => ({ receipt: provider!.receipt(id, requestId(req)) })),
      POST: wrap(async (req, id) => provider!.record(id, await command(req))),
    },
    // Q-17: a goal counted from cited entries. The definition's receipt is
    // recovered like any measurement's, through GET .../measurement.
    [`${base}/measurement/counted`]: {
      POST: wrap(async (req, id) => provider!.defineCounted(id, await command(req))),
    },
    [`${base}/observations`]: {
      GET: wrap((req, id) => new URL(req.url).search ? { receipt: provider!.observationReceipt(id, requestId(req)) } : provider!.observations(id)),
      POST: wrap(async (req, id) => provider!.recordObservation(id, await command(req))),
    },
  };
}
