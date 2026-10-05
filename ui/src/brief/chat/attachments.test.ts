import { expect, test } from 'bun:test';
import { ConversationStore } from './store';
import { DraftAttachments, type AttachmentApi } from './attachments';
import type { BriefAttachmentRef } from '../../../../src/brief/attachment-contracts';

const ref = (conversationId: string, attachmentId: string): BriefAttachmentRef => ({ conversationId, attachmentId, kind: 'document', name: 'fixture.txt', mediaType: 'text/plain', size: 3,
  sha256: 'fixture', expiresAt: Date.now() + 60_000, state: 'ready', turnId: null });
function fixture(api: Partial<AttachmentApi> = {}, enabled = true) {
  const saved = new Map<string, string>();
  const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); } };
  const store = new ConversationStore(storage);
  store.restoreTabs({ workspaceId: 'workspace', revision: '1', activeConversationId: 'a', tabs: ['a', 'b'].map((id, i) => ({ conversationId: id, workspaceId: 'workspace', revision: '1', title: id, tab: { open: true, order: i }, lastMessageAt: null })) });
  const port: AttachmentApi = { get: async (c, id) => ref(c, id), upload: async (c, id) => ref(c, id), capture: async (c, id) => ref(c, id), remove: async (c, id) => ({ ...ref(c, id), state: 'removed' }), ...api };
  const files = new DraftAttachments(store, port, () => enabled, () => false);
  const file = new File(['PRIVATE FILE BYTES'], 'fixture.txt', { type: 'text/plain' });
  const items = (id = 'a') => store.getSnapshot().conversations[id]!.attachments;
  return { store, files, file, saved, storage, items };
}

test('failed upload retries with the same identity and switching chats cannot move its result', async () => {
  let fail = true; const ids: string[] = [];
  const f = fixture({ upload: async (c, id) => { ids.push(id); if (fail) throw Error('Upload failed'); return ref(c, id); } });
  await expect(f.files.upload('a', 'document', f.file)).rejects.toThrow('Upload failed');
  expect(f.items()[0]).toMatchObject({ state: 'failed', error: 'Upload failed' });
  f.store.select('b'); fail = false;
  await f.files.retry('a', ids[0]!);
  expect(ids[0]).toBe(ids[1]); expect(f.items()[0]?.state).toBe('ready'); expect(f.items('b')).toEqual([]);
  expect(JSON.stringify([...f.saved.values()])).not.toContain('PRIVATE FILE BYTES');
});

test('remove and tab close abort pending uploads and ignore their late responses', async () => {
  const gates: Array<() => void> = [], signals: AbortSignal[] = [], removed: string[] = [];
  const f = fixture({ upload: (c, id, _kind, _file, signal) => new Promise(resolve => { signals.push(signal); gates.push(() => resolve(ref(c, id))); }),
    remove: async (c, id) => { removed.push(id); return { ...ref(c, id), state: 'removed' }; } });
  const first = f.files.upload('a', 'document', f.file), id = f.items()[0]!.attachmentId;
  await f.files.remove('a', id); gates[0]!(); await first;
  expect(signals[0]?.aborted).toBe(true); expect(f.items()).toEqual([]);
  const second = f.files.upload('a', 'document', f.file), next = f.items()[0]!.attachmentId;
  f.files.close('a'); gates[1]!(); await second;
  expect(signals[1]?.aborted).toBe(true); expect(f.items()[0]?.state).toBe('failed');
  expect(removed).toEqual([id, next]); expect(f.items('b')).toEqual([]);
});

test('reload verifies references, clears accepted files, and exposes expired or missing uploads', async () => {
  const f = fixture({ get: async (c, id) => ({ ...ref(c, id), state: id === 'accepted' ? 'accepted' : 'expired', turnId: id === 'accepted' ? 'turn' : null }) });
  f.store.setAttachments('a', ['accepted', 'expired'].map(id => ({ attachmentId: id, name: 'test', size: 3, mediaType: 'text/plain' })));
  await f.files.restore('a', new AbortController().signal);
  expect(f.items()).toHaveLength(1); expect(f.items()[0]).toMatchObject({ attachmentId: 'expired', state: 'failed' });
});

test('a late reference refresh cannot overwrite removal failure or a newer operation', async () => {
  let release!: () => void;
  const f = fixture({ get: (c, id) => new Promise(resolve => { release = () => resolve(ref(c, id)); }), remove: async () => { throw Error('Offline'); } });
  f.store.setAttachments('a', [{ attachmentId: 'old', name: 'old', size: 3, mediaType: 'text/plain', state: 'ready' }]);
  const restore = f.files.restore('a', new AbortController().signal);
  await expect(f.files.remove('a', 'old')).rejects.toThrow('Offline'); release(); await restore;
  expect(f.items()[0]?.state).toBe('failed');
});

test('acceptance preserves a file added by another window after the original send', () => {
  const f = fixture(), stale = new ConversationStore(f.storage);
  const old = { attachmentId: 'sent', name: 'sent', size: 3, mediaType: 'text/plain' };
  f.store.setAttachments('a', [old]);
  stale.restoreTabs({ workspaceId: 'workspace', revision: '1', activeConversationId: 'a', tabs: [f.store.getSnapshot().conversations.a!.conversation] });
  f.store.setAttachments('a', [old, { ...old, attachmentId: 'new' }]);
  stale.acceptAttachments('a', ['sent']);
  expect(stale.getSnapshot().conversations.a!.attachments.map(a => a.attachmentId)).toEqual(['new']);
});

test('disabled attachment capability and unconfirmed capture dispatch nothing', () => {
  let captures = 0;
  const f = fixture({ capture: async (c, id) => { captures++; return ref(c, id); } }, false);
  expect(() => f.files.upload('a', 'document', f.file)).toThrow('not enabled');
  expect(() => f.files.capture('a', 'device', false)).toThrow('Confirm');
  expect(() => f.files.capture('a', 'device', true)).toThrow('not enabled');
  expect(captures).toBe(0); expect(f.items()).toEqual([]);
});
