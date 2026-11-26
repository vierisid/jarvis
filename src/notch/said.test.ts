import { describe, expect, test } from 'bun:test';
import type { NotchLine, NotchPart, NotchWord } from './protocol.ts';
import { runItBegins } from './teach.ts';
import { NOTCH_SAID_KEYS_MS, attachNotchSaid, notchLineReads, notchLineWords, saidAbout, saidOption, saidWhen, saidWords, type NotchSaid } from './said.ts';

const word = (name: string, value: string, options: string[], more: Partial<NotchWord> = {}): NotchPart => ({ word: { name, value, options, ...more } });
const offer = (say: NotchPart[], more: Record<string, unknown> = {}): NotchLine => ({ id: 'l1', kind: 'offer', say, ...more } as NotchLine);

describe('what was said, as words', () => {
  test('numbers said as words are digits, and the marks of a sentence are gone', () => {
    expect(saidWords('Friday at ten works.')).toEqual(['friday', 'at', '10', 'works']);
    expect(saidWords("Let's make it 3 p.m., please!")).toEqual(['lets', 'make', 'it', '3', 'pm', 'please']);
    expect(saidWords('Half past nine')).toEqual(['half', 'past', '9']);
    expect(saidWords('at 9.30 or 10h15')).toEqual(['at', '9:30', 'or', '10:15']);
    expect(saidWords("ten o'clock")).toEqual(['10']);
  });

  test('a day and a time are read as they are said', () => {
    const when = (said: string): string => { const read = saidWhen(saidWords(said)); return `${read.day ?? '-'} ${read.time ?? '-'} ${read.part ?? '-'}`; };
    expect(when('Friday at ten')).toBe('Friday 10:00 -');
    expect(when('make it fri at 10:30')).toBe('Friday 10:30 -');
    expect(when('half past nine on Monday')).toBe('Monday 9:30 -');
    expect(when('quarter to ten')).toBe('- 9:45 -');
    expect(when('quarter past three')).toBe('- 15:15 -');
    expect(when('nine thirty')).toBe('- 9:30 -');
    expect(when('nine forty five')).toBe('- 9:45 -');
    expect(when('three pm')).toBe('- 15:00 -');
    expect(when('3 p.m.')).toBe('- 15:00 -');
    expect(when('seven am')).toBe('- 7:00 -');
    expect(when('twelve am')).toBe('- 0:00 -');
    // An hour from one to seven with nothing beside it is the afternoon.
    expect(when('tomorrow at three')).toBe('tomorrow 15:00 -');
    expect(when('at eight')).toBe('- 8:00 -');
    expect(when('noon')).toBe('- 12:00 -');
    expect(when('Friday afternoon')).toBe('Friday - afternoon');
    expect(when('three in the afternoon')).toBe('- 15:00 -');
    expect(when('the report')).toBe('- - -');
    expect(when('25')).toBe('- - -');
  });
});

