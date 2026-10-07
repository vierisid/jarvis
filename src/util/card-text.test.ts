/**
 * `forCard` -- the one model-supplied value in an approval card's sentence.
 *
 * The card renders that sentence and nothing else, so this string IS the review
 * (#507). These tests pin the three things that protects: whitespace cannot push
 * the verb out of view, length cannot run on past the sentence, and invisible
 * formatting cannot make the card read as something other than what is approved.
 */

import { describe, expect, test } from 'bun:test';
import { commandForCard, escapedLiteralForCard, forCard } from './card-text.ts';

describe('forCard', () => {
  test('it collapses whitespace so a newline cannot hide the sentence', () => {
    expect(forCard('a\n\n\tb   c')).toBe('a b c');
    expect(forCard('  padded  ')).toBe('padded');
  });

  test('it caps the value so it cannot append prose of its own', () => {
    const long = 'x'.repeat(700);
    const out = forCard(long);
    expect(out.length).toBe(600);
    expect(out.endsWith('...')).toBe(true);
    expect(forCard('short', 10)).toBe('short');
  });

  test('it strips a bidi override that would reorder what the reader sees', () => {
    // `cv‮gpj.exe` renders as `cvexe.jpg`. The override survives a
    // whitespace collapse and a length cap untouched, so a filename the model
    // chose could make the card describe a different file than the one approved.
    const out = forCard('/home/me/Documents/cv‮gpj.exe');
    expect(out).toBe('/home/me/Documents/cvgpj.exe');
    expect(out).not.toContain('‮');
  });

  test('it strips the other invisible formatting characters', () => {
    for (const ch of ['​', '‎', '‏', '‪', '‭', '⁦', '⁩', '﻿', '­']) {
      expect(forCard(`a${ch}b`), ch.charCodeAt(0).toString(16)).toBe('ab');
    }
  });

  test('it strips C0, DEL and C1 controls, which render as nothing or as junk', () => {
    // A name of only controls used to survive non-empty and show as a blank on
    // the card; an escape sequence rendered as terminal junk. #656 stripped
    // these locally in ui.ts; every other caller had the same hole (#659).
    expect(forCard('\u0001\u0002')).toBe('');
    expect(forCard('Save\u001b[2J\u007f')).toBe('Save[2J');
    expect(forCard('a\u0085b\u009fc')).toBe('abc');
    // Vertical tab and form feed are dropped like the others rather than
    // turned into a space, matching what ui.ts did.
    expect(forCard('a\u000bb\u000cc')).toBe('abc');
    // The whitespace controls are still whitespace.
    expect(forCard('a\tb\nc\rd')).toBe('a b c d');
  });

  test('it strips every default-ignorable code point, not just the bidi and zero-width ones', () => {
    // Combining grapheme joiner, variation selector 16, tag characters (ASCII
    // smuggling), the Hangul fillers: each made two different strings read the
    // same, or a non-empty name render blank (#659 review).
    expect(forCard('no\u034ftes')).toBe('notes');
    expect(forCard('a\ufe0fb')).toBe('ab');
    expect(forCard('a\u{e0041}\u{e0042}b')).toBe('ab');
    expect(forCard('\u3164\u115f')).toBe('');
  });

  test('it leaves ordinary text, including non-ASCII, alone', () => {
    expect(forCard('/home/me/Documentos/currículum.pdf')).toBe('/home/me/Documentos/currículum.pdf');
    expect(forCard('~/Downloads/レポート.xlsx')).toBe('~/Downloads/レポート.xlsx');
  });

  test('a null or undefined value is the empty string, not "null"', () => {
    expect(forCard(null)).toBe('');
    expect(forCard(undefined)).toBe('');
  });
});

/** #720: shared by `run_command` and `site_run_command`; the site tests in tool-gate.test.ts pin the rest. */
describe('escapedLiteralForCard and commandForCard', () => {
  test('a literal decodes to exactly the value and cannot close its own quote', () => {
    const value = `a"b\n${String.fromCharCode(0x202e)}c${String.fromCharCode(10)}`;
    const literal = escapedLiteralForCard(value);
    expect(literal).not.toMatch(/[^\x20-\x7e]/);
    expect(JSON.parse(literal)).toBe(value);
    expect(escapedLiteralForCard(undefined)).toBe('""');
  });

  test('trim follows the caller: untrimmed shows the outer whitespace the shell receives', () => {
    expect(commandForCard('  ls \n')).toBe('run: ls');
    expect(commandForCard('  ls', { trim: false })).toBe('run:   ls');
    expect(commandForCard('ls\n', { trim: false })).toBe('run this 2-line command, as an escaped string (\\n is a new line): "ls\\n"');
  });
});
