import { describe, expect, test } from 'bun:test';
import { agentFull, agentRuns, agentSentence } from './agents.ts';
import { nextWhen, readSchedule, readWhen, sayWhen, sayWhenPlain, whenMoment, whenSaid, whenWords, type NotchWhen } from './when.ts';

const sched = (text: string, exact = false): string => {
  const read = readSchedule(text, { exact });
  return read === null ? 'none' : read === 'unsaid' ? 'unsaid' : `${sayWhen(read.when)}${read.when.guessed ? ' (guessed)' : ''} | ${read.rest}`;
};
const value = (text: string, exact = true): string => { const read = readWhen(text, { exact }); return read ? sayWhen(read) : 'not read'; };

describe('the schedule in a sentence', () => {
  test('a weekday is Monday to Friday, and the part of the day says which half an hour is in', () => {
    expect(sched('every weekday at 9 send me the news')).toBe('Monday to Friday at 9:00 | send me the news');
    expect(sched('every weekdays at 9 send me the news')).toBe('Monday to Friday at 9:00 | send me the news');
    expect(sched('every working day at 8:30 send me the news')).toBe('Monday to Friday at 8:30 | send me the news');
    expect(sched('every morning at 6 send me the weather')).toBe('day at 6:00 | send me the weather');
    expect(sched('every night at 11 back up my notes')).toBe('day at 23:00 | back up my notes');
    expect(sched('every evening at 7 send me a summary')).toBe('day at 19:00 | send me a summary');
    expect(sched('every day at 6 in the morning send me the weather')).toBe('day at 6:00 | send me the weather');
    expect(sched('every day at 10 at night lock the door')).toBe('day at 22:00 | lock the door');
    expect(sched('every monday morning at 6 send me the plan')).toBe('Monday at 6:00 | send me the plan');
    expect(sched('every night at 12 rotate the logs')).toBe('day at 0:00 | rotate the logs');
    expect(sched('every night at 2 rotate the logs')).toBe('day at 2:00 | rotate the logs');
    expect(sched('every day at noon send me the news')).toBe('day at 12:00 | send me the news');
    expect(sched('every day at midnight rotate the logs')).toBe('day at 0:00 | rotate the logs');
  });

  test('a bare hour from one to six is the afternoon and marked as a guess, unless am, pm or the part of the day says otherwise', () => {
    expect(sched('every day at 6 send me the news')).toBe('day at 18:00 (guessed) | send me the news');
    expect(sched('every day at 5.10 send me the news')).toBe('day at 17:10 (guessed) | send me the news');
    expect(sched('every day at 1 send me the news')).toBe('day at 13:00 (guessed) | send me the news');
    expect(sched('every day at 7 send me the news')).toBe('day at 7:00 | send me the news');
    expect(sched('every day at 6am send me the news')).toBe('day at 6:00 | send me the news');
    expect(sched('every day at 6 a.m. send me the news')).toBe('day at 6:00 | send me the news');
    expect(sched('every day at 6pm send me the news')).toBe('day at 18:00 | send me the news');
    expect(sched('every day at 5.10pm send me the news')).toBe('day at 17:10 | send me the news');
    expect(sched('every day at 12am rotate the logs')).toBe('day at 0:00 | rotate the logs');
    expect(sched('every day at 06:00 send me the news')).toBe('day at 6:00 | send me the news');
    expect(sched('every day at 14:30 send me the news')).toBe('day at 14:30 | send me the news');
    // The notch's own writing is read as it stands: nothing is guessed.
    expect(sched('Every day at 6:00, send me the weather.', true)).toBe('day at 6:00 | send me the weather.');
  });

  test('what cannot be read is refused, never made into a schedule that is near it', () => {
    for (const no of [
      'every 2 weeks on tuesday at 14:30 send the invoice',
      'every other day water the plants',
      'every second monday send the report',
      'every month send the invoice',
      'every 5 minutes check the server',
      'every hour check my inbox',
      'every weekend at 9 tidy my downloads',
      'every monday at 9am and friday at 4pm send the report',
      'every monday at 9am, friday at 4pm send the report',
      'every monday at 9 and every friday at 4 send the report',
      'every day at 9 or at 10 send the report',
      'every day at 25 send me the news',
      'every day at 9:75 send me the news',
      'every day at 13pm send me the news',
      'every morning at 6pm send me the weather',
      'every evening at 9am send me the weather',
      'every morning at 15:00 send me the weather',
      'every day at 9-5 send me the news',
    ]) expect([no, sched(no)]).toEqual([no, 'unsaid']);
    // Two times that stand apart from the days: not read either.
    expect(sched('sends me the news at 5 and the weather at 6')).toBe('unsaid');
  });

  test('days are read as a list or a span, and "every week on Friday" is Friday', () => {
    expect(sched('every monday and friday at 9 send the report')).toBe('Monday and Friday at 9:00 | send the report');
    expect(sched('every monday, wednesday and friday at 9 send the report')).toBe('Monday, Wednesday and Friday at 9:00 | send the report');
    expect(sched('every monday to friday at 9 send the report')).toBe('Monday to Friday at 9:00 | send the report');
    expect(sched('every saturday and sunday at 10am water the plants')).toBe('Saturday and Sunday at 10:00 | water the plants');
    expect(sched('every week on friday at 16:00 send the report')).toBe('Friday at 16:00 | send the report');
    expect(sched('every week send Sam the numbers')).toBe('Monday at 9:00 | send Sam the numbers');
    expect(sched('weekly review of my tasks please')).toBe('Monday at 9:00 | review of my tasks please');
    expect(sched('daily send me the news')).toBe('day at 9:00 | send me the news');
  });

  test('the time may stand elsewhere, a time that is the job\'s stays in the job, and what is no schedule is none', () => {
    expect(sched('sends me the news every day at 5.10')).toBe('day at 17:10 (guessed) | sends me the news');
    expect(sched('every day send me the news at 5.10')).toBe('day at 17:10 (guessed) | send me the news');
    expect(sched('every day at 9 remind me of the call at 5')).toBe('day at 9:00 | remind me of the call at 5');
    expect(sched('every day at home check the door')).toBe('day at 9:00 | at home check the door');
    expect(sched('sends me every invoice daily at 9')).toBe('day at 9:00 | sends me every invoice');
    expect(sched('every evening send me a summary')).toBe('day at 18:00 | send me a summary');
    expect(sched('every night back up my notes')).toBe('day at 21:00 | back up my notes');
    expect(sched('every Monday send Sam the numbers')).toBe('Monday at 9:00 | send Sam the numbers');
    expect(sched('every day at nine o\'clock, send Sam the numbers')).toBe('day at 9:00 | send Sam the numbers');
    expect(sched('replies to new leads')).toBe('none');
    expect(sched('every invoice that is late gets a reminder')).toBe('none');
    expect(sched('sends me the news at 5')).toBe('day at 17:00 (guessed) | sends me the news');
  });
});

