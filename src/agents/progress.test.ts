import { describe, expect, test } from 'bun:test';
import { progressAcknowledgement } from './progress.ts';

describe('progressAcknowledgement', () => {
  test('describes delegated work without exposing reasoning', () => {
    expect(progressAcknowledgement([{
      id: '1',
      name: 'delegate',
      arguments: { template: 'research', intent: 'compare providers' },
    }])).toBe('I’m looking into that now and I’ll report back.');
    expect(progressAcknowledgement([{
      id: '2',
      name: 'delegate',
      arguments: { template: 'code', intent: 'fix the route' },
    }])).toBe('I’m checking the relevant code now.');
  });

  test('uses concise activity labels for direct tools', () => {
    expect(progressAcknowledgement([{
      id: '1', name: 'read_file', arguments: { path: '/tmp/example' },
    }])).toBe('I’m checking the relevant details now.');
    expect(progressAcknowledgement([{
      id: '2', name: 'write_file', arguments: { path: '/tmp/example' },
    }])).toBe('I’m working through that now.');
  });
});
