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

// The prototype has Undo on its receipts. Here it is on every receipt that can really be taken back.
describe('what else was started, and can be taken back', () => {
  const now = new Date(2026, 10, 16, 15, 0, 0).getTime();
  const at = (hour: number, minute: number): number => new Date(2026, 10, 16, hour, minute, 0).getTime();
  const more = () => [
    { id: 'eye:e1', at: at(9, 5), text: "Watching for Sam's reply", small: 'watching', undo: true },
    { id: 'chase:c1', at: at(10, 0), text: "Getting Anna's answer by Friday", small: 'on it', undo: true },
    { id: 'chase:c2', at: at(11, 0), text: "Getting Leo's signature by Monday", small: 'stopped', undo: false },
    { id: 'agent:f1', at: at(12, 0), text: 'Made Nora: Every Monday at 9, send Sam the numbers.', small: 'on', undo: true },
  ];

  test('each is a row with its own id, and Undo only while it can be taken back', () => {
    const rows = notchToday({ executedApprovals: () => [], more, now: () => now });
    expect(notchTodayBlocks(rows)).toEqual([
      { kind: 'row', lead: '12:00', say: ['Made Nora: Every Monday at 9, send Sam the numbers.'], id: 'agent:f1', buttons: [{ id: 'undo', label: 'Undo', quiet: true }] },
      { kind: 'row', lead: '11:00', say: ["Getting Leo's signature by Monday"], id: 'chase:c2', small: 'stopped' },
      { kind: 'row', lead: '10:00', say: ["Getting Anna's answer by Friday"], id: 'chase:c1', buttons: [{ id: 'undo', label: 'Undo', quiet: true }] },
      { kind: 'row', lead: '09:05', say: ["Watching for Sam's reply"], id: 'eye:e1', buttons: [{ id: 'undo', label: 'Undo', quiet: true }] },
    ]);
  });

  test('a mail that was sent has no Undo, and neither has a promise that was kept: they cannot be taken back', () => {
    const rows = notchToday({
      executedApprovals: () => [],
      keptPromises: () => [{ what: 'Reminded you of the board call', completed_at: at(8, 0) }],
      sentMail: () => [{ at: at(9, 0), text: 'Replied to Leo: Deck for Thursday?', small: '1.2k tokens' }],
      more,
      now: () => now,
    });
    const blocks = notchTodayBlocks(rows) as { say: string[]; buttons?: unknown }[];
    for (const block of blocks.filter((one) => /Replied to Leo|Reminded you/.test(one.say[0]!))) expect(block.buttons).toBeUndefined();
    expect(blocks.filter((block) => block.buttons).length).toBe(3);
  });

  test('they stand in the order things were done, only those of the span that is asked for, and a long one is cut', () => {
    const rows = notchToday({
      executedApprovals: () => [],
      jobs: () => [{ id: 'a', at: at(10, 30), text: 'Pasted 7 from Notepad into Excel', undoable: true }],
      more: () => [...more(), { id: 'eye:old', at: at(9, 0) - 24 * 3_600_000, text: 'Yesterday', small: 'watching', undo: true }, { id: 'agent:long', at: at(13, 0), text: 'x'.repeat(400), small: 'on', undo: true }],
      now: () => now,
    });
    expect(rows.map((row) => row.more?.id ?? `job:${row.job?.id}`)).toEqual(['agent:long', 'agent:f1', 'chase:c2', 'job:a', 'chase:c1', 'eye:e1']);
    expect([...rows[0]!.text].length).toBeLessThanOrEqual(220);
  });

  test('with nothing done, the note says so in the words it is given', () => {
    expect(notchTodayBlocks([])).toEqual([{ kind: 'note', say: ['Nothing done yet today.'] }]);
    expect(notchTodayBlocks([], 'Nothing was done overnight.')).toEqual([{ kind: 'note', say: ['Nothing was done overnight.'] }]);
  });
});


// Fix 05, the owner's decision of 26 November 2026: what the notch did that no other part lists is a row
// too (./actions.ts). The rows that were there are as they were.
describe('what only the list of what the notch did has', () => {
  const now = new Date(2026, 10, 26, 15, 0, 0).getTime();
  const at = (hour: number, minute: number): number => new Date(2026, 10, 26, hour, minute, 0).getTime();

  test('each is a row with what came of it as its small word, among the others in the order they happened, and none has an Undo', () => {
    const deps = {
      executedApprovals: () => [],
      keptPromises: () => [{ what: 'Send Anna the pricing', completed_at: at(10, 30) }],
      sentMail: () => [{ at: at(9, 15), text: 'Replied to Leo: Deck for Thursday?', small: '1,280 tokens' }],
      jobs: () => [{ id: 'j1', at: at(11, 0), text: 'Pasted 7 from Notepad into Excel', undoable: true }],
      more: () => [{ id: 'chase:c1', at: at(8, 0), text: "Getting Sam's answer by Friday", small: 'on it', undo: true }],
      now: () => now,
    };
    const before = notchTodayBlocks(notchToday(deps));
    const rows = notchToday({
      ...deps,
      actions: () => [
        { id: 'action:na-1', at: at(12, 0), text: "Follow-up to Sam for Sam's answer", small: 'sent', undo: false },
        { id: 'action:na-2', at: at(9, 45), text: 'Message to Leo', small: 'may have gone', undo: false },
        { id: 'action:old', at: at(9, 45) - 86_400_000, text: 'Message to Anna', small: 'sent', undo: false },
      ],
    });
    const blocks = notchTodayBlocks(rows);
    expect(blocks).toEqual([
      { kind: 'row', lead: '12:00', say: ["Follow-up to Sam for Sam's answer"], id: 'action:na-1', small: 'sent' },
      { kind: 'row', lead: '11:00', say: ['Pasted 7 from Notepad into Excel'], id: 'job:j1', buttons: [{ id: 'undo', label: 'Undo', quiet: true }] },
      { kind: 'row', lead: '10:30', say: ['Send Anna the pricing'], small: 'promised' },
      { kind: 'row', lead: '09:45', say: ['Message to Leo'], id: 'action:na-2', small: 'may have gone' },
      { kind: 'row', lead: '09:15', say: ['Replied to Leo: Deck for Thursday?'], small: 'sent · 1,280 tokens' },
      { kind: 'row', lead: '08:00', say: ["Getting Sam's answer by Friday"], id: 'chase:c1', buttons: [{ id: 'undo', label: 'Undo', quiet: true }] },
    ]);
    // The rows that were there before are the same rows, word for word.
    expect(blocks.filter((block) => !(block.kind === 'row' && block.id?.startsWith('action:')))).toEqual(before);
  });

  test('with no such list given, Today is what it was', () => {
    const rows = notchToday({ executedApprovals: () => [], keptPromises: () => [{ what: 'Send Anna the pricing', completed_at: at(10, 30) }], now: () => now });
    expect(notchTodayBlocks(rows)).toEqual([{ kind: 'row', lead: '10:30', say: ['Send Anna the pricing'], small: 'promised' }]);
  });
});