describe('a choice said by voice', () => {
  const times = ['Thursday at 15:00', 'Friday at 10:00', 'Monday at 9:30'];

  test('the prototype\'s sentence picks its time', () => {
    expect(saidOption(times, 'Friday at ten works')).toBe(1);
    expect(saidOption(times, 'Friday at 10 works.')).toBe(1);
    expect(saidOption(times, 'Monday at nine thirty')).toBe(2);
    expect(saidOption(times, 'half past nine on Monday please')).toBe(2);
    expect(saidOption(times, 'Thursday at three')).toBe(0);
    expect(saidOption(times, 'thursday at 3 pm is fine')).toBe(0);
  });

  test('the day alone, the hour alone, or the part of the day, when only one of them has it', () => {
    expect(saidOption(times, 'Friday')).toBe(1);
    expect(saidOption(times, 'make it Monday')).toBe(2);
    expect(saidOption(times, 'ten works')).toBe(1);
    expect(saidOption(times, 'the afternoon')).toBe(0);
    // Two of them are in the morning: that names neither.
    expect(saidOption(times, 'the morning')).toBe(-1);
    expect(saidOption(['Friday at 10:00', 'Friday at 15:00'], 'Friday')).toBe(-1);
    expect(saidOption(['Friday at 10:00', 'Friday at 15:00'], 'Friday afternoon')).toBe(1);
  });

  test('a day or an hour that is not among them picks nothing', () => {
    expect(saidOption(times, 'Tuesday at ten')).toBe(-1);
    expect(saidOption(times, 'Friday at eleven')).toBe(-1);
    expect(saidOption(times, 'next week')).toBe(-1);
  });

  test('by its place: the first, the second one, the last', () => {
    expect(saidOption(times, 'the second one')).toBe(1);
    expect(saidOption(times, 'first')).toBe(0);
    expect(saidOption(times, 'the last one please')).toBe(2);
    expect(saidOption(times, 'the fourth')).toBe(-1);
  });

  test('choices that are words: said in full, or by a word only one of them has', () => {
    const ways = ['Go on', 'Undo it', 'Leave it'];
    expect(saidOption(ways, 'go on')).toBe(0);
    expect(saidOption(ways, 'Go on.')).toBe(0);
    expect(saidOption(ways, 'undo that')).toBe(1);
    expect(saidOption(ways, 'leave it')).toBe(2);
    expect(saidOption(ways, 'just leave it please')).toBe(2);
    const stuck = ['Call Sam', 'Wait until Monday', 'Let it go'];
    expect(saidOption(stuck, 'wait')).toBe(1);
    expect(saidOption(stuck, 'wait until Monday')).toBe(1);
    expect(saidOption(stuck, 'call him')).toBe(0);
    expect(saidOption(stuck, 'let it go')).toBe(2);
    expect(saidOption(['Yes', 'No'], 'yes')).toBe(0);
    expect(saidOption(['Yes', 'No'], 'no')).toBe(1);
    expect(saidOption(['politely', 'firmly'], 'be firm with them')).toBe(1);
  });

  test('everything said has to be about the choice: an instruction that shares a word with one is not a pick', () => {
    expect(saidOption(times, 'open the Friday report')).toBe(-1);
    expect(saidOption(times, 'what do I have on Friday at ten')).toBe(-1);
    expect(saidOption(['Call Sam', 'Wait until Monday', 'Let it go'], 'call Sam on Monday about the contract')).toBe(-1);
    expect(saidOption(['Go on', 'Undo it', 'Leave it'], 'undo the last paste in the sheet')).toBe(-1);
    expect(saidOption(['Go on', 'Undo it', 'Leave it'], 'go')).toBe(-1);
    expect(saidOption(times, '')).toBe(-1);
    expect(saidOption(times, 'Friday at ten works for me but please also tell Anna that the deck is not ready yet')).toBe(-1);
  });
});

