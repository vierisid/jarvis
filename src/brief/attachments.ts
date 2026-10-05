import type { Database } from 'bun:sqlite';
import type { SidecarManager } from '../sidecar/manager';
import { getDb } from '../vault/schema';
import { ChatAttachmentRepository, attachmentId } from '../vault/chat-attachments';
import { ConversationRequestError } from '../vault/conversation-lifecycle';
import { ATTACHMENT_LIMITS as limits, type BriefAttachmentKind, type BriefAttachmentRef } from './attachment-contracts';

const documents = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf']);
const images = new Set(['image/png', 'image/jpeg']);
let decoding = 0;
/** A deadline isolates CPU-heavy decoders from the daemon's event loop. */
export async function decodeAttachment(bytes: Uint8Array, mediaType: string): Promise<string | null> {
  if (decoding >= 2) throw new ConversationRequestError('Attachment processing is busy; retry shortly', 409);
  decoding++;
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL('./attachment-decoder-worker.ts', import.meta.url));
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ConversationRequestError('Attachment processing timed out', 409)), 5_000);
      worker!.onmessage = event => {
        clearTimeout(timer);
        if (event.data?.ok === true) resolve(event.data.text);
        else reject(new ConversationRequestError('Malformed or unsupported file content; use UTF-8 text, a text PDF, PNG, or JPEG'));
      };
      worker!.onerror = event => { event.preventDefault(); clearTimeout(timer); reject(new ConversationRequestError('Attachment could not be decoded')); };
      worker!.postMessage({ bytes, mediaType });
    });
  } finally { worker?.terminate(); decoding--; }
}

/** Capture uses the already connected native sidecar and its existing permission checks. */
export class BriefAttachmentProvider {
  readonly repository: ChatAttachmentRepository;
  private captures = new Map<string, { deviceId: string; result: Promise<BriefAttachmentRef> }>();
  constructor(private readonly db: Database, private readonly sidecar?: Pick<SidecarManager, 'getSidecar' | 'dispatchRPC'>, workspaceId?: string) {
    this.repository = new ChatAttachmentRepository(db, workspaceId);
  }
  readiness(): 'ready' | 'unavailable' { try { return getDb() === this.db ? 'ready' : 'unavailable'; } catch { return 'unavailable'; } }
  async upload(conversationId: string, id: string, kind: BriefAttachmentKind, name: string, mediaType: string, bytes: Uint8Array) {
    this.repository.requireOpen(conversationId); attachmentId(id);
    if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\x00-\x1f\x7f/\\]/.test(name)) throw new ConversationRequestError('Use a filename of 1 to 160 characters without paths');
    const types = kind === 'document' ? documents : images;
    if (!['document', 'image', 'screenshot'].includes(kind) || !types.has(mediaType)) throw new ConversationRequestError('Unsupported attachment type; use a document, PNG, or JPEG');
    if (!bytes.byteLength || bytes.byteLength > (kind === 'document' ? limits.documentBytes : limits.fileBytes)) throw new ConversationRequestError('Attachment is empty or exceeds its size limit', 413);
    // Check ownership/tombstones before spending time on a decoder, then again in save.
    const prior = this.repository.find(conversationId, id);
    if (prior && !['ready', 'accepted'].includes(prior.state)) throw new ConversationRequestError('Attachment was removed or expired; choose it again', 409);
    const text = await decodeAttachment(bytes, mediaType);
    return this.repository.save({ attachmentId: id, conversationId, kind, name, mediaType, bytes, text });
  }
  async capture(conversationId: string, id: string, deviceId: string, confirm: boolean) {
    this.repository.requireOpen(conversationId); attachmentId(id); attachmentId(deviceId);
    if (confirm !== true) throw new ConversationRequestError('Confirm the selected device before capturing');
    const prior = this.repository.find(conversationId, id);
    if (prior) {
      const device = this.db.query<{ device: string | null }, [string]>('SELECT source_device_id AS device FROM brief_chat_attachments WHERE attachment_id = ?').get(id)?.device;
      if (prior.kind !== 'screenshot' || device !== deviceId || !['ready', 'accepted'].includes(prior.state) || prior.expiresAt <= Date.now()) throw new ConversationRequestError('Capture identity already used; start a new capture', 409);
      return prior;
    }
    const key = `${conversationId}:${id}`, pending = this.captures.get(key);
    if (pending) {
      if (pending.deviceId !== deviceId) throw new ConversationRequestError('Capture identity already used for another device', 409);
      return pending.result;
    }
    if (this.captures.size >= 2) throw new ConversationRequestError('Capture is busy; retry shortly', 409);
    const result = this.captureOnce(conversationId, id, deviceId);
    this.captures.set(key, { deviceId, result });
    try { return await result; } finally { this.captures.delete(key); }
  }
  private async captureOnce(conversationId: string, id: string, deviceId: string) {
    const device = this.sidecar?.getSidecar(deviceId);
    if (!device?.connected || device.status === 'revoked' || !device.capabilities?.includes('screenshot') || device.unavailable_capabilities?.some(c => c.name === 'screenshot')) {
      throw new ConversationRequestError('Screenshot capture is unavailable on the selected device', 409);
    }
    let result: unknown;
    try { result = await this.sidecar!.dispatchRPC(deviceId, 'capture_screen', { compact: true, max_width: 1600, jpeg_quality: 80 }, { initial: 5_000, max: 5_000 }); }
    catch { throw new ConversationRequestError('Screenshot capture failed or permission was denied; check the selected device', 409); }
    const binary = (result as { _binary?: { data?: unknown; mime_type?: unknown } })?._binary;
    if (!binary || typeof binary.data !== 'string' || binary.data.length > Math.ceil(limits.fileBytes / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(binary.data)
      || typeof binary.mime_type !== 'string' || !images.has(binary.mime_type)) throw new ConversationRequestError('The selected device returned an invalid screenshot');
    const bytes = Buffer.from(binary.data, 'base64');
    if (!bytes.length || bytes.length > limits.fileBytes) throw new ConversationRequestError('Screenshot exceeds its size limit', 413);
    const text = await decodeAttachment(bytes, binary.mime_type);
    return this.repository.save({ attachmentId: id, conversationId, kind: 'screenshot', name: `Screenshot.${binary.mime_type === 'image/png' ? 'png' : 'jpg'}`,
      mediaType: binary.mime_type, bytes, text, sourceDeviceId: deviceId });
  }
}
