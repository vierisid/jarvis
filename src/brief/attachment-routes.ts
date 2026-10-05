import type { BriefCapabilities } from './capabilities';
import type { BriefAttachmentProvider } from './attachments';
import { ATTACHMENT_LIMITS as limits } from './attachment-contracts';
import { ConversationRequestError } from '../vault/conversation-lifecycle';

type AttachmentRequest = Request & { params: { id: string; attachmentId: string } };
async function readBytes(req: Request, limit: number) {
  if (!req.body) throw new ConversationRequestError('A request body is required');
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ConversationRequestError('Attachment exceeds its size limit', 413); }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } finally { reader.releaseLock(); }
}

/** Uses the daemon's existing authenticated /api gate. No download URL or filesystem path. */
export function createAttachmentRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: BriefAttachmentProvider) {
  let uploads = 0;
  const response = (body: unknown, status = 200) => {
    const result = json(body, status); result.headers.set('Cache-Control', 'no-store'); return result;
  };
  const gated = (operation: (req: AttachmentRequest, provider: BriefAttachmentProvider) => unknown | Promise<unknown>, upload = false) => async (req: AttachmentRequest) => {
    if (!provider || !capabilities.hasProvider('chatAttachments', provider)) return response({ error: 'Attachments are unsupported' }, 501);
    if (!capabilities.snapshot().capabilities.chatAttachments.enabled) return response({ error: 'Attachments are not enabled' }, 503);
    if (upload && uploads >= 4) return response({ error: 'Attachment upload is busy; retry shortly' }, 409);
    if (upload) uploads++;
    try {
      provider.repository.conversations.get(req.params.id);
      return response(await operation(req, provider));
    } catch (error) {
      if (error instanceof ConversationRequestError) return response({ error: error.message }, error.status);
      return response({ error: 'Attachment service is unavailable' }, 503);
    } finally { if (upload) uploads--; }
  };
  return {
    '/api/brief/conversations/:id/attachments/:attachmentId': {
      GET: gated((req, p) => {
        const ref = p.repository.find(req.params.id, req.params.attachmentId);
        if (!ref) throw new ConversationRequestError('Attachment not found', 404);
        return ref;
      }),
      PUT: gated(async (req, p) => {
        const kind = req.headers.get('X-Attachment-Kind');
        if (kind !== 'document' && kind !== 'image') throw new ConversationRequestError('Choose Document or Image for upload');
        let name: string;
        try { name = decodeURIComponent(req.headers.get('X-Attachment-Name') ?? ''); }
        catch { throw new ConversationRequestError('Invalid filename'); }
        const mediaType = (req.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
        return p.upload(req.params.id, req.params.attachmentId, kind, name, mediaType,
          await readBytes(req, kind === 'document' ? limits.documentBytes : limits.fileBytes));
      }, true),
      DELETE: gated((req, p) => p.repository.remove(req.params.id, req.params.attachmentId)),
    },
    '/api/brief/conversations/:id/attachments/:attachmentId/capture': {
      POST: gated(async (req, p) => {
        let value: unknown;
        try { value = JSON.parse((await readBytes(req, 1024)).toString('utf8')); }
        catch (error) { if (error instanceof ConversationRequestError) throw error; throw new ConversationRequestError('Invalid capture request'); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['deviceId', 'confirm'].includes(k))) throw new ConversationRequestError('Invalid capture fields');
        const data = value as { deviceId: string; confirm: boolean };
        return p.capture(req.params.id, req.params.attachmentId, data.deviceId, data.confirm);
      }, true),
    },
  };
}
