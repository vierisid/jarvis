import {
  checkWorkResult, configureWorkItem, createWorkItem, decideWorkItem,
  getWorkItem, listWorkItems, setWorkBlocker, WorkItemError,
} from './work-items.ts';

type WorkRequest = Request & { params: { id: string } };
type Handler = (req: WorkRequest) => Promise<Response>;

/**
 * Auth, CORS and the error shape are the daemon's, like goals/commitments:
 * `json` is the same helper every other /api route answers through. Only a
 * WorkItemError carries its message outward; anything else is logged and
 * reported generically so internals do not reach the client.
 */
export function createWorkItemRoutes(
  json: (data: unknown, status?: number) => Response,
): Record<string, { GET?: Handler; POST?: Handler; PATCH?: Handler }> {
  const route = (action: (req: WorkRequest) => unknown | Promise<unknown>, status = 200): Handler =>
    async req => {
      try { return json(await action(req), status); }
      catch (err) {
        if (err instanceof WorkItemError) return json({ error: err.message }, err.status);
        if (err instanceof SyntaxError) return json({ error: 'Invalid JSON' }, 400);
        console.error('[WorkItems] Request failed:', err);
        return json({ error: 'Work item request failed' }, 500);
      }
    };
  return {
    '/api/work-items': {
      GET: route(req => {
        const p = new URL(req.url).searchParams;
        return listWorkItems({ planId: p.get('planId') ?? undefined, goalId: p.get('goalId') ?? undefined, today: p.get('today') === 'true' });
      }),
      POST: route(async req => createWorkItem(await req.json()), 201),
    },
    '/api/work-items/:id': {
      GET: route(req => getWorkItem(req.params.id)),
      PATCH: route(async req => configureWorkItem(req.params.id, await req.json())),
    },
    '/api/work-items/:id/decision': { POST: route(async req => decideWorkItem(req.params.id, await req.json())) },
    '/api/work-items/:id/blocker': { POST: route(async req => setWorkBlocker(req.params.id, await req.json())) },
    '/api/work-items/:id/result': { POST: route(async req => checkWorkResult(req.params.id, await req.json())) },
  };
}
