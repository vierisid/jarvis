import type { BriefCapabilities } from './capabilities';
import { MemoryForgetError, type MemoryForget } from './memory-forget';

type Params = Request & { params?: { id?: string } };
export function createMemoryForgetRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: MemoryForget) {
  const wrap = (fn: (req: Params, id: string) => unknown | Promise<unknown>) => async (req: Params) => {
    let response: Response;
    try {
      if (!provider || !capabilities.hasProvider('memoryForget', provider)) throw new MemoryForgetError('unsupported', 501);
      if (!capabilities.snapshot().capabilities.memoryForget.enabled) throw new MemoryForgetError('unavailable', 503);
      if (new URL(req.url).search) throw new MemoryForgetError('unexpected_query');
      let id: string; try { id = decodeURIComponent(req.params?.id ?? ''); } catch { throw new MemoryForgetError('invalid_fact_id'); }
      response = json(await fn(req, id));
    } catch (e) {
      response = e instanceof MemoryForgetError ? json({ code: e.code }, e.status) : json({ code: 'unavailable' }, 503);
    }
    response.headers.set('Cache-Control', 'no-store'); return response;
  };
  return { '/api/brief/memory/:id/forget': {
    GET: wrap((_req, id) => provider!.get(id)),
    POST: wrap(async (req, id) => {
      if (!req.body) throw new MemoryForgetError('invalid_forget_command');
      const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 2048) { await reader.cancel(); throw new MemoryForgetError('body_too_large', 413); }
          chunks.push(part.value);
        }
        let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new MemoryForgetError('invalid_forget_command'); }
        return provider!.forget(id, value);
      } finally { reader.releaseLock(); }
    }),
  } };
}
