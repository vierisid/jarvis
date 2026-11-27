import { describe, expect, test } from 'bun:test';
import type { NotchLine, NotchWord } from './protocol.ts';
import { NOTCH_WORD_READ, notchReadWord, notchSetWord, notchWordIn } from './words.ts';

const word = (more: Partial<NotchWord>): NotchWord => ({ name: 'w', value: '', options: [], ...more });

describe('what a typed value means for a lit word', () => {
  const tone = word({ value: 'politely', options: ['politely', 'firmly'], syn: { firmly: ['tough', 'hard'], politely: ['nice', 'kind'] } });

  test('one of the options, whole or by its beginning, in any case', () => {
    expect(notchReadWord(tone, 'Firmly')).toBe('firmly');
    expect(notchReadWord(tone, 'fir')).toBe('firmly');
    expect(notchReadWord(tone, ' politely ')).toBe('politely');
  });

  test('another way of saying an option', () => {
    expect(notchReadWord(tone, 'be tough')).toBe('firmly');
    expect(notchReadWord(tone, 'something kind')).toBe('politely');
  });

  // The refusal the person sees on the page as "I did not get that".
  test('a text that means nothing is refused, not guessed', () => {
    expect(notchReadWord(tone, 'xyzzy')).toBeNull();
    expect(notchReadWord(tone, '')).toBeNull();
    expect(notchReadWord(tone, '   ')).toBeNull();
    // One letter is not the beginning of anything.
    expect(notchReadWord(tone, 'f')).toBeNull();
  });

  test('a word that takes anything keeps what was typed as it was typed, cut to 28 characters', () => {
    const who = word({ value: 'Anna Rossi', options: ['Anna Rossi', 'Ana Lima'], free: true });
    expect(notchReadWord(who, 'Marco Bianchi')).toBe('Marco Bianchi');
    // It used to be stripped of whatever could be markup: "R&D" was "RD". The page draws text as text.
    expect(notchReadWord(who, '<b>Marco</b>')).toBe('<b>Marco</b>');
    expect(notchReadWord(who, 'R&D')).toBe('R&D');
    expect(notchReadWord(who, 'x'.repeat(40))).toBe('x'.repeat(28));
  });

  test('a day and a time are read as a day and a time, what is not said kept from the word', () => {
    const when = word({ value: 'tomorrow at 9:00', options: ['tomorrow at 9:00', 'Friday at 9:00'], read: 'dayTime' });
    expect(notchReadWord(when, 'friday at 10')).toBe('Friday at 10:00');
    expect(notchReadWord(when, 'thu 3pm')).toBe('Thursday at 15:00');
    expect(notchReadWord(when, 'at 15:00')).toBe('tomorrow at 15:00');
    expect(notchReadWord(when, 'a quarter past never')).toBeNull();
    // One moment: several days are not one.
    expect(notchReadWord(when, 'weekday at 9')).toBeNull();
  });

  test('a day alone', () => {
    const day = word({ value: 'Friday', options: ['Friday', 'Monday', 'today'], read: 'day' });
    expect(notchReadWord(day, 'wednesday')).toBe('Wednesday');
    expect(notchReadWord(day, 'tod')).toBe('today');
    expect(notchReadWord(day, 'tmrw')).toBe('tomorrow');
    expect(notchReadWord(day, 'soonish')).toBeNull();
  });

  test('a word that only begins like a day is no day, and "weekday" is Monday to Friday', () => {
    const at = word({ value: 'Monday at 9:00', read: 'sched' });
    for (const text of ['month', 'money at 9', 'sunset', 'saturn', 'satisfied', 'wedding', 'march', 'every 2 weeks', 'tomorrow', 'noon', 'evening', 'every morning at 6']) {
      expect([text, NOTCH_WORD_READ.sched(text, at)]).toEqual([text, null]);
    }
    expect(NOTCH_WORD_READ.sched('weekday at 9', at)).toBe('Monday to Friday at 9:00');
    expect(NOTCH_WORD_READ.sched('6', at)).toBe('day at 18:00');
  });

  test('otherwise a typed time means what it meant on the page: a bare 1 to 7 is the afternoon, an hour with minutes is as written', () => {
    const at = word({ value: 'Monday at 9:00', read: 'sched' });
    const read: Record<string, string> = {
      '7': 'day at 19:00', 'at 7': 'day at 19:00', 'tue 7': 'Tuesday at 19:00', 'mon 6.30': 'Monday at 6:30', '6:30': 'day at 6:30',
      'next friday': 'Friday at 9:00', 'at 9 on mon': 'Monday at 9:00', 'wed 25': 'Wednesday at 9:00',
    };
    for (const [text, value] of Object.entries(read)) expect([text, NOTCH_WORD_READ.sched(text, at)]).toEqual([text, value]);
    expect(NOTCH_WORD_READ.day('monday at 9', word({ value: 'Friday', read: 'day' }))).toBe('Monday');
    expect(NOTCH_WORD_READ.sched('sat', at)).toBe('Saturday at 9:00');
  });
});

// A word that takes a sentence: what the person tells Jarvis in their own words (the mail draft's "tell me").
describe('a word that takes a sentence', () => {
  const tell = { name: 'told', value: 'tell me', options: [] as string[], free: true, long: true };

  test('holds a sentence, as one line, where a word holds a word or two', () => {
    expect(notchReadWord(tell, '  I am on Central European Time,\n UTC+1  ')).toBe('I am on Central European Time, UTC+1');
    expect(notchReadWord(tell, 'x'.repeat(400))!.length).toBe(200);
    expect(notchReadWord({ ...tell, long: false }, 'x'.repeat(400))!.length).toBe(28);
  });

  test('nothing typed is nothing told, and what was typed is told as it was typed', () => {
    expect(notchReadWord(tell, '   ')).toBeNull();
    expect(notchReadWord(tell, 'Tell R&D "x < 5"')).toBe('Tell R&D "x < 5"');
  });
});

describe('the word in its line', () => {
  const line = (): NotchLine => ({
    id: 'd', kind: 'sheet', say: ['Reply to ', { em: 'Sam' }], yes: 'send',
    blocks: [{ kind: 'row', lead: 'Tell me', say: [{ word: { name: 'told', value: 'tell me', options: ['say no'], free: true, long: true } }] }],
  });

  test('is found where it stands, in the sentence or in a row of the sheet', () => {
    expect(notchWordIn(line(), 'told')?.value).toBe('tell me');
    expect(notchWordIn(line(), 'nothing')).toBeNull();
  });

  test('is set in place, with the value among its options', () => {
    const l = line();
    notchSetWord(l, 'told', 'decline it');
    expect(notchWordIn(l, 'told')).toMatchObject({ value: 'decline it', options: ['say no', 'decline it'] });
  });
});
