import type { BriefCapabilities } from './capabilities.ts';
import type { BriefConversationProvider } from './conversations.ts';
import { ConversationRequestError, type ConversationRepository } from '../vault/conversation-lifecycle.ts';

type RequestWithId = Request & { params: { id: string } };
function keys(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ConversationRequestError('Invalid request fields');
  }
  return value as Record<string, unknown>;
}
async function body(req: Request, allowed: string[]): Promise<Record<string, unknown>> {
  // Bound the bytes actually received, including chunked requests and forged lengths.
  if (!req.body) throw new ConversationRequestError('A JSON request body is required');
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new ConversationRequestError('Request body is too large', 413); }
      chunks.push(chunk.value);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ConversationRequestError('Invalid JSON'); }
    return keys(value, allowed);
  } finally { reader.releaseLock(); }
}
function page(req: Request, history = false) {
  const params = new URL(req.url).searchParams;
  const allowed = history ? ['limit', 'cursor', 'closed'] : ['limit', 'cursor'];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new ConversationRequestError('Invalid query fields');
  }
  const limit = params.get('limit'); const closed = params.get('closed');
  if (limit !== null && !/^[1-9][0-9]{0,2}$/.test(limit)) throw new ConversationRequestError('Invalid limit');
  if (closed !== null && closed !== 'true' && closed !== 'false') throw new ConversationRequestError('Invalid history filter');
  return { limit: limit === null ? undefined : Number(limit), cursor: params.get('cursor') ?? undefined, closed: closed === 'true' };
}

/** Mounted under the existing panel-session gate. Closing touches only tab metadata. */
export function createConversationRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: BriefConversationProvider) {
  const response = (body: unknown, status = 200): Response => {
    const result = json(body, status);
    result.headers.set('Cache-Control', 'no-store');
    return result;
  };
  const gated = <R extends Request>(operation: (req: R, repo: ConversationRepository) => Response | Promise<Response>) => async (req: R) => {
    if (!provider || !capabilities.hasProvider('conversations', provider)) return response({ state: 'unsupported' }, 501);
    const capability = capabilities.snapshot().capabilities.conversations;
    if (!capability.enabled) return response({ state: capability.state === 'loading' ? 'loading' : 'unavailable', reason: capability.reason }, 503);
    try { return await operation(req, provider.repository); }
    catch (error) {
      if (error instanceof ConversationRequestError) return response({ error: error.message }, error.status);
      return response({ state: 'unavailable', reason: 'provider_unavailable' }, 503);
    }
  };
  return {
    '/api/brief/conversations': {
      GET: gated((req, repo) => response(repo.list(page(req, true)))),
      POST: gated(async (req, repo) => {
        const data = await body(req, ['title']);
        if (data.title !== undefined && typeof data.title !== 'string') throw new ConversationRequestError('Invalid title');
        return response(repo.create({ title: data.title }), 201);
      }),
    },
    '/api/brief/conversations/tabs': {
      GET: gated((_req, repo) => response(repo.tabs())),
      PUT: gated(async (req, repo) => {
        const data = await body(req, ['order']);
        if (!Array.isArray(data.order) || data.order.some(id => typeof id !== 'string')) throw new ConversationRequestError('Invalid tab order');
        return response(repo.reorder(data.order));
      }),
    },
    '/api/brief/conversations/active': {
      PUT: gated(async (req, repo) => {
        const data = await body(req, ['conversationId']);
        if (data.conversationId !== null && typeof data.conversationId !== 'string') throw new ConversationRequestError('Invalid conversation ID');
        return response(repo.activate(data.conversationId));
      }),
    },
    '/api/brief/conversations/:id': {
      GET: gated<RequestWithId>((req, repo) => response(repo.get(req.params.id))),
      PATCH: gated<RequestWithId>(async (req, repo) => {
        const data = await body(req, ['title', 'revision']);
        if (typeof data.title !== 'string' || (data.revision !== undefined && typeof data.revision !== 'string')) throw new ConversationRequestError('Invalid title or revision');
        return response(repo.rename(req.params.id, data.title, data.revision));
      }),
    },
    '/api/brief/conversations/:id/tab': {
      PATCH: gated<RequestWithId>(async (req, repo) => {
        const data = await body(req, ['open']);
        if (typeof data.open !== 'boolean') throw new ConversationRequestError('Open must be a boolean');
        return response(repo.setOpen(req.params.id, data.open));
      }),
    },
    '/api/brief/conversations/:id/messages': {
      GET: gated<RequestWithId>((req, repo) => response(repo.messages(req.params.id, page(req)))),
    },
  };
}
