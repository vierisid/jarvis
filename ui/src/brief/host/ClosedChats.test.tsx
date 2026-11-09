import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { BriefConversation, BriefPage } from '../../../../src/brief/contracts';
import type { Root } from 'react-dom/client';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let ClosedChats: typeof import('./ClosedChats').ClosedChats;
let root: Root, host: HTMLDivElement;
const row = (id: string) => ({ conversationId: id, workspaceId: 'w', title: `Chat ${id}`, revision: '1', tab: { open: false, order: 0 } } as BriefConversation);
beforeAll(async () => { GlobalRegistrator.register(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; React = await import('react'); ({ createRoot } = await import('react-dom/client')); ({ ClosedChats } = await import('./ClosedChats')); });
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === name || b.textContent === name)!;
async function click(name: string) { expect(button(name)).toBeDefined(); await React.act(async () => button(name).click()); }

test('closed history pages, survives a failed reopen, and restores focus after successful reopen', async () => {
  let fail = true; const calls: Array<string | null> = [], opened: string[] = [];
  const client = { listClosed: async (cursor: string | null) => { calls.push(cursor); return cursor ? { items: [row('b')], nextCursor: null } : { items: [row('a')], nextCursor: 'page2' }; },
    reopen: async (id: string) => { opened.push(id); if (fail) throw new Error('fixture'); } };
  await React.act(async () => root.render(<ClosedChats client={client} openIds={[]} busy={false} />));
  await click('Closed chats'); await click('Load more'); expect(calls).toEqual([null, 'page2']);
  await click('Reopen Chat b'); expect(host.textContent).toContain('could not be reopened'); expect(button('Reopen Chat b')).toBeDefined();
  fail = false; await click('Reopen Chat b'); expect(opened).toEqual(['b', 'b']);
  expect(button('Closed chats').getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(button('Closed chats'));
});
test('failed history is retryable and late history from an old scope stays hidden', async () => {
  let fail = true, resolve!: (page: BriefPage<BriefConversation>) => void, captured!: AbortSignal;
  const client = { listClosed: async (_cursor: string | null, signal: AbortSignal) => {
    if (fail) throw new Error('offline'); captured = signal; return new Promise<BriefPage<BriefConversation>>(r => { resolve = r; }); }, reopen: async () => {} };
  await React.act(async () => root.render(<ClosedChats key="old" client={client} openIds={[]} busy={false} />));
  await click('Closed chats'); expect(host.textContent).toContain('could not be loaded'); fail = false; await click('Reload closed chats');
  await React.act(async () => root.render(<ClosedChats key="new" client={client} openIds={[]} busy={false} />));
  expect(captured.aborted).toBe(true); await React.act(async () => resolve({ items: [row('secret-old')], nextCursor: null }));
  expect(host.textContent).not.toContain('secret-old');
});
test('a pending reopen dispatches once and a new close refreshes visible history', async () => {
  let reads = 0, opens = 0, finish!: () => void;
  const client = { listClosed: async () => { reads++; return { items: [row('a')], nextCursor: null }; },
    reopen: () => { opens++; return new Promise<void>(r => { finish = r; }); } };
  const render = (ids: string[]) => React.act(async () => root.render(<ClosedChats client={client} openIds={ids} busy={false} />));
  await render(['x']); await click('Closed chats'); await render([]); expect(reads).toBe(2);
  await click('Reopen Chat a'); await click('Reopen Chat a'); expect(opens).toBe(1);
  await React.act(async () => finish());
});
