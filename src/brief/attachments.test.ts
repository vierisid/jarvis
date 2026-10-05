import { afterEach, expect, test } from 'bun:test';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { initDatabase, getDb, closeDb } from '../vault/schema';
import { ChatTurnRepository } from '../vault/chat-turns';
import { BriefAttachmentProvider } from './attachments';
import { ATTACHMENT_LIMITS as limits } from './attachment-contracts';
import type { SidecarManager } from '../sidecar/manager';

afterEach(() => closeDb());
function fixture(sidecar?: Pick<SidecarManager, 'getSidecar' | 'dispatchRPC'>) {
  initDatabase(':memory:', { quiet: true });
  const provider = new BriefAttachmentProvider(getDb(), sidecar), turns = new ChatTurnRepository(getDb());
  const a = turns.conversations.create().conversationId, b = turns.conversations.create().conversationId;
  const input = { conversationId: a, turnId: 'turn', requestId: 'request', text: 'Read this' };
  const upload = (id = 'file', conversationId = a, text = 'A private document') => provider.upload(conversationId, id, 'document', 'notes.txt', 'text/plain', Buffer.from(text));
  return { provider, turns, a, b, input, upload };
}
function pdf(text: string) {
  const content = `BT /F1 12 Tf 40 100 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(body);
}
export function fixturePng() { return PNG.sync.write({ width: 1, height: 1, data: Buffer.from([10, 20, 30, 255]) } as PNG); }

test('upload retries and turn retries preserve one canonical ref and original message ownership', async () => {
  const f = fixture(); const ref = await f.upload();
  expect(await f.upload()).toEqual(ref);
  const input = { ...f.input, attachmentIds: ['file'] };
  expect(f.turns.accept(input).created).toBe(true);
  expect(f.turns.accept(input).created).toBe(false);
  expect(f.provider.repository.forTurn(f.a, input.turnId)).toHaveLength(1);
  expect(f.turns.conversations.messages(f.a).items[0]?.attachments?.[0]).toMatchObject({ attachmentId: 'file', state: 'accepted', turnId: 'turn' });
  expect(() => f.turns.accept(f.input)).toThrow('identity');
  expect(() => f.turns.accept({ ...input, attachmentIds: ['file', 'file'] })).toThrow('Duplicate');
  expect(() => f.provider.repository.remove(f.a, 'file')).toThrow('accepted');
  f.turns.finish(input, 'completed');
  expect(() => f.turns.accept({ ...input, turnId: 'next', requestId: 'next' })).toThrow('already accepted');
  expect(f.turns.conversations.messages(f.a).items).toHaveLength(1);
  expect(JSON.stringify(f.turns.snapshot(f.a, 0))).not.toContain('A private document');
});

test('cross-conversation and cross-workspace reads, writes and binding fail without partial turns', async () => {
  const f = fixture(); await f.upload();
  expect(() => f.turns.accept({ ...f.input, conversationId: f.b, attachmentIds: ['file'] })).toThrow('Attachment not found');
  expect(() => f.provider.repository.remove(f.b, 'file')).toThrow('not found');
  await expect(f.upload('file', f.b)).rejects.toThrow('not found');
  const foreign = new BriefAttachmentProvider(getDb(), undefined, 'another-workspace');
  expect(() => foreign.repository.find(f.a, 'file')).toThrow('Conversation not found');
  expect(f.turns.pending()).toEqual([]);
  expect(f.turns.conversations.messages(f.b).items).toEqual([]);
  expect(f.provider.repository.find(f.a, 'file')?.state).toBe('ready');
});

test('a remove during decode prevents resurrection and expiry wipes bytes before processing', async () => {
  const f = fixture(); const uploading = f.upload();
  f.provider.repository.remove(f.a, 'file');
  await expect(uploading).rejects.toThrow('identity');
  expect(f.provider.repository.find(f.a, 'file')?.state).toBe('removed');
  await f.upload('expires');
  f.turns.accept({ ...f.input, attachmentIds: ['expires'] });
  getDb().run('UPDATE brief_chat_attachments SET expires_at = 0 WHERE attachment_id = ?', ['expires']);
  expect(() => f.provider.repository.content(f.a, 'turn')).toThrow('expired');
  expect(getDb().query('SELECT bytes, extracted_text FROM brief_chat_attachments WHERE attachment_id = ?').get('expires')).toEqual({ bytes: null, extracted_text: null });
  expect(f.provider.repository.forTurn(f.a, 'turn')[0]?.state).toBe('accepted');
});

test('closing a tab refuses a late upload and does not disturb accepted references', async () => {
  const f = fixture(); await f.upload(); f.turns.accept({ ...f.input, attachmentIds: ['file'] });
  const late = f.upload('late'); f.turns.conversations.setOpen(f.a, false);
  await expect(late).rejects.toThrow('Reopen');
  expect(f.provider.repository.find(f.a, 'late')).toBeNull();
  expect(f.provider.repository.forTurn(f.a, 'turn')).toHaveLength(1);
});

test('actual decoders accept synthetic text PDF, PNG and JPEG, reject malformed and oversized content', async () => {
  const f = fixture();
  const doc = await f.provider.upload(f.a, 'pdf', 'document', 'fixture.pdf', 'application/pdf', pdf('Synthetic attachment fixture'));
  expect(doc.kind).toBe('document');
  const png = await f.provider.upload(f.a, 'png', 'image', 'fixture.png', 'image/png', fixturePng());
  expect(png.size).toBeGreaterThan(20);
  const encoded = jpeg.encode({ width: 1, height: 1, data: Buffer.from([10, 20, 30, 255]) }, 80).data;
  expect((await f.provider.upload(f.a, 'jpg', 'image', 'fixture.jpg', 'image/jpeg', encoded)).mediaType).toBe('image/jpeg');
  f.turns.accept({ ...f.input, attachmentIds: ['pdf', 'png', 'jpg'] });
  expect(f.provider.repository.content(f.a, 'turn').find(f => f.ref.attachmentId === 'pdf')?.text).toContain('Synthetic attachment fixture');
  for (const mediaType of ['image/png', 'image/jpeg', 'application/pdf']) {
    await expect(f.provider.upload(f.b, `bad-${mediaType.split('/')[1]}`, mediaType.startsWith('image') ? 'image' : 'document', 'fake', mediaType, Buffer.from('not a file'))).rejects.toThrow('Malformed');
  }
  await expect(f.provider.upload(f.b, 'large', 'document', 'large.txt', 'text/plain', new Uint8Array(limits.documentBytes + 1))).rejects.toThrow('size');
  await expect(f.provider.upload(f.b, 'svg', 'image', 'evil.svg', 'image/svg+xml', Buffer.from('<svg/>'))).rejects.toThrow('Unsupported');
  await expect(f.provider.upload(f.b, 'path', 'document', '../../private', 'text/plain', Buffer.from('x'))).rejects.toThrow('paths');
  await expect(f.provider.upload(f.b, 'binary', 'document', 'binary.txt', 'text/plain', Buffer.from([255, 0, 1]))).rejects.toThrow('Malformed');
}, 20_000);

test('screenshot requires explicit confirmation and available capability; retry uses the same synthetic capture', async () => {
  let calls = 0, connected = true, deny = false;
  const sidecar = {
    getSidecar: () => ({ connected, capabilities: ['screenshot'], unavailable_capabilities: [] }),
    async dispatchRPC(_id: string, method: string) { calls++; expect(method).toBe('capture_screen'); if (deny) throw new Error('private permission detail'); return { _binary: { data: fixturePng().toString('base64'), mime_type: 'image/png' } }; },
  } as unknown as Pick<SidecarManager, 'getSidecar' | 'dispatchRPC'>;
  const f = fixture(sidecar);
  await expect(f.provider.capture(f.a, 'screen', 'device', false)).rejects.toThrow('Confirm'); expect(calls).toBe(0);
  connected = false;
  await expect(f.provider.capture(f.a, 'screen', 'device', true)).rejects.toThrow('unavailable'); expect(calls).toBe(0);
  connected = true; deny = true;
  await expect(f.provider.capture(f.a, 'screen', 'device', true)).rejects.toThrow('permission was denied');
  deny = false;
  const [first, duplicate] = await Promise.all([f.provider.capture(f.a, 'screen', 'device', true), f.provider.capture(f.a, 'screen', 'device', true)]);
  expect(first).toEqual(duplicate); expect(calls).toBe(2);
  expect(await f.provider.capture(f.a, 'screen', 'device', true)).toEqual(first); expect(calls).toBe(2);
  await expect(f.provider.capture(f.a, 'screen', 'different-device', true)).rejects.toThrow('identity');
});


test('a mixed invalid batch rolls back the earlier bindings and all canonical message writes', async () => {
  const f = fixture(); await f.upload('first');
  expect(() => f.turns.accept({ ...f.input, attachmentIds: ['first', 'missing'] })).toThrow('missing');
  expect(f.provider.repository.find(f.a, 'first')?.state).toBe('ready');
  expect(f.turns.pending()).toEqual([]); expect(f.turns.conversations.messages(f.a).items).toEqual([]);
  expect(() => f.turns.accept({ ...f.input, attachmentIds: ['1', '2', '3', '4', '5'] })).toThrow('at most');
  // Exercise the aggregate bound independently from image decoder validation.
  for (const id of ['large-a', 'large-b', 'large-c']) f.provider.repository.save({ conversationId: f.a, attachmentId: id,
    kind: 'image', name: 'fixture.png', mediaType: 'image/png', bytes: new Uint8Array(3 * 1024 * 1024), text: null });
  expect(() => f.turns.accept({ ...f.input, attachmentIds: ['large-a', 'large-b', 'large-c'] })).toThrow('turn size');
  expect(f.provider.repository.find(f.a, 'large-a')?.state).toBe('ready');
  expect(f.turns.pending()).toEqual([]);
});
