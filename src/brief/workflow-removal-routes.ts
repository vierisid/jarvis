import type { BriefCapabilities } from './capabilities';
import { WorkflowRemovalError, type WorkflowRemoval } from './workflow-removal';

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
    '/api/brief/workflows/commands': { POST: wrap(async req => {
      if (!req.body) throw new WorkflowRemovalError('invalid_command');
      const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 4096) { await reader.cancel(); throw new WorkflowRemovalError('body_too_large', 413); }
          chunks.push(part.value);
        }
        let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new WorkflowRemovalError('invalid_command'); }
        return provider!.change(value);
      } finally { reader.releaseLock(); }
    }) },
  };
}