describe('what was said, as an answer to the line that was up', () => {
  test('a line of choices takes the pick, with its place, and no yes', () => {
    const line = offer(['Anna asked to move Thursday. Offer a slot?'], { options: ['Thursday at 15:00', 'Friday at 10:00', 'Monday at 9:30'] });
    expect(saidAbout(line, 'Friday at ten works')).toEqual([{ act: 'pick', option: 'Friday at 10:00', index: 1 }]);
    expect(saidAbout(line, 'yes')).toBeNull();
    expect(saidAbout(line, 'remind me to call Anna')).toBeNull();
  });

  test('a lit word takes its value: one of its choices, said the way people say it', () => {
    const line = offer(['Acme is ', { em: '9 days' }, ' late. Chase ', word('tone', 'politely', ['politely', 'firmly']), '?'], { yes: 'draft' });
    expect(saidAbout(line, 'Be firm with them')).toEqual([{ act: 'word', word: 'tone', value: 'firmly' }]);
    expect(saidAbout(line, 'firmly')).toEqual([{ act: 'word', word: 'tone', value: 'firmly' }]);
    // What it says already: about the line, and nothing to change.
    expect(saidAbout(line, 'be polite')).toEqual([]);
    expect(saidAbout(line, 'be firm and tell them the contract ends in March')).toBeNull();
  });

  test('a word that holds a day, or a day and a time, takes them as they are said', () => {
    const by = offer(['I will get ', { em: "Sam's answer" }, ' by ', word('by', 'Friday', ['Friday', 'tomorrow', 'next week'], { read: 'day' }), '. Go?'], { yes: 'go' });
    expect(saidAbout(by, 'make it Monday')).toEqual([{ act: 'word', word: 'by', value: 'Monday' }]);
    expect(saidAbout(by, 'by tomorrow')).toEqual([{ act: 'word', word: 'by', value: 'tomorrow' }]);
    expect(saidAbout(by, 'next week')).toEqual([{ act: 'word', word: 'by', value: 'next week' }]);
    const when = offer(['Thursday review with Anna at ', word('when', 'Thursday at 10:00', ['Thursday at 10:00'], { read: 'dayTime' }), '?'], { yes: 'add' });
    expect(saidAbout(when, 'Make it Friday at ten')).toEqual([{ act: 'word', word: 'when', value: 'Friday at 10:00' }]);
    expect(saidAbout(when, 'make it Friday afternoon')).toEqual([{ act: 'word', word: 'when', value: 'Friday at 15:00' }]);
    // The hour alone keeps the day, the day alone keeps the hour.
    expect(saidAbout(when, 'at three')).toEqual([{ act: 'word', word: 'when', value: 'Thursday at 15:00' }]);
    expect(saidAbout(when, 'Friday')).toEqual([{ act: 'word', word: 'when', value: 'Friday at 10:00' }]);
    const every = offer(['Do it every ', word('when', 'Monday at 9:00', ['Monday at 9:00', 'day at 9:00'], { read: 'sched' }), '?'], { yes: 'yes' });
    // "Every" is read with the day it stands before (./when.ts), and a weekday is Monday to Friday.
    expect(saidAbout(every, 'every Friday at eight')).toEqual([{ act: 'word', word: 'when', value: 'Friday at 8:00' }]);
    expect(saidAbout(every, 'every weekday at nine')).toEqual([{ act: 'word', word: 'when', value: 'Monday to Friday at 9:00' }]);
    expect(saidAbout(every, 'every morning at six')).toEqual([{ act: 'word', word: 'when', value: 'day at 6:00' }]);
    expect(saidAbout(every, 'make it every night at eleven')).toEqual([{ act: 'word', word: 'when', value: 'day at 23:00' }]);
    // A schedule the notch cannot say changes nothing on the line: it is not made into one that is near it.
    for (const no of ['every 2 weeks at nine', 'every other Friday at eight', 'every month', 'every morning at 6 pm']) expect(saidAbout(every, no)).toBeNull();
    // And a word that takes one day, or one moment, takes no time by the week.
    expect(saidAbout(by, 'every weekday')).toBeNull();
    expect(saidAbout(when, 'every Friday at ten')).toBeNull();
    expect(saidAbout(every, 'Friday at eight')).toEqual([{ act: 'word', word: 'when', value: 'Friday at 8:00' }]);
  });

  test('two words in one breath: each takes its own, and together they account for all that was said', () => {
    const line = offer(['Send it ', word('when', 'Thursday at 10:00', ['Thursday at 10:00'], { read: 'dayTime' }), ', ', word('tone', 'yours', ['yours', 'short', 'warm', 'formal']), '?'], { yes: 'send' });
    expect(saidAbout(line, 'Make it Friday at ten and keep it short')).toEqual([{ act: 'word', word: 'when', value: 'Friday at 10:00' }, { act: 'word', word: 'tone', value: 'short' }]);
    expect(saidAbout(line, 'Make it Friday at ten and attach the deck')).toBeNull();
  });

  test('another way of saying a choice is read when the word names one', () => {
    const line = offer(['Chase ', word('tone', 'politely', ['politely', 'firmly'], { syn: { firmly: ['hard', 'strict'], politely: ['nice', 'gentle'] } }), '?'], { yes: 'draft' });
    expect(saidAbout(line, 'be strict')).toEqual([{ act: 'word', word: 'tone', value: 'firmly' }]);
    expect(saidAbout(line, 'be gentle with them')).toEqual([]);
  });

  test('a yes is the whole of what was said, or the word on the line\'s own key', () => {
    const line = offer(['Leo asked for the October revenue. Reply to him here with the number?'], { yes: 'reply' });
    for (const yes of ['Yes, go ahead.', 'go ahead', 'do it', 'okay, do it', 'yes please', 'reply', 'Reply.', 'reply it', 'yes reply']) expect(saidAbout(line, yes)).toEqual([{ act: 'yes' }]);
    for (const no of ['not now', 'No, thanks.', 'skip it', 'leave it']) expect(saidAbout(line, no)).toEqual([{ act: 'no' }]);
    // One word of the kind a speech-to-text hears in a silence answers nothing: an approval is not given by a noise.
    for (const noise of ['yes', 'Yes.', 'Okay.', 'ok', 'yeah', 'sure', 'no', 'No.', 'thank you', 'Thank you.', 'bye', 'you', 'later', 'skip']) expect(saidAbout(line, noise)).toBeNull();
    // More than a yes is an instruction, not an answer.
    for (const more of ['yes and also tell Sam', 'reply to him tomorrow instead', 'no I mean the September one', 'ok open the deck']) expect(saidAbout(line, more)).toBeNull();
    // A line with no yes key takes no spoken yes.
    expect(saidAbout({ id: 'l2', kind: 'say', say: ['Sent to Leo.'], ms: 2000 } as NotchLine, 'yes')).toBeNull();
  });

  test('a word that takes a sentence is not filled from a few words, and a sheet\'s words are found in its rows', () => {
    const sheet = { id: 's1', kind: 'sheet', say: ['After the call with Sam'], blocks: [
      { kind: 'row', say: ['Send pricing  ', word('owner-0', 'mine', ['mine', 'theirs', 'nobody'])] },
      { kind: 'note', say: ['Not what you would say? ', word('told', 'tell me', ['say no', 'say yes'], { free: true, long: true })] },
    ], yes: 'send' } as unknown as NotchLine;
    expect(notchLineWords(sheet).map((one) => one.name)).toEqual(['owner-0', 'told']);
    expect(saidAbout(sheet, 'theirs')).toEqual([{ act: 'word', word: 'owner-0', value: 'theirs' }]);
    expect(saidAbout(sheet, 'say no')).toBeNull();
  });

  test('the same line shown again reads the same, and another does not', () => {
    const a = offer(['Chase ', word('tone', 'politely', ['politely', 'firmly']), '?'], { yes: 'draft' });
    const b = offer(['Chase ', word('tone', 'politely', ['politely', 'firmly']), '?'], { yes: 'draft', id: 'another' });
    expect(notchLineReads(a)).toBe(notchLineReads(b));
    expect(notchLineReads(offer(['Chase ', word('tone', 'firmly', ['politely', 'firmly']), '?']))).not.toBe(notchLineReads(a));
    expect(notchLineReads(offer(['Pick?'], { options: ['A', 'B'] }))).not.toBe(notchLineReads(offer(['Pick?'], { options: ['A', 'C'] })));
  });
});

