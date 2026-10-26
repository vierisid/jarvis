import type { BriefCapabilities } from './capabilities';
import { WorkflowRemovalError, type WorkflowRemoval } from './workflow-removal';
import { panelSessionDevice } from '../comms/panel-session-marker';

type Params = Request & { params?: { requestId?: string } };
export function createWorkflowRemovalRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: WorkflowRemoval) {
  const wrap = (fn: (req: Params) => unknown | Promise<unknown>) => async (req: Params) => {
    let response: Response;
    try {
      if (!provider || !capabilities.hasProvider('workflowRemoval', provider)) throw new WorkflowRemovalError('unsupported', 501);
      if (!capabilities.snapshot().capabilities.workflowRemoval.enabled) throw new WorkflowRemovalError('unavailable', 503);
      if (new URL(req.url).search) throw new WorkflowRemovalError('unexpected_query');
      response = json(await fn(req));
    } catch (error) {
      response = error instanceof WorkflowRemovalError ? json({ code: error.code }, error.status) : json({ code: 'unavailable' }, 503);
    }
    response.headers.set('Cache-Control', 'no-store'); return response;
  };
  return {
    '/api/brief/workflows': { GET: wrap(() => provider!.read()) },
    '/api/brief/workflows/requests/:requestId': { GET: wrap(req => {
      let requestId: string; try { requestId = decodeURIComponent(req.params?.requestId ?? ''); } catch { throw new WorkflowRemovalError('invalid_request_id'); }
      return provider!.request(requestId);
    }) },
    '/api/brief/workflows/commands': { POST: wrap(async req => provider!.change(await readCommand(req))) },
    // #1096: the person's purge. Same session, size, scope and request-id rules
    // as /commands; never reachable from manage_workflow or an agent tool.
    // A live panel session is required even under auth.insecure_open_access,
    // and a JSON content type, so a simple cross-origin form post cannot send it.
    '/api/brief/workflows/purges': { POST: wrap(async req => {
      const device = panelSessionDevice(req);
      if (!device) throw new WorkflowRemovalError('session_required', 403);
      if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) throw new WorkflowRemovalError('json_required', 415);
      return provider!.purge(await readCommand(req), `dashboard:${device}`);
    }) },
  };
}

async function readCommand(req: Request): Promise<unknown> {
  if (!req.body) throw new WorkflowRemovalError('invalid_command');
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new WorkflowRemovalError('body_too_large', 413); }
      chunks.push(part.value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new WorkflowRemovalError('invalid_command'); }
  } finally { reader.releaseLock(); }
}
