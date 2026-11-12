import { expect, test } from 'bun:test';
import { keptEdits, serializeEdits, staleEditsTime } from './edit-copy';
import { describeSaveFailure, OFFLINE_SAVE_TEXT, SESSION_ENDED_SAVE_TEXT, workflowGone } from './save-failure';

const edits = { base: 'rev-1', displayName: 'Mine', trigger: { name: 'trigger', type: 'EMPTY' } as never, orphans: [], positions: { step_1: { x: 1, y: 2 } } };

test('a kept copy comes back only for the revision it was made from', () => {
  const text = serializeEdits(edits)!;
  expect(keptEdits(text, 'rev-1')).toMatchObject({ base: 'rev-1', displayName: 'Mine', positions: { step_1: { x: 1, y: 2 } } });
  expect(keptEdits(text, 'rev-2')).toBeNull();
  expect(keptEdits(text, null)).toBeNull();
});

test('damaged or foreign copies are ignored, never thrown', () => {
  for (const bad of [null, '', 'not json', '[]', '{"v":2}', JSON.stringify({ v: 1, base: 'rev-1', trigger: { name: 'x' } })])
    expect(keptEdits(bad, 'rev-1')).toBeNull();
});

test('credentials typed into steps are never written, and come back from the saved draft', () => {
  const step = (input: Record<string, unknown>) => ({ name: 'call', type: 'PIECE', settings: { pieceName: '@activepieces/piece-http', input } }) as never;
  const trigger = (input: Record<string, unknown>, http: Record<string, unknown>) => ({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { input }, nextAction: step(http) }) as never;
  const savedHttp = { url: 'https://api.test', headers: { Authorization: 'Bearer saved-token' }, authFields: { password: 'saved-pass' } };
  const saved = { trigger: trigger({ secret: 'saved-webhook-secret-0123456789abcdef' }, savedHttp), orphans: [] };
  // Unchanged credentials: left out of the copy, put back from the saved draft, nothing to re-enter.
  const same = serializeEdits({ ...edits, trigger: trigger({ secret: 'saved-webhook-secret-0123456789abcdef' }, { ...savedHttp, url: 'https://api.test/v2' }) }, saved)!;
  for (const secret of ['saved-webhook-secret', 'saved-token', 'saved-pass']) expect(same).not.toContain(secret);
  const back = keptEdits(same, 'rev-1', saved)!;
  expect(back.credentialsDropped).toBe(false);
  expect((back.trigger as any).settings.input.secret).toBe('saved-webhook-secret-0123456789abcdef');
  expect((back.trigger as any).nextAction.settings.input).toEqual({ ...savedHttp, url: 'https://api.test/v2' });
  // A credential typed since the save, here and in a step not yet saved (an orphan): never written, and said.
  const typed = serializeEdits({ ...edits, trigger: trigger({ secret: 'typed-webhook-secret-0123456789abcdef' }, savedHttp),
    orphans: [{ node: step({ api_key: 'typed-key' }), x: 1, y: 2 }] }, saved)!;
  for (const secret of ['typed-webhook-secret', 'typed-key']) expect(typed).not.toContain(secret);
  const restored = keptEdits(typed, 'rev-1', saved)!;
  expect(restored.credentialsDropped).toBe(true);
  expect((restored.trigger as any).settings.input.secret).toBe('saved-webhook-secret-0123456789abcdef');
  expect((restored.orphans[0]!.node as any).settings.input).toEqual({});
  // Empty values are not credentials and stay as they are.
  expect(keptEdits(serializeEdits({ ...edits, trigger: trigger({ secret: '' }, {}) })!, 'rev-1')!.credentialsDropped).toBe(false);
});

test('a stale copy still says when it was made, and damaged positions are dropped', () => {
  const text = serializeEdits({ ...edits, positions: { step_1: { x: 1, y: 2 }, bad: { x: 'no' } as never } })!;
  expect(staleEditsTime(text)).toBeGreaterThan(0);
  expect(staleEditsTime('not json')).toBeNull();
  expect(keptEdits(text, 'rev-1')!.positions).toEqual({ step_1: { x: 1, y: 2 } });
});

test('a copy too large to keep is skipped, so the edits stay on screen only', () => {
  const huge = { name: 'trigger', type: 'EMPTY', settings: { input: { text: 'x'.repeat(1_600_000) } } } as never;
  expect(serializeEdits({ ...edits, trigger: huge })).toBeNull();
});

test('save failures say what happened and that the edits are still here', () => {
  expect(describeSaveFailure(new TypeError('Failed to fetch'))).toBe(OFFLINE_SAVE_TEXT);
  expect(describeSaveFailure(new Error('Authentication required'))).toBe(SESSION_ENDED_SAVE_TEXT);
  expect(describeSaveFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toContain('Your edits are still here');
  expect(describeSaveFailure(new Error('Host unavailable'))).toContain('Reload to reconnect');
  expect(describeSaveFailure(new Error('database is locked'))).toBe('This could not be saved. Your edits are still here; try again.');
  for (const text of [OFFLINE_SAVE_TEXT, SESSION_ENDED_SAVE_TEXT]) expect(text).not.toContain('Failed to fetch');
});

test('a deleted workflow is recognised by code or error', () => {
  expect(workflowGone({ error: 'workflow_removed', code: 'workflow_removed' })).toBe(true);
  expect(workflowGone({ code: 'workflow_purging' })).toBe(true);
  expect(workflowGone({ error: 'This draft changed in another tab.' })).toBe(false);
  expect(workflowGone(null)).toBe(false);
});