describe('the line the talk keys were pressed over', () => {
  const choice = offer(['Stopped at row 4. What now?'], { options: ['Go on', 'Undo it', 'Leave it'] });
  function harness(start: { item: string | null; line: NotchLine | null } = { item: 'job', line: choice }) {
    const state = { ...start, now: 1000, replays: [] as [string, string, NotchSaid[]][], takes: true, logs: [] as string[] };
    const said = attachNotchSaid({
      inbox: { showing: () => state.item, replay: (id, reads, answers) => { state.replays.push([id, reads, [...answers]]); return state.takes; } },
      line: () => state.line,
      skip: (item) => item.startsWith('ask:'),
      now: () => state.now,
      log: (line) => { state.logs.push(line); },
    });
    return { said, state };
  }

  test('what is said with those keys answers it: the item is brought back with the answer', () => {
    const h = harness();
    h.said.keys();
    const route = h.said.route('undo it', { source: 'spoken', at: 1000 });
    expect(route?.did).toBe('Picked "Undo it" on the line that was up.');
    // Nothing happens until it is run.
    expect(h.state.replays).toEqual([]);
    route!.run();
    expect(h.state.replays).toEqual([['job', notchLineReads(choice), [{ act: 'pick', option: 'Undo it', index: 1 }]]]);
    // Once: the next thing said is not about that line any more.
    expect(h.said.route('go on', { source: 'spoken', at: 1000 })).toBeNull();
  });

  test('what is said that is not about it is an instruction, and the line is not brought back', () => {
    const h = harness();
    h.said.keys();
    expect(h.said.route('open the Q3 deck', { source: 'spoken', at: 1000 })).toBeNull();
    expect(h.state.replays).toEqual([]);
  });

  test('typed words, an offer taken, and words said with other keys are never about it', () => {
    const h = harness();
    h.said.keys();
    expect(h.said.route('undo it', { source: 'typed', at: 1000 })).toBeNull();
    expect(h.said.route('undo it', { source: 'offered', at: 1000 })).toBeNull();
    expect(h.said.route('undo it')).toBeNull();
    // The keys of a later recording: the line was not what they were pressed over.
    expect(h.said.route('undo it', { source: 'spoken', at: 1000 + NOTCH_SAID_KEYS_MS + 1 })).toBeNull();
    expect(h.said.route('undo it', { source: 'spoken', at: 1000 + NOTCH_SAID_KEYS_MS })).not.toBeNull();
  });

  test('keys pressed over nothing, over Home, over a result, over mail or over an instruction\'s own line remember no line', () => {
    for (const start of [
      { item: null, line: null },
      { item: null, line: choice },
      { item: 'news', line: { id: 'r', kind: 'say', say: ['Sent to Leo.'], ms: 2000 } as NotchLine },
      { item: 'mail', line: offer(['Leo asked for a time. Offer a slot?'], { options: ['Friday at 10:00', 'Monday at 9:30'], src: 'mail' }) },
      { item: 'ask:7', line: choice },
    ]) {
      const h = harness(start);
      h.said.keys();
      expect(h.said.route('go on', { source: 'spoken', at: 1000 })).toBeNull();
      expect(h.said.route('Friday at ten', { source: 'spoken', at: 1000 })).toBeNull();
    }
  });

  test('new keys forget the line of the keys before', () => {
    const h = harness();
    h.said.keys();
    h.state.item = null;
    h.state.line = null;
    h.state.now = 5000;
    h.said.keys();
    expect(h.said.route('undo it', { source: 'spoken', at: 5000 })).toBeNull();
  });

  test('the line is remembered as it was: what is shown later does not change what was answered', () => {
    const live = offer(['Chase ', word('tone', 'politely', ['politely', 'firmly']), '?'], { yes: 'draft' });
    const h = harness({ item: 'chase', line: live });
    h.said.keys();
    (live.say[1] as { word: { value: string } }).word.value = 'firmly';
    expect(h.said.route('be firm', { source: 'spoken', at: 1000 })?.did).toBe('Changed the line that was up: firmly.');
  });

  test('a yes, a no, and "as it is" are said in the ledger as what they are, and what was said reaches no log', () => {
    const line = offer(['Leo asked for the October revenue. Reply to him here with the number?'], { yes: 'reply' });
    const h = harness({ item: 'notice:1', line });
    h.said.keys();
    expect(h.said.route('yes, go ahead', { source: 'spoken', at: 1000 })?.did).toBe('Said yes to the line that was up.');
    expect(h.said.route('not now', { source: 'spoken', at: 1000 })?.did).toBe('Said no to the line that was up.');
    const words = harness({ item: 'chase', line: offer(['Chase ', word('tone', 'politely', ['politely', 'firmly']), '?'], { yes: 'draft' }) });
    words.said.keys();
    const same = words.said.route('be polite', { source: 'spoken', at: 1000 });
    expect(same?.did).toBe('Brought back the line that was up.');
    same!.run();
    expect(words.state.replays[0]![2]).toEqual([]);
    h.said.route('yes, go ahead', { source: 'spoken', at: 1000 })!.run();
    for (const entry of [...h.state.logs, ...words.state.logs]) { expect(entry).not.toContain('polite'); expect(entry).not.toContain('go ahead'); }
    // And when the item cannot be brought back, that is what the log says.
    const gone = harness();
    gone.state.takes = false;
    gone.said.keys();
    gone.said.route('go on', { source: 'spoken', at: 1000 })!.run();
    expect(gone.state.logs.at(-1)).toContain('could not be brought back');
  });
});

