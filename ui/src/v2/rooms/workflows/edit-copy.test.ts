import { expect, test } from 'bun:test';
import { keptEdits, serializeEdits } from './edit-copy';
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
