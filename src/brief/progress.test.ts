import { expect, test } from 'bun:test';
import { BriefProgressProjector, MAX_TURN_ACTIVITIES } from './progress';
import type { ExecutionActivity } from '../actions/progress-context';

test('one stable row advances once, ignores duplicate/late starts, and never interpolates source text', () => {
  const projector = new BriefProgressProjector();
  const event = { kind: 'tool', executionId: 'PRIVATE EXECUTION ID', phase: 'started', toolName: 'read_file',
    arguments: { token: 'PRIVATE ARGUMENT' }, summary: 'PRIVATE CHAIN OF THOUGHT', error: 'PRIVATE ERROR' } as const;
  const start = projector.project(event)!;
  expect(start).toMatchObject({ kind: 'tool', order: 1, phase: 'started', summary: 'Reading a file.', refs: [] });
  expect(projector.project(event)).toBeNull();
  const end = projector.project({ ...event, phase: 'failed' })!;
  expect(end).toMatchObject({ activityId: start.activityId, order: 1, phase: 'failed', summary: 'File could not be read.' });
  expect(projector.project(event)).toBeNull();
  expect(projector.project({ ...event, phase: 'completed' })).toBeNull();
  expect(JSON.stringify([start, end])).not.toContain('PRIVATE');
  expect(start.phase).toBe('started'); // Returned snapshots do not mutate behind a consumer.
});

test.each(['__proto__', 'constructor', '<img src=x onerror=SECRET>', 'Bearer SECRET', 'read_file\nSECRET'])('unknown tool name %s gets only fixed generic labels', toolName => {
  const projector = new BriefProgressProjector();
  const start = projector.project({ kind: 'tool', executionId: 'id', phase: 'started', toolName })!;
  expect(start.summary).toBe('Running a tool.');
  expect(projector.project({ kind: 'tool', executionId: 'id', phase: 'completed', toolName })?.summary).toBe('Tool returned.');
  expect(JSON.stringify(start)).not.toContain('SECRET');
});

test('references require a canonical lookup and never copy supplied revisions or unknown kinds', () => {
  const lookedUp: string[] = [];
  const projector = new BriefProgressProjector(ref => {
    lookedUp.push(ref.id);
    return ref.id === 'known' ? { ...ref, revision: 'PRIVATE REVISION' } : null;
  });
  const row = projector.project({ kind: 'task', executionId: 'id', phase: 'completed', refs: [
    { kind: 'goal', id: 'known' }, { kind: 'goal', id: 'unknown' }, { kind: 'fact', id: 'SECRET\n' }, { kind: 'source', id: 'known' },
  ] } as ExecutionActivity)!;
  expect(row.refs).toEqual([{ kind: 'goal', id: 'known', revision: null }]);
  expect(lookedUp).toEqual(['known', 'unknown']);
  expect(JSON.stringify(row)).not.toContain('PRIVATE');
  expect(new BriefProgressProjector().project({ kind: 'agent', executionId: 'id', phase: 'started', refs: [{ kind: 'goal', id: 'known' }] })?.refs).toEqual([]);
});

test('activity count is bounded while admitted rows can still finish', () => {
  const projector = new BriefProgressProjector();
  for (let i = 0; i < MAX_TURN_ACTIVITIES; i++) expect(projector.project({ kind: 'tool', executionId: String(i), phase: 'started' })?.order).toBe(i + 1);
  expect(projector.project({ kind: 'task', executionId: 'extra', phase: 'started' })).toBeNull();
  expect(projector.project({ kind: 'tool', executionId: '0', phase: 'completed' })?.phase).toBe('completed');
  expect(projector.project({ kind: 'tool', executionId: 'x'.repeat(257), phase: 'started' })).toBeNull();
  expect(projector.project({ kind: '__proto__', executionId: 'id', phase: 'started' } as unknown as ExecutionActivity)).toBeNull();
});
