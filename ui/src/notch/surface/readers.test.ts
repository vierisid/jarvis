import { describe, expect, test } from 'bun:test';
import type { NotchWord } from '../../../../src/notch/protocol.ts';
import { dayIn, onlyWhen, readLive, timeIn } from './readers.ts';

const word = (more: Partial<NotchWord>): NotchWord => ({ name: 'w', value: '', options: [], ...more });

describe('what a typed value means for a lit word', () => {
  const tone = word({ value: 'politely', options: ['politely', 'firmly'], syn: { firmly: ['tough', 'hard'], politely: ['nice', 'kind'] } });

  test('one of the options, whole or by its beginning, in any case', () => {
    expect(readLive(tone, 'Firmly')).toBe('firmly');
    expect(readLive(tone, 'fir')).toBe('firmly');
    expect(readLive(tone, ' politely ')).toBe('politely');
  });

  test('another way of saying an option', () => {
    expect(readLive(tone, 'be tough')).toBe('firmly');
    expect(readLive(tone, 'something kind')).toBe('politely');
  });

  // The refusal the person sees as "I did not get that".
  test('a text that means nothing is refused, not guessed', () => {
    expect(readLive(tone, 'xyzzy')).toBeNull();
    expect(readLive(tone, '')).toBeNull();
    expect(readLive(tone, '   ')).toBeNull();
    // One letter is not the beginning of anything.
    expect(readLive(tone, 'f')).toBeNull();
  });

  test('a word that takes anything keeps what was typed, cut to 28 characters and stripped of markup', () => {
    const who = word({ value: 'Anna Rossi', options: ['Anna Rossi', 'Ana Lima'], free: true });
    expect(readLive(who, 'Marco Bianchi')).toBe('Marco Bianchi');
    expect(readLive(who, '<b>Marco</b>')).toBe('bMarco/b');
    expect(readLive(who, 'x'.repeat(40))).toBe('x'.repeat(28));
  });

  test('a day and a time are read as a day and a time', () => {
    const when = word({ value: 'tomorrow at 9:00', options: ['tomorrow at 9:00', 'Friday at 9:00'], read: 'dayTime' });
    expect(readLive(when, 'friday at 10')).toBe('Friday at 10:00');
    expect(readLive(when, 'thu 3pm')).toBe('Thursday at 15:00');
    expect(readLive(when, 'a quarter past never')).toBeNull();
  });

  test('a day alone', () => {
    const day = word({ value: 'Friday', options: ['Friday', 'Monday', 'today'], read: 'day' });
    expect(readLive(day, 'wednesday')).toBe('Wednesday');
    expect(readLive(day, 'tod')).toBe('today');
    expect(readLive(day, 'soonish')).toBeNull();
  });
});

describe('the pieces the readers are made of', () => {
  test('a weekday by its first three letters, today, tomorrow', () => {
    expect(dayIn('on thu please')).toBe('Thursday');
    expect(dayIn('tmrw')).toBe('tomorrow');
    expect(dayIn('whenever')).toBeNull();
  });

  test('a time on a 24 hour clock; a bare 1 to 7 is the afternoon', () => {
    expect(timeIn('at 9')).toBe('9:00');
    expect(timeIn('at 3')).toBe('15:00');
    expect(timeIn('10.30')).toBe('10:30');
    expect(timeIn('12am')).toBe('0:00');
    expect(timeIn('25:00')).toBeNull();
    expect(timeIn('no time here')).toBeNull();
  });

  test('stray digits in a sentence are not a time', () => {
    expect(onlyWhen('friday at 10')).toBe(true);
    expect(onlyWhen('invoice 114 is late')).toBe(false);
  });
});
