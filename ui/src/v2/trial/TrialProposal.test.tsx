/**
 * The one line on the proposal card that says where its contents came from.
 *
 * D44 moved the file beats to the front, so from `goals` onward most of what
 * is on a card was read out of the founder's own documents rather than heard
 * in the conversation. A card that still said "from what you told me" over a
 * quarter built out of their own plan would contradict, on screen, the single
 * claim the reorder exists to make.
 *
 * Rendered through the real component rather than asserted against a copy of
 * its markup: the branch under test is a ternary inside it, and a hand-written
 * fixture would keep passing after the component stopped agreeing with it.
 */

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrialProposal } from './TrialProposal';
import type { BeatProposal, FilesProposal, GoalProposal } from './conductorSession';

const text = (p: BeatProposal): string =>
  renderToStaticMarkup(<TrialProposal proposal={p} landed={null} />)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const GOALS: GoalProposal = {
  beat: 'goals',
  objective: '40 paying customers by the end of Q3',
  deadline: null,
  deadlineLabel: 'end of Q3',
  keyResults: [{ title: '12 booked demos a month', target: '12', today: '4' }],
  firstMove: null,
};

const FILES: FilesProposal = {
  beat: 'files',
  folder: '/home/founder/Acme',
  says: 'C:\\Users\\founder\\Acme',
  what: '824 files in 98 folders, of which the 40 most recent of 192 would be read',
  sample: ['pitch.md', 'numbers.csv'],
  willRead: 40,
  total: 824,
};

describe('where the card says its contents came from', () => {
  test('a quarter built out of their own documents says so', () => {
    expect(text({ ...GOALS, fromFiles: true })).toContain('from your own files, and what you told me');
  });

  test('and a quarter built out of the conversation does not claim otherwise', () => {
    const t = text(GOALS);
    expect(t).toContain('from what you told me');
    expect(t).not.toContain('your own files');
  });

  test('the approval card is unchanged: the folder, the counts, real filenames, nothing read', () => {
    const t = text(FILES);
    // D44 kept every number on this card and rewrote only the sentence Jarvis
    // says around it. If this drifts, the ask stopped being checkable.
    expect(t).toContain('nothing read yet');
    expect(t).toContain('C:\\Users\\founder\\Acme');
    expect(t).toContain('40 of 824');
    expect(t).toContain('pitch.md');
    expect(t).toContain('Nothing of yours is moved, changed or deleted');
    expect(t).toContain('waiting on you');
    // And the one claim on this card that was never ours to make. The reader
    // is a language model; "sent anywhere" was false and the ask now happens
    // on a tenth of the credit it used to.
    expect(t).not.toMatch(/sent anywhere|never leaves|stays on your machine/i);
  });
});
