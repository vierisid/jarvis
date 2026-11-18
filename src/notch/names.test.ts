import { describe, expect, test } from 'bun:test';
import { nameDistance, notchNameDoubt, notchNamed } from './names.ts';

const PEOPLE = [{ name: 'Anna Rossi' }, { name: 'Ana Lima' }, { name: 'Leo Bianchi' }, { name: 'Sam Rivers' }, { name: 'Christian Weber' }, { name: 'Vera Costa' }];
const doubt = (text: string, people = PEOPLE) => notchNameDoubt(text, people);

describe('a name that was heard, and may not be who was meant', () => {
  test('the prototype\'s: "Ana" with an Anna among the people Jarvis knows', () => {
    const people = [{ name: 'Anna Rossi' }, { name: 'Leo Bianchi' }];
    const found = doubt('Send the notes to Ana.', people)!;
    expect(found).toEqual({ heard: 'Ana', from: 18, to: 21, options: ['Anna Rossi'] });
    expect(notchNamed('Send the notes to Ana.', found, 'Anna Rossi')).toBe('Send the notes to Anna Rossi.');
  });

  test('a name that is exactly one person\'s is sure, and so is one that is near nobody\'s', () => {
    expect(doubt('Send the notes to Leo.')).toBeNull();
    expect(doubt('Tell Vera the deck is late')).toBeNull();
    // Somebody Jarvis does not know: the instruction runs as it was said.
    expect(doubt('Send the notes to Giulia.')).toBeNull();
    expect(doubt('Book a table at Northwind for Friday')).toBeNull();
  });

  test('a name that is exactly one person\'s is theirs, though another is close to it', () => {
    // "Ana" is Ana Lima's own name: Anna Rossi being close does not make it unsure.
    expect(doubt('Send the notes to Ana.')).toBeNull();
    expect(doubt('Send the notes to Anna.')).toBeNull();
  });

  test('one letter off, two swapped, or the same sounds: each is close', () => {
    const people = [{ name: 'Marco Bianchi' }, { name: 'Christian Weber' }, { name: 'Stephan Koch' }, { name: 'Leo Conti' }];
    expect(doubt('Email Marko the numbers', people)?.options).toEqual(['Marco Bianchi']);
    expect(doubt('Ask Macro about it', people)?.options).toEqual(['Marco Bianchi']);
    expect(doubt('Write to Kristian today', people)?.options).toEqual(['Christian Weber']);
    expect(doubt('Call Stefan back', people)?.options).toEqual(['Stephan Koch']);
    expect(doubt('Tell Lea I am late', people)?.options).toEqual(['Leo Conti']);
    // Too far to be the same name.
    expect(doubt('Ask Marta about it', people)).toBeNull();
    expect(doubt('Call Steven back', people)).toBeNull();
  });

  test('a first name two people have is asked about, unless the surname that was said tells them apart', () => {
    const people = [{ name: 'Anna Rossi' }, { name: 'Anna Conti' }, { name: 'Leo Bianchi' }];
    expect(doubt('Send the deck to Anna', people)).toMatchObject({ heard: 'Anna', options: ['Anna Rossi', 'Anna Conti'] });
    expect(doubt('Send the deck to Anna Conti', people)).toBeNull();
    expect(doubt('Send the deck to Anna Rossi please', people)).toBeNull();
    // A surname that is neither of theirs tells nothing.
    expect(doubt('Send the deck to Anna Bianchi', people)?.options).toEqual(['Anna Rossi', 'Anna Conti']);
  });

  test('a surname said after a name that is close goes with it, and puts its own first', () => {
    const people = [{ name: 'Ana Lima' }, { name: 'Anna Rossi' }];
    const found = doubt('Send the notes to Anne Rossi tomorrow', people)!;
    expect(found.heard).toBe('Anne Rossi');
    expect(found.options).toEqual(['Anna Rossi', 'Ana Lima']);
    expect(notchNamed('Send the notes to Anne Rossi tomorrow', found, found.options[0]!)).toBe('Send the notes to Anna Rossi tomorrow');
  });

  test('the likeliest comes first, and the ones dealt with last before the others', () => {
    const people = [{ name: 'Lena Fox' }, { name: 'Leo Bianchi' }, { name: 'Lea Conti' }, { name: 'Leon Marsh' }, { name: 'Lee Park' }];
    // "Leu" is one letter from Leo, Lea and Lee, in the order they are known. Lena and Leon are two off: too far for so short a name.
    expect(doubt('Tell Leu I am late', people)?.options).toEqual(['Leo Bianchi', 'Lea Conti', 'Lee Park']);
    // Nearer comes before further, whoever was dealt with last.
    expect(doubt('Write to Kristian today', [{ name: 'Christian Weber' }, { name: 'Kristina Olsen' }])?.options).toEqual(['Kristina Olsen', 'Christian Weber']);
    // And no more than four are offered.
    const many = ['Leo A', 'Lea B', 'Lee C', 'Len D', 'Les E', 'Lev F'].map((name) => ({ name }));
    expect(doubt('Tell Leu I am late', many)?.options).toHaveLength(4);
  });

  test('only a word with a capital inside a sentence is a name: not its first word, not a day, a month or a program', () => {
    const people = [{ name: 'Sen Park' }, { name: 'Mai Tran' }, { name: 'Marc Dubois' }, { name: 'Slade Wilson' }, { name: 'Ann Lee' }];
    expect(doubt('Send the notes to the team', people)).toBeNull();
    expect(doubt('Move it to May. Send it then.', people)).toBeNull();
    expect(doubt('Do it in March', people)).toBeNull();
    expect(doubt('Post it in Slack', people)).toBeNull();
    expect(doubt('send the notes to an old friend', people)).toBeNull();
    // Written without its capital, it is not taken for a name.
    expect(doubt('send the notes to ana', [{ name: 'Anna Rossi' }])).toBeNull();
    // After a full stop the next word opens a sentence.
    expect(doubt('Thanks. Anne will know.', people)).toBeNull();
    expect(doubt('Thanks, and tell Anne.', people)?.options).toEqual(['Ann Lee']);
  });

  test('what is no name of a person is not one Jarvis knows', () => {
    expect(doubt('Send it to Ana', [{ name: '' }, { name: 'anna@lumen.example' }, { name: 'A' }, { name: 'x'.repeat(80) }])).toBeNull();
    expect(doubt('Send it to Ana', [])).toBeNull();
    // The same person twice is one person.
    expect(doubt('Send it to Ana', [{ name: 'Anna Rossi' }, { name: 'anna rossi' }, { name: ' Anna  Rossi ' }])?.options).toEqual(['Anna Rossi']);
  });

  test('accents and apostrophes are not what makes two names differ', () => {
    expect(doubt('Write to Jose today', [{ name: 'José Álvarez' }])).toBeNull();
    expect(doubt("Ask D'Angelo about it", [{ name: "D'Angelo Russo" }])).toBeNull();
    expect(doubt('Write to Josi today', [{ name: 'José Álvarez' }])?.options).toEqual(['José Álvarez']);
  });

  test('who was chosen is put where the word was heard, as plain words', () => {
    const text = 'Send the notes to Ana.';
    const at = { from: 18, to: 21 };
    expect(notchNamed(text, at, '  Anna\n Rossi ')).toBe('Send the notes to Anna Rossi.');
    expect(notchNamed(text, at, 'Anna "Rossi" <b>')).toBe('Send the notes to Anna Rossi b.');
    expect(notchNamed(text, at, 'x'.repeat(200)).length).toBe(text.length - 3 + 60);
    // Nothing chosen, or a place that is not in the instruction: it stays as it was heard.
    expect(notchNamed(text, at, '  ')).toBe(text);
    expect(notchNamed(text, { from: 18, to: 99 }, 'Anna Rossi')).toBe(text);
    expect(notchNamed(text, { from: 5, to: 5 }, 'Anna Rossi')).toBe(text);
  });

  test('how far two names are apart', () => {
    expect(nameDistance('ana', 'anna')).toBe(1);
    expect(nameDistance('marko', 'marco')).toBe(1);
    expect(nameDistance('macro', 'marco')).toBe(1);
    expect(nameDistance('leo', 'leo')).toBe(0);
    expect(nameDistance('', 'leo')).toBe(3);
    expect(nameDistance('kristian', 'christian')).toBe(2);
  });
});
