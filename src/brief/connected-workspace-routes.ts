import type { BriefCapabilities } from './capabilities';
import type { ConnectedWorkspace } from './connected-workspace';
export function createConnectedWorkspaceRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: ConnectedWorkspace) {
  return { '/api/brief/connections': { GET: (req: Request) => {
    let response: Response;
    try {
      if (!provider || !capabilities.hasProvider('connections', provider)) response = json({ status: 'unsupported', code: 'provider_missing' }, 501);
      else if (!capabilities.snapshot().capabilities.connections.enabled) response = json({ status: 'unavailable', code: 'disabled' }, 503);
      else if (new URL(req.url).search) response = json({ code: 'invalid_query' }, 400);
      else response = json({ status: 'ready', data: provider.read() });
    } catch { response = json({ status: 'unavailable', code: 'source_unavailable' }, 503); }
    response.headers.set('Cache-Control', 'no-store'); response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  } } };
}
