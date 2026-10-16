import type { BriefCapabilities } from './capabilities';
import { WorkflowInspectionError } from './inspection-values';
import type { WorkflowContext } from './workflow-context';

type Params = Request & { params?: { flowId?: string; runId?: string; requestId?: string } };
export function requireWorkflowContext(capabilities?: BriefCapabilities, provider?: WorkflowContext): WorkflowContext {
  if (!provider || !capabilities?.hasProvider('workflowContext', provider)) throw new WorkflowInspectionError('unsupported', 501);
  if (!capabilities.snapshot().capabilities.workflowContext.enabled) throw new WorkflowInspectionError('unavailable', 503);
  return provider;
}
export function createWorkflowContextRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: WorkflowContext) {
  const wrap = (keys: string[], fn: (p: WorkflowContext, req: Params, query: URLSearchParams) => unknown) => (req: Params) => {
    let response: Response;
    try {
      const p = requireWorkflowContext(capabilities, provider), query = new URL(req.url).searchParams;
      if ([...query.keys()].some(k => !keys.includes(k) || query.getAll(k).length !== 1)) throw new WorkflowInspectionError('invalid_query');
      response = json(fn(p, req, query));
    } catch (e) {
      response = e instanceof WorkflowInspectionError ? json({ code: e.code }, e.status) : json({ code: 'unavailable' }, 503);
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  };
  return {
    '/api/brief/workflows/:flowId/inspection': { GET: wrap(['versionId','runId'], (p, req, q) =>
      ({ status: 'ready', data: p.selection(req.params?.flowId ?? '', q.get('versionId') ?? '', q.get('runId')) })) },
    '/api/brief/workflows/:flowId/runs': { GET: wrap(['cursor'], (p, req, q) => p.list(req.params?.flowId ?? '', q.get('cursor'))) },
    '/api/brief/workflows/:flowId/runs/:runId': { GET: wrap([], (p, req) =>
      ({ status: 'ready', data: p.detail(req.params?.flowId ?? '', req.params?.runId ?? '') })) },
    '/api/brief/workflows/:flowId/run-requests/:requestId': { GET: wrap([], (p, req) =>
      p.request(req.params?.flowId ?? '', req.params?.requestId ?? '')) },
  };
}
