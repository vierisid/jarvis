import { expect, test } from 'bun:test';
import { conversationApi } from './api';
test('closed history requests an authenticated bounded page and rejects malformed or open rows', async () => {
  const row = { conversationId: 'c', workspaceId: 'w', title: 'Title', revision: '1', tab: { open: false, order: 0 } };
  let payload: unknown = { items: [row], nextCursor: null };
  const api = conversationApi(async (path, options) => {
    expect(path).toBe('/api/brief/conversations?closed=true&limit=50&cursor=a%26b');
    expect(options.credentials).toBe('same-origin'); expect(options.cache).toBe('no-store');
    return Response.json(payload);
  });
  expect((await api.closed!('a&b', new AbortController().signal)).items).toHaveLength(1);
  for (const bad of [{ items: [row, row], nextCursor: null }, { items: [{ ...row, tab: { open: true, order: 0 } }], nextCursor: null }, { items: [row] }]) {
    payload = bad; await expect(api.closed!('a&b', new AbortController().signal)).rejects.toThrow('Invalid closed');
  }
});
