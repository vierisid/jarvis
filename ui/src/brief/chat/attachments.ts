import { ATTACHMENT_LIMITS as limits, type BriefAttachmentRef } from '../../../../src/brief/attachment-contracts';
import { uuid } from '../../lib/uuid';
import { ConversationStore, type ChatAttachment } from './store';

export interface AttachmentApi {
  get(conversationId: string, id: string, signal: AbortSignal): Promise<BriefAttachmentRef>;
  upload(conversationId: string, id: string, kind: 'document' | 'image', file: File, signal: AbortSignal): Promise<BriefAttachmentRef>;
  capture(conversationId: string, id: string, deviceId: string, signal: AbortSignal): Promise<BriefAttachmentRef>;
  remove(conversationId: string, id: string, signal: AbortSignal): Promise<BriefAttachmentRef>;
}
export function attachmentApi(fetcher: (input: string, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init)): AttachmentApi {
  const request = async (conversationId: string, id: string, signal: AbortSignal, init: RequestInit = {}, suffix = '') => {
    const response = await fetcher(`/api/brief/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(id)}${suffix}`,
      { ...init, credentials: 'same-origin', cache: 'no-store', signal });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : `Attachment request failed (${response.status}).`);
    const ref = value as BriefAttachmentRef;
    if (!ref || ref.conversationId !== conversationId || ref.attachmentId !== id || typeof ref.name !== 'string'
      || !['document', 'image', 'screenshot'].includes(ref.kind) || !['ready', 'accepted', 'removed', 'expired'].includes(ref.state)
      || typeof ref.mediaType !== 'string' || !Number.isFinite(ref.size) || ref.size < 0 || !Number.isFinite(ref.expiresAt)
      || !(ref.turnId === null || typeof ref.turnId === 'string')) throw new Error('Invalid attachment response.');
    return ref;
  };
  return {
    get: (c, id, signal) => request(c, id, signal),
    upload: (c, id, kind, file, signal) => request(c, id, signal, { method: 'PUT', body: file,
      headers: { 'Content-Type': file.type || mimeFor(file.name), 'X-Attachment-Kind': kind, 'X-Attachment-Name': encodeURIComponent(file.name) } }),
    capture: (c, id, deviceId, signal) => request(c, id, signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, confirm: true }) }, '/capture'),
    remove: (c, id, signal) => request(c, id, signal, { method: 'DELETE' }),
  };
}
const mimeFor = (name: string) => ({ txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' })[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';
type Job = { conversationId: string; id: string; file?: File; kind?: 'document' | 'image'; deviceId?: string; controller: AbortController };

/** File objects stay in memory only. The store and wire contain bounded references. */
export class DraftAttachments {
  private jobs = new Map<string, Job>();
  private epoch = 0;
  constructor(private readonly store: ConversationStore, private readonly api: AttachmentApi,
    private readonly enabled: () => boolean, private readonly locked: (id: string) => boolean) {}
  private check(conversationId: string) {
    if (!this.enabled()) throw new Error('Attachments are not enabled on this backend.');
    if (!this.store.getSnapshot().order.includes(conversationId)) throw new Error('Open this conversation before attaching files.');
  }
  private items(c: string) { return this.store.getSnapshot().conversations[c]?.attachments ?? []; }
  private update(c: string, id: string, patch: Partial<ChatAttachment>) {
    this.store.setAttachments(c, this.items(c).map(item => item.attachmentId === id ? { ...item, ...patch } : item));
  }
  private add(job: Job, item: ChatAttachment) {
    this.check(job.conversationId);
    if (this.items(job.conversationId).length >= limits.perTurn) throw new Error(`Choose at most ${limits.perTurn} attachments.`);
    this.jobs.set(job.id, job);
    this.store.setAttachments(job.conversationId, [...this.items(job.conversationId), item]);
    return this.run(job);
  }
  upload(conversationId: string, kind: 'document' | 'image', file: File) {
    if (!file.size || file.size > (kind === 'document' ? limits.documentBytes : limits.fileBytes)) throw new Error('The file is empty or exceeds its attachment size limit.');
    const id = uuid();
    return this.add({ conversationId, id, kind, file, controller: new AbortController() },
      { attachmentId: id, name: file.name, mediaType: file.type || mimeFor(file.name), size: file.size, state: 'uploading', kind });
  }
  capture(conversationId: string, deviceId: string, confirm: boolean) {
    if (confirm !== true || !deviceId) throw new Error('Confirm the device before taking a screenshot.');
    const id = uuid();
    return this.add({ conversationId, id, deviceId, controller: new AbortController() },
      { attachmentId: id, name: 'Screenshot', mediaType: 'image/jpeg', size: 0, state: 'uploading', kind: 'screenshot' });
  }
  async retry(conversationId: string, id: string) {
    this.check(conversationId);
    const job = this.jobs.get(id);
    if (!job || job.conversationId !== conversationId || this.items(conversationId).find(a => a.attachmentId === id)?.state !== 'failed') throw new Error('Choose the file again to retry.');
    job.controller = new AbortController(); return this.run(job);
  }
  private async run(job: Job) {
    const epoch = this.epoch;
    this.update(job.conversationId, job.id, { state: 'uploading', error: undefined });
    try {
      const ref = job.file ? await this.api.upload(job.conversationId, job.id, job.kind!, job.file, job.controller.signal)
        : await this.api.capture(job.conversationId, job.id, job.deviceId!, job.controller.signal);
      if (epoch !== this.epoch || this.jobs.get(job.id) !== job || job.controller.signal.aborted) return;
      if (ref.state !== 'ready' || ref.expiresAt <= Date.now()) throw new Error('Attachment is no longer available; choose it again.');
      this.update(job.conversationId, job.id, { state: 'ready', size: ref.size, mediaType: ref.mediaType, name: ref.name });
      this.jobs.delete(job.id); return ref;
    } catch (error) {
      if (epoch === this.epoch && this.jobs.get(job.id) === job && !job.controller.signal.aborted) this.update(job.conversationId, job.id, { state: 'failed', error: error instanceof Error ? error.message : 'Attachment failed.' });
      throw error;
    }
  }
  async remove(conversationId: string, id: string) {
    this.check(conversationId);
    if (this.locked(id)) throw new Error('Wait for the pending message to be acknowledged.');
    const job = this.jobs.get(id);
    if (job?.conversationId === conversationId) { job.controller.abort(); this.jobs.delete(id); }
    const epoch = this.epoch;
    this.update(conversationId, id, { state: 'removing', error: undefined });
    try {
      await this.api.remove(conversationId, id, new AbortController().signal);
      if (epoch === this.epoch) this.store.acceptAttachments(conversationId, [id]);
    } catch (error) {
      if (epoch === this.epoch) this.update(conversationId, id, { state: 'failed', error: 'Removal failed. Retry Remove before sending.' });
      throw error;
    }
  }
  /** Closing aborts unfinished uploads; ready references survive close/reopen with the draft. */
  close(conversationId: string) {
    for (const job of this.jobs.values()) if (job.conversationId === conversationId) {
      job.controller.abort(); this.jobs.delete(job.id);
      this.update(conversationId, job.id, { state: 'failed', error: 'Upload interrupted when the tab closed. Choose the file again.' });
      // Tombstone a late decoder result. If offline, expiry still bounds its lifetime.
      void this.api.remove(conversationId, job.id, new AbortController().signal).catch(() => {});
    }
  }
  stop() { this.epoch++; for (const job of this.jobs.values()) job.controller.abort(); this.jobs.clear(); }
  async restore(conversationId: string, signal: AbortSignal) {
    if (!this.enabled()) return;
    const epoch = this.epoch;
    for (const item of this.items(conversationId)) {
      if (this.jobs.has(item.attachmentId) || this.locked(item.attachmentId)) continue;
      try {
        const ref = await this.api.get(conversationId, item.attachmentId, signal);
        if (epoch !== this.epoch || signal.aborted) return;
        if (JSON.stringify(this.items(conversationId).find(a => a.attachmentId === item.attachmentId)) !== JSON.stringify(item) || this.jobs.has(item.attachmentId)) continue;
        if (ref.state === 'accepted') this.store.acceptAttachments(conversationId, [item.attachmentId]);
        else if (ref.state === 'ready' && ref.expiresAt > Date.now()) this.update(conversationId, item.attachmentId,
          { state: 'ready', error: undefined, name: ref.name, mediaType: ref.mediaType, size: ref.size, kind: ref.kind });
        else this.update(conversationId, item.attachmentId, { state: 'failed', error: 'Attachment expired or was removed. Choose the file again.' });
      } catch {
        if (epoch !== this.epoch || signal.aborted) return;
        if (JSON.stringify(this.items(conversationId).find(a => a.attachmentId === item.attachmentId)) !== JSON.stringify(item) || this.jobs.has(item.attachmentId)) continue;
        this.update(conversationId, item.attachmentId, { state: 'failed', error: 'Attachment unavailable. Remove it and choose the file again.' });
      }
    }
  }
}