describe('a value that is a time and nothing else', () => {
  test('it is read as the notch writes it, with every word of it', () => {
    expect(value('Monday at 9:00')).toBe('Monday at 9:00');
    expect(value('day at 9:00')).toBe('day at 9:00');
    expect(value('weekday at 9')).toBe('Monday to Friday at 9:00');
    expect(value('Monday to Friday at 9:00')).toBe('Monday to Friday at 9:00');
    expect(value('Monday, Wednesday and Friday at 9:00')).toBe('Monday, Wednesday and Friday at 9:00');
    expect(value('every Monday at 9am')).toBe('Monday at 9:00');
    expect(value('tomorrow at 9:00')).toBe('tomorrow at 9:00');
    expect(value('today at 20:00')).toBe('today at 20:00');
    expect(value('next week')).toBe('next week');
    expect(value('morning at 6:00')).toBe('day at 6:00');
    expect(value('night at 11')).toBe('day at 23:00');
    for (const no of ['', 'Monday', 'at 9:00', 'Funday at 9:00', 'Monday at 25:00', 'month at 9:00', 'money at 9', 'every 2 weeks at 9:00', 'Monday at 9:00 please',
      'Monday at 9:00 and Friday at 16:00', 'every tomorrow at 9:00', 'next friday at 9:00', 'tomorrow morning', 'morning at 6pm']) expect([no, value(no)]).toEqual([no, 'not read']);
  });

  test('what the notch says is what it reads back, for every time it can keep', () => {
    const times: NotchWhen[] = [];
    for (const days of [[1], [5], [0, 6], [1, 5], [1, 3, 5], [1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6], [2, 3, 4]]) {
      for (const [hour, minute] of [[0, 0], [1, 5], [6, 0], [9, 0], [12, 0], [13, 30], [18, 0], [23, 59]] as const) times.push({ days, hour, minute });
    }
    for (const when of times) {
      // As its own writing, exactly.
      expect(readWhen(sayWhen(when), { exact: true })).toEqual(when);
      // In a sentence that is read again as the notch's own.
      const again = readSchedule(`Every ${sayWhen(when)}, send me the news.`, { exact: true });
      expect(again === 'unsaid' || again === null ? null : again.when).toEqual(when);
      // And in words a reader that guesses reads the same way.
      const plain = readSchedule(`every ${sayWhenPlain(when)} send me the news`);
      expect(plain === 'unsaid' || plain === null ? null : plain.when).toEqual(when);
    }
  });

  test('an agent\'s own sentence keeps its hour when it is read again', () => {
    const asked = agentSentence('every morning at 6 send me the weather')!;
    expect(asked.when).toBe('day at 6:00');
    const full = agentFull(asked);
    expect(full).toBe('Every day at 6:00, send me the weather.');
    // Read as a person's words, a bare six would be the afternoon: the card is not a person's words.
    expect(agentRuns(full)).toBe('Every day at 6:00');
    expect(agentSentence(full, true)?.when).toBe('day at 6:00');
    expect(agentRuns('Every Monday to Friday at 9:00, send me the news.')).toBe('Every Monday to Friday at 9:00');
  });
});