// The second review of fix 03: an answer over a line stood before every command, so "undo" picked a choice that
// read "Undo it" and "do 3 more" became three o'clock on an offer.
describe('what is said over a line, as intents of the one table', () => {
  function over(line: NotchLine, job = false) {
    const replayed: unknown[] = [];
    const said = attachNotchSaid({
      inbox: { showing: () => 'thing', replay: (_id, _reads, answers) => { replayed.push(answers); return true; } }, line: () => line, now: () => 1000, log: () => {},
      // As ./real.ts gives it: the words begin as a job's, and there is a job.
      jobWords: (text) => job && runItBegins(text),
    });
    said.keys();
    const [yes, answer] = said.intents();
    const how = { source: 'spoken' as const, at: 1000 };
    return { yes: (text: string) => yes!.match(text, how)?.did ?? null, answer: (text: string) => answer!.match(text, how)?.did ?? null, intents: said.intents(), replayed };
  }
  const sched: NotchLine = { id: 'l', kind: 'offer', say: ['Every ', { word: { name: 'when', value: 'day at 9:00', options: ['day at 9:00'], read: 'sched' } }, ', send me the news.'], yes: 'make agent' };

  test('a plain yes is one intent, which stands with what is up; everything else is another, which is asked last', () => {
    const h = over(sched);
    expect(h.intents.map((one) => [one.id, one.band, one.act])).toEqual([['said.yes', 'up', 'answer'], ['said.answer', 'said', 'answer']]);
    for (const words of ['do it', 'yes do it', 'go ahead', 'ok do it', 'please do']) expect([words, h.yes(words), h.answer(words)]).toEqual([words, 'Said yes to the line that was up.', null]);
    // The word on the line's own key is a yes too, and is asked last: another part may have that very word.
    expect([h.yes('make agent'), h.answer('make agent')]).toEqual([null, 'Said yes to the line that was up.']);
    expect([h.yes('not now'), h.answer('not now')]).toEqual([null, 'Said no to the line that was up.']);
    expect([h.yes('make it Friday at ten'), h.answer('make it Friday at ten')]).toEqual([null, 'Changed the line that was up: Friday at 10:00.']);
  });

  test('with a job that was shown, a new time is not read out of words that begin as the words for that job', () => {
    const h = over(sched, true);
    for (const words of ['do 3 more', 'do it at 5', 'run it at 6', 'continue at 4', 'do the rest at 5']) expect([words, h.yes(words), h.answer(words)]).toEqual([words, null, null]);
    for (const [words, value] of [['make it 5', 'day at 17:00'], ['at 5', 'day at 17:00'], ['do Friday at ten', 'Friday at 10:00']] as const) expect([words, h.answer(words)]).toEqual([words, `Changed the line that was up: ${value}.`]);
  });

  test('with no job to mean, the same words change the time, as they always did', () => {
    const h = over(sched);
    expect(h.answer('do 3 more')).toBe('Changed the line that was up: day at 15:00.');
    expect(h.answer('do it at 5')).toBe('Changed the line that was up: day at 17:00.');
    // And a part that was told nothing about jobs reads them as ever.
    const plain = attachNotchSaid({ inbox: { showing: () => 'thing', replay: () => true }, line: () => sched, now: () => 1000, log: () => {} });
    plain.keys();
    expect(plain.route('do it at 5', { source: 'spoken', at: 1000 })?.did).toBe('Changed the line that was up: day at 17:00.');
  });

  test('a choice that reads like the words for a job can still be picked by them: only a new value is held back', () => {
    const h = over({ id: 'l', kind: 'offer', say: ['Stopped at row 4. What now?'], options: ['Go on', 'Undo it', 'Leave it'] }, true);
    expect(h.answer('go on')).toBe('Picked "Go on" on the line that was up.');
    expect(h.yes('go on')).toBeNull();
  });
});
