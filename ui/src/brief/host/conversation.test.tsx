import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { BriefConversationClient } from '../chat/client';
import { BriefCapabilities } from '../../../../src/brief/capabilities';
import type { BriefAttachmentRef } from '../../../../src/brief/attachment-contracts';
import { initDatabase, getDb, closeDb } from '../../../../src/vault/schema';
import { ConversationRepository } from '../../../../src/vault/conversation-lifecycle';
import type { AttachmentApi } from '../chat/attachments';
GlobalRegistrator.register({ url: 'http://localhost:4394/' });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());

test('attachment feedback stays in its chat while late uploads and removals preserve other drafts', async () => {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { ConversationDraft } = await import('./conversation');
  initDatabase(':memory:', { quiet: true }); const repository = new ConversationRepository(getDb());
  const enabled = ['conversations', 'chatTransport', 'chatState', 'chatAttachments'] as const;
  const capabilities = new BriefCapabilities(enabled.map(id => ({ id, provider: { readiness: () => 'ready' as const } })), enabled).snapshot();
  let delayed = false, finish!: () => void, failRemove!: (error: Error) => void;
  const files: AttachmentApi = {
    upload: async (c, id, kind, file) => {
      if (delayed) await new Promise<void>(r => { finish = r; });
      return { conversationId: c, attachmentId: id, kind, name: file.name, state: 'ready', mediaType: 'text/plain', size: file.size, expiresAt: Date.now() + 60000, turnId: null, sha256: 'fixture-hash' };
    },
    get: async () => { throw new Error('unused'); }, capture: async () => { throw new Error('unused'); },
    remove: () => new Promise<BriefAttachmentRef>((_, reject) => { failRemove = reject; }),
  };
  const client = new BriefConversationClient({ capabilities: async () => capabilities, tabs: async () => repository.tabs(),
    create: async () => repository.create(), tab: async (id, open) => repository.setOpen(id, open), select: async id => repository.activate(id),
    history: async (id, cursor) => repository.messages(id, { cursor: cursor ?? undefined }) }, undefined, files);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const act = (fn: () => unknown) => React.act(async () => { await fn(); });
  function Harness() {
    const status = React.useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
    const state = React.useSyncExternalStore(client.store.subscribe, client.store.getSnapshot, client.store.getSnapshot);
    return <ConversationDraft owner={{ client, status, state, current: state.activeId ? state.conversations[state.activeId] ?? null : null }} host={{ devices: () => [] }} />;
  }
  async function upload() {
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Add attachment"]')!.click());
    await act(() => document.querySelector<HTMLButtonElement>('[data-choice="document"]')!.click());
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!; expect(picker).not.toBeNull();
    Object.defineProperty(picker, 'files', { value: [new File(['fixture'], 'fixture.txt', { type: 'text/plain' })] });
    await act(() => picker.dispatchEvent(new Event('change')));
  }
  try {
    await client.start(); const a = await client.add(), b = await client.add(); await client.select(a);
    client.adapter.onOpen({ readyState: 1, send: () => {} } as unknown as WebSocket);
    for (let i = 0; !client.getSnapshot().connected && i < 100; i++) await Bun.sleep(1);
    await act(() => root.render(<Harness />));
    await upload(); expect(host.textContent).toContain('Document attached.');
    await act(() => client.select(b)); expect(host.textContent).not.toContain('Document attached.'); expect(host.textContent).not.toContain('fixture.txt');
    await act(() => client.store.setDraft(b, 'B draft stays'));
    await act(() => client.select(a)); delayed = true; await upload(); expect(host.textContent).toContain('Adding document');
    await act(() => client.select(b)); await act(() => finish());
    expect(host.textContent).not.toContain('Document attached.'); expect(host.querySelector('textarea')!.value).toBe('B draft stays');
    expect(client.store.getSnapshot().conversations[a]?.attachments).toHaveLength(2);
    await act(() => client.select(a));
    await act(() => [...host.querySelectorAll('button')].find(b => b.textContent === 'Remove')!.click());
    await act(() => client.select(b)); await act(() => failRemove(new Error('fixture rejected')));
    expect(host.textContent).not.toContain('attachment change'); expect(host.querySelector('textarea')!.value).toBe('B draft stays');
  } finally { await act(() => root.unmount()); host.remove(); client.stop(); closeDb(); }
});