describe('a day and a time among other words', () => {
  const said = (text: string, guessTo?: number): string => {
    const words = whenWords(text);
    const read = whenSaid(words, guessTo ? { guessTo } : {});
    const left = words.filter((_word, at) => !read.used.has(at)).join(' ');
    return `${read.every ? 'every ' : ''}${read.rel ?? (read.days ? read.days.join('') : '-')} ${read.hour === null ? '-' : `${read.hour}:${String(read.minute).padStart(2, '0')}`} ${read.part ?? '-'}${left ? ` [${left}]` : ''}`;
  };
  test('they are found wherever they stand, and the words they did not use are left for the caller', () => {
    expect(said('make it friday at ten')).toBe('5 10:00 - [make it at]');
    expect(said('every weekday at 9')).toBe('every 12345 9:00 - [at]');
    expect(said('at 6 in the morning')).toBe('- 6:00 - [at in the]');
    expect(said('night at 11')).toBe('- 23:00 - [at]');
    expect(said('friday afternoon')).toBe('5 - afternoon');
    expect(said('tomorrow at noon')).toBe('tomorrow 12:00 - [at]');
    expect(said('at 7')).toBe('- 7:00 - [at]');
    expect(said('at 7', 7)).toBe('- 19:00 - [at]');
    // "Night" with no hour is not read: the word is left over, so whoever asked knows it was not accounted for.
    expect(said('friday night')).toBe('5 - - [night]');
  });
  test('a schedule that cannot be said, or an hour that contradicts its part of the day, uses no word at all', () => {
    expect(said('every 2 weeks at 9')).toBe('- - - [every 2 weeks at 9]');
    expect(said('every other friday at 9')).toBe('- - - [every other friday at 9]');
    expect(said('morning at 6pm')).toBe('- - - [morning at 6pm]');
  });
});

describe('counting a time', () => {
  // Wednesday 18 November 2026, 10:00, on this machine's clock.
  const wed = new Date(2026, 10, 18, 10, 0, 0).getTime();
  const on = (day: number, hour: number, minute = 0): number => new Date(2026, 10, day, hour, minute, 0).getTime();
  test('the next time by the week is on one of its days, never on another', () => {
    expect(nextWhen({ days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }, wed)).toBe(on(19, 9));
    expect(nextWhen({ days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }, on(20, 9))).toBe(on(23, 9));
    expect(nextWhen({ days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }, on(21, 12))).toBe(on(23, 9));
    expect(nextWhen({ days: [0, 6], hour: 10, minute: 0 }, wed)).toBe(on(21, 10));
    expect(nextWhen({ days: [3], hour: 10, minute: 0 }, wed)).toBe(on(25, 10));
    expect(nextWhen({ days: [3], hour: 10, minute: 1 }, wed)).toBe(on(18, 10, 1));
  });
  test('one moment is ahead, or it is none', () => {
    expect(whenMoment({ days: [], rel: 'tomorrow', hour: 9, minute: 0 }, wed)).toBe(on(19, 9));
    expect(whenMoment({ days: [], rel: 'today', hour: 9, minute: 0 }, wed)).toBeNull();
    expect(whenMoment({ days: [], rel: 'next week', hour: 9, minute: 0 }, wed)).toBe(on(23, 9));
    expect(whenMoment({ days: [3], hour: 9, minute: 0 }, wed)).toBe(on(25, 9));
    expect(whenMoment({ days: [1, 5], hour: 9, minute: 0 }, wed)).toBeNull();
  });
});
