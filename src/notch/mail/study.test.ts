import { describe, expect, test } from 'bun:test';
import { mailPerson, type MailMessage, type MailThread } from './thread.ts';
import { studyHowLong, studyLine, studyMoments, studyOrder, studyReplay, studyResult, type StudyMark, type StudyMoment, type StudyTried } from './study.ts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 9, 0);
const me = mailPerson('Sam Rossi', 'sam@northwind.example');
const owner = new Set([me.address]);
const leo = mailPerson('Leo Bianchi', 'leo@lumen.example');
const anna = mailPerson('Anna Conti', 'anna@lumen.example');

const message = (from = leo, hoursAgo = 24, text = 'Does Thursday work?', extra: Partial<MailMessage> = {}): MailMessage =>
  ({ from, to: [from === me ? leo : me], cc: [], at: NOW - hoursAgo * HOUR, text, ...extra });
const thread = (id: string, messages: MailMessage[], extra: Partial<MailThread> = {}): MailThread => ({ id, subject: 'A subject', messages, ...extra });

describe('the moments a proposal would have been made', () => {
  test('a message still unanswered today is one, four hours after it came', () => {
    const { moments } = studyMoments([thread('a', [message(leo, 24)])], owner, NOW);
    expect(moments).toEqual([{ thread: 'a', message: 0, at: NOW - 20 * HOUR, who: leo, live: true, after: { kind: 'nothing' } }]);
  });

  test('one the owner answered late is one, with what they really wrote; one answered in time is not', () => {
    const late = thread('late', [message(leo, 100), message(me, 50, 'Yes, Thursday.')]);
    const quick = thread('quick', [message(leo, 100), message(me, 98, 'Yes.')]);
    const { moments } = studyMoments([late, quick], owner, NOW);
    expect(moments).toEqual([{
      thread: 'late', message: 0, at: NOW - 96 * HOUR, who: leo, live: false,
      after: { kind: 'owner-replied', afterMs: 50 * HOUR, text: 'Yes, Thursday.' },
    }]);
  });

  test('someone else writing next is told apart, and a nudge within the wait moves the moment to the nudge', () => {
    const nudged = thread('n', [message(leo, 100), message(leo, 99, 'Any news?'), message(anna, 40, 'Me too?', { to: [me] })]);
    const { moments } = studyMoments([nudged], owner, NOW);
    expect(moments.map((moment) => [moment.message, moment.after.kind, moment.live])).toEqual([[1, 'other-wrote', false], [2, 'nothing', true]]);
  });

  // As if live: a moment in the past is judged on what was there then.
  test('a past moment does not see a draft made since, and the present one does', () => {
    const drafted = thread('d', [message(leo, 100), message(me, 50), message(leo, 24)], { draft: true });
    const { moments, ruled } = studyMoments([drafted], owner, NOW);
    expect(moments.map((moment) => moment.message)).toEqual([0]);
    expect(ruled).toEqual({ draft: 1 });
  });

  test('counts why the last message of each other thread is not one', () => {
    const { moments, ruled } = studyMoments([
      thread('mine', [message(leo, 30), message(me, 28)]),
      thread('shop', [message(mailPerson('Shop', 'noreply@shop.example'), 24)]),
      thread('new', [message(leo, 1)]),
      thread('copied', [message(leo, 24, 'FYI', { to: [anna], cc: [me] })]),
    ], owner, NOW);
    expect(moments).toEqual([]);
    expect(ruled).toEqual({ 'owner-last': 1, machine: 1, 'too-new': 1, 'not-addressed': 1 });
  });
});

