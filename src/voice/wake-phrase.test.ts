import { describe, expect, test } from 'bun:test';
import { containsWakePhrase } from './wake-phrase.ts';

describe('containsWakePhrase', () => {
  test('matches the bare wake phrase', () => {
    expect(containsWakePhrase('jarvis')).toBe(true);
    expect(containsWakePhrase('Jarvis')).toBe(true);
    expect(containsWakePhrase('JARVIS')).toBe(true);
  });

  test('matches when the wake phrase appears mid-sentence', () => {
    expect(containsWakePhrase('Hey Jarvis, how are you')).toBe(true);
    expect(containsWakePhrase('Tell Jarvis to send the email')).toBe(true);
    expect(containsWakePhrase('I told jarvis already')).toBe(true);
  });

  test('respects word boundaries (does not match substrings)', () => {
    expect(containsWakePhrase('jarvisson')).toBe(false);
    expect(containsWakePhrase('starjarvis')).toBe(false);
    expect(containsWakePhrase('antijarvist')).toBe(false);
  });

  test('treats punctuation as a word boundary', () => {
    expect(containsWakePhrase('Hello, Jarvis.')).toBe(true);
    expect(containsWakePhrase('"Jarvis!"')).toBe(true);
    expect(containsWakePhrase('(jarvis)')).toBe(true);
    expect(containsWakePhrase('Jarvis?')).toBe(true);
  });

  test('handles empty / null-ish input safely', () => {
    expect(containsWakePhrase('')).toBe(false);
    // The function takes string only, but we exercise the early-exit
    // branch by passing an empty string explicitly.
    expect(containsWakePhrase(' ')).toBe(false);
  });

  test('handles whitespace-only and unrelated text', () => {
    expect(containsWakePhrase('hello world')).toBe(false);
    expect(containsWakePhrase('the assistant said hello')).toBe(false);
    expect(containsWakePhrase('   ')).toBe(false);
  });

  test('is robust to multiline TTS input (the daemon flag-on-tts_text use case)', () => {
    expect(containsWakePhrase('First sentence.\nSecond sentence with Jarvis.')).toBe(true);
    expect(containsWakePhrase('Line one.\nLine two.\nLine three.')).toBe(false);
  });

  test('matches multiple occurrences (still returns true; not a count)', () => {
    expect(containsWakePhrase('Jarvis told Jarvis about Jarvis')).toBe(true);
  });
});
