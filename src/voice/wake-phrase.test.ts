import { describe, expect, test } from 'bun:test';
import { containsStopPhrase, containsWakePhrase, hasSpokenContent, wakeCommandFrom } from './wake-phrase.ts';

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

describe('containsStopPhrase', () => {
  test('matches spoken stop phrases with TTS punctuation', () => {
    expect(containsStopPhrase("Say 'Jarvis, stop' to interrupt me.")).toBe(true);
    expect(containsStopPhrase('Jarvis stop')).toBe(true);
    expect(containsStopPhrase('You can say "Jarvis... be quiet" anytime.')).toBe(true);
    expect(containsStopPhrase('jarvis quiet')).toBe(true);
  });

  test('does not match ordinary mentions of Jarvis or stop', () => {
    expect(containsStopPhrase('Jarvis stopped the timer for you')).toBe(false);
    expect(containsStopPhrase('Ask Jarvis about the bus stop')).toBe(false);
    expect(containsStopPhrase('Please stop by tomorrow')).toBe(false);
    expect(containsStopPhrase('')).toBe(false);
  });
});

describe('wakeCommandFrom', () => {
  test('returns the command that follows the wake word', () => {
    expect(wakeCommandFrom('Jarvis play music')).toBe('play music');
    expect(wakeCommandFrom('Hey Jarvis, what are you working on?')).toBe('what are you working on?');
    expect(wakeCommandFrom('jarvis: open the dashboard')).toBe('open the dashboard');
  });

  test('uses the LAST wake word so lead-in chatter is dropped', () => {
    expect(wakeCommandFrom("I'm at home, Jarvis play music")).toBe('play music');
    expect(wakeCommandFrom('I told Jarvis already. Jarvis, mute yourself')).toBe('mute yourself');
  });

  test('returns "" for a bare summon, whatever punctuation STT tacks on', () => {
    // The bug: "Hey Jarvis!" left a "!" behind, which was run as the whole
    // user turn and answered with three hundred lines of counting.
    expect(wakeCommandFrom('Hey Jarvis!')).toBe('');
    expect(wakeCommandFrom('Hey Jarvis?')).toBe('');
    expect(wakeCommandFrom('Hey Jarvis.')).toBe('');
    expect(wakeCommandFrom('Jarvis!!')).toBe('');
    expect(wakeCommandFrom('Jarvis...')).toBe('');
    expect(wakeCommandFrom('jarvis')).toBe('');
    expect(wakeCommandFrom('Jarvis —')).toBe('');
    expect(wakeCommandFrom('"Jarvis?!"')).toBe('');
  });

  test('keeps a command that merely opens with punctuation', () => {
    expect(wakeCommandFrom('Jarvis, "play music"')).toBe('play music"');
    expect(wakeCommandFrom('Jarvis \u2014 5 minute timer')).toBe('5 minute timer');
  });

  test('keeps punctuation that belongs to the command, not to the gap', () => {
    // The mirror of the bug: stripping every leading symbol would quietly
    // rewrite these. Only separators come off.
    expect(wakeCommandFrom('Jarvis, $100 budget for the trip')).toBe('$100 budget for the trip');
    expect(wakeCommandFrom('Jarvis, #general is muted')).toBe('#general is muted');
    expect(wakeCommandFrom('Jarvis +5 minutes on the timer')).toBe('+5 minutes on the timer');
    expect(wakeCommandFrom('Jarvis, @dad called')).toBe('@dad called');
  });

  test('accepts non-Latin commands', () => {
    expect(wakeCommandFrom('Jarvis, che ore sono?')).toBe('che ore sono?');
    expect(wakeCommandFrom('Jarvis, 天気は?')).toBe('天気は?');
  });

  test('returns "" when there is no wake word at all', () => {
    expect(wakeCommandFrom('play music')).toBe('');
    expect(wakeCommandFrom('jarvisson play music')).toBe('');
    expect(wakeCommandFrom('')).toBe('');
  });
});

describe('hasSpokenContent', () => {
  test('accepts anything with a letter or a digit', () => {
    expect(hasSpokenContent('what are you working on?')).toBe(true);
    expect(hasSpokenContent('5')).toBe(true);
    expect(hasSpokenContent('...ok')).toBe(true);
    expect(hasSpokenContent('\u5929\u6c17\u306f?')).toBe(true);
  });

  test('rejects the punctuation STT invents out of silence', () => {
    expect(hasSpokenContent('.')).toBe(false);
    expect(hasSpokenContent('!')).toBe(false);
    expect(hasSpokenContent('?!')).toBe(false);
    expect(hasSpokenContent('...')).toBe(false);
    expect(hasSpokenContent('  ')).toBe(false);
    expect(hasSpokenContent('')).toBe(false);
  });
});