describe('the order they are put to the proposer', () => {
  const moment = (name: string, live: boolean, kind: StudyMoment['after']['kind'], at = 0): StudyMoment => ({
    thread: name, message: at, at: NOW, who: leo, live,
    after: kind === 'nothing' ? { kind } : kind === 'owner-replied' ? { kind, afterMs: HOUR, text: 'x' } : { kind, afterMs: HOUR },
  });
  const many = [
    ...Array.from({ length: 6 }, (_, at) => moment(`live${at}`, true, 'nothing')),
    ...Array.from({ length: 3 }, (_, at) => moment(`late${at}`, false, 'owner-replied')),
    moment('other0', false, 'other-wrote'),
    moment('live0', false, 'owner-replied', -1),
  ];

  test('one per thread, its latest, and the kinds by turns', () => {
    const order = studyOrder(many, 7);
    expect(order.length).toBe(10);
    expect(order.filter((entry) => entry.thread === 'live0')).toEqual([many[0]!]);
    expect(order.slice(0, 3).map((entry) => entry.thread.replace(/\d/, ''))).toEqual(['live', 'late', 'other']);
    expect(order.slice(3, 5).map((entry) => entry.thread.replace(/\d/, ''))).toEqual(['live', 'late']);
  });

  test('the same for the same seed, whatever order they came in, and different for another', () => {
    const again = studyOrder([...many].reverse(), 7).map((entry) => entry.thread);
    expect(again).toEqual(studyOrder(many, 7).map((entry) => entry.thread));
    expect(studyOrder(many, 8).map((entry) => entry.thread)).not.toEqual(again);
  });
});

describe('the score', () => {
  const ids = Array.from({ length: 40 }, (_, at) => `p${at}`);
  const marks = (useful: number, not: number, wrong: StudyMark[] = []): Record<string, StudyMark> => {
    const all: StudyMark[] = [...Array<StudyMark>(useful).fill({ score: 'useful' }), ...Array<StudyMark>(not).fill({ score: 'not' }), ...wrong];
    return Object.fromEntries(all.map((mark, at) => [ids[at]!, mark]));
  };

  test('says nothing until thirty are scored', () => {
    expect(studyResult(marks(29, 0), ids)).toMatchObject({ scored: 29, passes: null });
    expect(studyResult(marks(3, 0), ids.slice(0, 3)).passes).toBe(true);
  });

  test('passes at sixty percent useful with none to the wrong person', () => {
    expect(studyResult(marks(18, 12), ids)).toMatchObject({ scored: 30, useful: 18, passes: true });
    expect(studyResult(marks(17, 13), ids)).toMatchObject({ passes: false, why: '57% useful, under 60%.' });
  });

  // The gate is not passed on a guess: a "wrong" that does not say which kind counts against it.
  test('one to the wrong person fails it whatever the share, and wrong content alone does not', () => {
    expect(studyResult(marks(35, 0, [{ score: 'wrong', wrong: 'person' }]), ids)).toMatchObject({ passes: false, wrongPerson: 1 });
    expect(studyResult(marks(35, 0, [{ score: 'wrong' }]), ids)).toMatchObject({ passes: false, wrongPerson: 1 });
    expect(studyResult(marks(35, 0, [{ score: 'wrong', wrong: 'content' }]), ids)).toMatchObject({ passes: true, wrong: 1, wrongPerson: 0 });
  });

  test('marks for rows that are not in the sheet are not counted', () => {
    expect(studyResult({ ...marks(30, 0), stray: { score: 'wrong' } }, ids).passes).toBe(true);
  });
});

describe('the words', () => {
  test('the line and how long', () => {
    expect(studyLine(leo)).toBe('You have not replied to Leo. I drafted a reply.');
    expect([studyHowLong(30_000), studyHowLong(59 * 60_000), studyHowLong(4 * HOUR), studyHowLong(23.6 * HOUR), studyHowLong(72 * HOUR)])
      .toEqual(['1 minute', '59 minutes', '4 hours', '1 day', '3 days']);
  });
});

