import { getDb } from '../vault/schema';
import { correctFact, verifyFact, factText, FactInputError } from '../vault/facts';
import type { BriefCapabilities } from './capabilities';
import type { MemoryStream } from './memory-stream';
/** The existing fact writer, with the displayed Brief revision checked in the
 * same SQLite transaction. No second memory store or inferred confirmation. */
export function createMemoryDecisionRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: MemoryStream) {
  return { '/api/brief/memory/:id/decision': { POST: async (req: Request & { params?: { id?: string } }) => {
    const reply = (body: unknown, status = 200) => { const response = json(body, status); response.headers.set('Cache-Control', 'no-store'); return response; };
    try {
      if (!provider || !capabilities.hasProvider('memoryStream', provider)) return reply({ state: 'unsupported' }, 501);
      if (!capabilities.snapshot().capabilities.memoryStream.enabled || provider.readiness() !== 'ready') return reply({ state: 'unavailable' }, 503);
      if (new URL(req.url).search || !req.headers.get('content-type')?.startsWith('application/json')) return reply({ state: 'error' }, 400);
      if (!req.body) return reply({ state: 'error' }, 400);
      const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > 20000) { await reader.cancel(); return reply({ state: 'error' }, 413); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      req.signal.throwIfAborted();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const body = JSON.parse(text), id = decodeURIComponent(req.params?.id ?? '');
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['kind', 'revision', 'object', 'reason', 'confirmed'].includes(k))
        || !['correct', 'confirm'].includes(body.kind) || typeof body.revision !== 'string' || body.confirmed !== true) return reply({ state: 'error' }, 400);
      const reason = factText(body.reason, 'reason', 1000);
      return getDb().transaction(() => {
        if (!capabilities.snapshot().capabilities.memoryStream.enabled || provider.readiness() !== 'ready') return reply({ state: 'unavailable' }, 503);
        const fresh = provider.detail(id);
        if (fresh.state !== 'ready' || !fresh.data || !('revision' in fresh.data) || fresh.data.revision !== body.revision) return reply({ state: 'conflict', reason: 'This fact changed. Reload before saving.' }, 409);
        if (!fresh.data.permissions.canCorrect) return reply({ state: 'unavailable' }, 403);
        const result = body.kind === 'confirm' ? verifyFact(id, reason) : correctFact(id, factText(body.object, 'object'), reason);
        return reply({ state: 'saved', factId: result.id });
      }).immediate();
    } catch (e) { return reply({ state: 'error', reason: 'The memory change could not be confirmed.' }, e instanceof FactInputError ? e.status : 503); }
  } } };
}
