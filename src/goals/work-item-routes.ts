import {
  checkWorkResult, configureWorkItem, createWorkItem, decideWorkItem,
  getWorkItem, listWorkItems, setWorkBlocker, WorkItemError,
} from './work-items.ts';

type Handler = (req: Request) => Response | Promise<Response>;
function route(action: (req: Request) => unknown | Promise<unknown>, status = 200): Handler {
  return async req => {
    try { return Response.json(await action(req), { status }); }
    catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, {
        status: e instanceof WorkItemError ? e.status : e instanceof SyntaxError ? 400 : 500,
      });
    }
  };
}
function id(req: Request): string { return decodeURIComponent(new URL(req.url).pathname.split('/')[3]!); }

/** Auth is supplied by the daemon's existing /api boundary, like goals/commitments. */
export function createWorkItemRoutes(): Record<string, { GET?: Handler; POST?: Handler; PATCH?: Handler }> {
  return {
    '/api/work-items': {
      GET: route(req => {
        const p = new URL(req.url).searchParams;
        return listWorkItems({ planId: p.get('planId') ?? undefined, goalId: p.get('goalId') ?? undefined, today: p.get('today') === 'true' });
      }),
      POST: route(async req => createWorkItem(await req.json()), 201),
    },
    '/api/work-items/:id': {
      GET: route(req => getWorkItem(id(req))),
      PATCH: route(async req => configureWorkItem(id(req), await req.json())),
    },
    '/api/work-items/:id/decision': { POST: route(async req => decideWorkItem(id(req), await req.json())) },
    '/api/work-items/:id/blocker': { POST: route(async req => setWorkBlocker(id(req), await req.json())) },
    '/api/work-items/:id/result': { POST: route(async req => checkWorkResult(id(req), await req.json())) },
  };
}
