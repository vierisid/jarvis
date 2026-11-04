import { expect, test } from 'bun:test';
import { isInterruptedRequest, versionBoundRequest } from './request';

test('published canvas reads the selected locked version even when a newer draft exists', async () => {
  const calls: string[] = [];
  const selected = { id: 'v1', flowId: 'flow', state: 'LOCKED', trigger: { name: 'trigger' }, uiMeta: { positions: {} } };
  const request = versionBoundRequest(async input => {
    calls.push(String(input));
    return Response.json(String(input).endsWith('/versions/v1') ? selected : {
      flow: { id: 'flow' }, latestDraft: { id: 'v3', flowId: 'flow' }, published: { id: 'v2', flowId: 'flow' },
    });
  }, 'flow', 'v1', true);
  const detail = await (await request('/api/workflows/flow')).json();
  expect(detail.latestDraft).toBeNull();
  expect(detail.published).toEqual(selected);
  expect(detail.uiMeta).toEqual(selected.uiMeta);
  expect(calls).toHaveLength(2);
});

test('read-only canvas rejects writes before transport and rejects substituted ownership', async () => {
  let calls = 0;
  const request = versionBoundRequest(async input => {
    calls++;
    return Response.json(String(input).endsWith('/versions/v1')
      ? { id: 'v1', flowId: 'other', state: 'LOCKED' } : { flow: { id: 'flow' } });
  }, 'flow', 'v1', true);
  expect((await request('/api/workflows/flow/operations', { method: 'POST' })).status).toBe(403);
  expect(calls).toBe(0);
  await expect(request('/api/workflows/flow')).rejects.toThrow('Selected version changed');
});

test('cancelled and interrupted reads are told apart from real failures', () => {
  const controller = new AbortController(); controller.abort();
  expect(isInterruptedRequest(new Error('x'), { signal: controller.signal })).toBe(true);
  expect(isInterruptedRequest(new DOMException('Fetch is aborted', 'AbortError'))).toBe(true);
  expect(isInterruptedRequest(new DOMException('slow', 'TimeoutError'))).toBe(true);
  expect(isInterruptedRequest(new TypeError('Failed to fetch'))).toBe(false);
  expect(isInterruptedRequest(new Error('The selected version changed. Reopen this workflow to continue.'))).toBe(false);
});
