import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NOTCH_SWITCH } from '../notch/switch.ts';
import { NOTCH_TURN_NOTE, approvalWords, notchTurnNote } from './notch-asks.ts';

let before: string | undefined;
beforeEach(() => { before = process.env[NOTCH_SWITCH]; process.env[NOTCH_SWITCH] = '1'; });
afterEach(() => { if (before === undefined) delete process.env[NOTCH_SWITCH]; else process.env[NOTCH_SWITCH] = before; });

describe('what the agent is told about a turn from the notch', () => {
  test('only a turn started on the notch is told anything, and only with the switch on', () => {
    expect(notchTurnNote('notch-spoken-abc')).toBe(NOTCH_TURN_NOTE);
    expect(notchTurnNote('notch-typed-abc')).toBe(NOTCH_TURN_NOTE);
    expect(notchTurnNote('req-123')).toBeUndefined();
    expect(notchTurnNote('x-notch-typed-abc')).toBeUndefined();
    delete process.env[NOTCH_SWITCH];
    expect(notchTurnNote('notch-spoken-abc')).toBeUndefined();
  });

  test('it says an app is opened without asking, and what still needs a yes', () => {
    expect(NOTCH_TURN_NOTE).toContain('Opening an app needs no approval');
    expect(NOTCH_TURN_NOTE).toContain('do not call request_approval before opening an app');
    for (const still of ['deletes', 'sends an email or a message', 'pays', 'installs or removes software', 'changes a setting']) {
      expect(NOTCH_TURN_NOTE).toContain(still);
    }
    // A send or a payment made by a click is still one: the model must say so first.
    expect(NOTCH_TURN_NOTE).toContain('a click or a key press in an app or a browser that sends or pays is a send or a payment');
    expect(NOTCH_TURN_NOTE).not.toContain('clicking where they told you to');
  });
});

describe('the plain words of an approval, as the model gave them', () => {
  test('one question, cleaned of what a model wraps it in', () => {
    expect(approvalWords('Look up where Steam is installed?')).toBe('Look up where Steam is installed?');
    expect(approvalWords('"Type this poem into Notepad"\n\nIt will not be saved.')).toBe('Type this poem into Notepad?');
    expect(approvalWords('**Open Steam.**')).toBe('Open Steam?');
    expect(approvalWords('  `Delete the file notes.txt?`  ')).toBe('Delete the file notes.txt?');
  });

  test('nothing usable is nothing', () => {
    expect(approvalWords('')).toBeNull();
    expect(approvalWords('???')).toBeNull();
    expect(approvalWords('ok')).toBeNull();
  });

  test('a run-on answer is cut, and says so', () => {
    const cut = approvalWords(`Do ${'this and that and '.repeat(20)}more?`)!;
    expect([...cut].length).toBe(110);
    expect(cut.endsWith('…')).toBe(true);
  });
});
