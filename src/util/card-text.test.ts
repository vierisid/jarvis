/**
 * `forCard` -- the one model-supplied value in an approval card's sentence.
 *
 * The card renders that sentence and nothing else, so this string IS the review
 * (#507). These tests pin the three things that protects: whitespace cannot push
 * the verb out of view, length cannot run on past the sentence, and invisible
 * formatting cannot make the card read as something other than what is approved.
 */

import { describe, expect, test } from 'bun:test';
import { forCard } from './card-text.ts';

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

  test('it leaves ordinary text, including non-ASCII, alone', () => {
    expect(forCard('/home/me/Documentos/currículum.pdf')).toBe('/home/me/Documentos/currículum.pdf');
    expect(forCard('~/Downloads/レポート.xlsx')).toBe('~/Downloads/レポート.xlsx');
  });

  test('a null or undefined value is the empty string, not "null"', () => {
    expect(forCard(null)).toBe('');
    expect(forCard(undefined)).toBe('');
  });
});
