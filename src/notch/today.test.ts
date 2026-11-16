import { describe, expect, test } from 'bun:test';
import { notchToday, notchTodayBlocks } from './today.ts';

describe('what Jarvis did where it could be seen, in Today (pass 10)', () => {
  const now = new Date(2026, 10, 16, 15, 0, 0).getTime();
  const at = (hour: number, minute: number): number => new Date(2026, 10, 16, hour, minute, 0).getTime();

  test('a job is a row, and one whose pastes can be taken back has an Undo', () => {
    const rows = notchToday({
      executedApprovals: () => [],
      jobs: () => [
        { id: 'a', at: at(10, 2), text: 'Pasted 7 from Notepad into Excel', undoable: true },
        { id: 'b', at: at(11, 30), text: 'Did what you showed me: renames the file and saves it (3 of 3 steps)', undoable: false },
      ],
      now: () => now,
    });
    expect(rows.map((row) => [row.kind, row.job?.id])).toEqual([['job', 'b'], ['job', 'a']]);
    expect(notchTodayBlocks(rows)).toEqual([
      { kind: 'row', lead: '11:30', say: ['Did what you showed me: renames the file and saves it (3 of 3 steps)'], id: 'job:b', small: 'done' },
      { kind: 'row', lead: '10:02', say: ['Pasted 7 from Notepad into Excel'], id: 'job:a', buttons: [{ id: 'undo', label: 'Undo', quiet: true }] },
    ]);
  });

  test('it stands among the other things done today, in the order they were done, and yesterday is not today', () => {
    const rows = notchToday({
      executedApprovals: () => [],
      keptPromises: () => [{ what: 'Send Anna the pricing', completed_at: at(10, 30) }],
      jobs: () => [{ id: 'a', at: at(10, 2), text: 'Pasted 7', undoable: true }, { id: 'old', at: at(10, 2) - 86_400_000, text: 'Pasted 2', undoable: true }],
      now: () => now,
    });
    expect(rows.map((row) => row.text)).toEqual(['Send Anna the pricing', 'Pasted 7']);
  });
});