describe('the replay', () => {
  const threads = [
    thread('late', [message(leo, 100, 'Can you send the deck?'), message(me, 50, 'Here it is. Sam')]),
    thread('live', [message(me, 200, 'An old note of mine, long enough to be a sample. Sam'), message(anna, 30, 'Is Friday fine?', { to: [me], cc: [leo] })]),
    thread('thanks', [message(leo, 26, 'Thanks, got it!')]),
    thread('garbled', [message(leo, 25, 'Hello?')]),
  ];
  const model = (asked: string[]) => async (messages: { content: string }[]) => {
    const user = messages[1]!.content;
    asked.push(user);
    const content = user.includes('Thanks, got it!') ? '{"needs_reply": false, "why": "Thanks only."}'
      : user.includes('Hello?') ? 'I am not sure.'
      : '{"needs_reply": true, "why": "A question.", "reply": "Yes.\\nSam", "missing": "", "time": ""}';
    return { content, model: 'a-model', input: 500, output: 20, cached: 0 };
  };
  const run = (extra: Partial<Parameters<typeof studyReplay>[0]> = {}, asked: string[] = []) =>
    studyReplay({ threads, owner, ownerName: 'Sam', calendar: null, now: NOW, zone: 'UTC', want: 10, most: 10, think: model(asked), ...extra });

  test('makes a row for each reply the model wrote, and counts the ones it did not', async () => {
    const tried = await run();
    expect(tried.map((entry) => [entry.id, entry.outcome]).sort()).toEqual([['garbled-0', 'failed'], ['late-0', 'proposed'], ['live-1', 'proposed'], ['thanks-0', 'silent']]);
    const live = tried.find((entry) => entry.id === 'live-1')!.proposal!;
    expect(live).toMatchObject({
      line: 'You have not replied to Anna. I drafted a reply.', first: 'Anna', to: [anna], cc: [leo], draft: 'Yes.\nSam',
      waited: '4 hours', live: true, earlier: 1, after: { kind: 'nothing' }, last: { from: anna, text: 'Is Friday fine?' },
    });
    expect(tried.find((entry) => entry.id === 'late-0')!.proposal!.after).toEqual({ kind: 'owner-replied', after: '2 days', text: 'Here it is. Sam' });
  });

  // As if live: the model must not be shown the reply the owner went on to write.
  test('a past moment is read as it stood: no later message, no later writing of the owner', async () => {
    const asked: string[] = [];
    await run({}, asked);
    const late = asked.find((user) => user.includes('Can you send the deck?'))!;
    expect(late).not.toContain('Here it is. Sam');
    expect(late).toContain('It is Tue, 10 Nov 2026, 09:00.');
    // Written 200 hours before now, so before that moment: it may be used as a sample.
    expect(late).toContain('An old note of mine');
  });

  test('stops once it has what it wants, and never asks more than the most', async () => {
    const asked: string[] = [];
    const tried = await run({ want: 1, parallel: 1 }, asked);
    expect(tried.filter((entry) => entry.outcome === 'proposed').length).toBe(1);
    expect(asked.length).toBeLessThan(4);
    const capped: string[] = [];
    expect((await run({ most: 2, parallel: 4 }, capped)).length).toBe(2);
    expect(capped.length).toBe(2);
  });

  test('does not ask again about what an earlier run tried, and tells of each as it goes', async () => {
    const first = await run();
    const asked: string[] = [];
    const told: StudyTried[] = [];
    const again = await run({ already: first, each: (entry) => { told.push(entry); } }, asked);
    expect(asked).toEqual([]);
    expect(told).toEqual([]);
    expect(again.length).toBe(4);
    const some: StudyTried[] = [];
    await run({ already: first.slice(0, 1), each: (entry) => { some.push(entry); } });
    expect(some.length).toBe(3);
  });

  test('gives the model the days after the moment when a calendar is connected', async () => {
    const asked: string[] = [];
    await run({ calendar: [
      { summary: 'Before the moment', start: '2026-11-01T10:00:00Z', end: '2026-11-01T11:00:00Z' },
      { summary: 'Board call', start: '2026-11-16T10:00:00Z', end: '2026-11-16T11:00:00Z' },
      { summary: 'Far away', start: '2026-12-20T10:00:00Z', end: '2026-12-20T11:00:00Z' },
    ] }, asked);
    const live = asked.find((user) => user.includes('Is Friday fine?'))!;
    expect(live).toContain('Board call');
    expect(live).not.toContain('Before the moment');
    expect(live).not.toContain('Far away');
  });
});
