import { describe, expect, test } from 'bun:test';
import { truncateHead, truncateWithNote } from './truncate.ts';
import { capTextBlocks } from '../llm/provider.ts';
import { markUntrustedToolFailure } from '../roles/untrusted.ts';

const EMOJI = '\u{1F600}'; // two code units: \uD83D\uDE00

/** Every lone surrogate in `s`; [] when it is well-formed. */
const lone = (s: string) => (s.isWellFormed() ? [] : [...s].filter((c) => c.length === 1 && /[\uD800-\uDFFF]/.test(c)));

describe('truncateWithNote', () => {
  test('a cut that would split a surrogate pair backs off instead', () => {
    const text = 'a'.repeat(5999) + EMOJI + 'tail';
    expect(text.slice(0, 6000).isWellFormed()).toBe(false); // the bug: slice splits the pair
    const out = truncateWithNote(text, 6000);
    expect(out.isWellFormed()).toBe(true);
    expect(out).toBe('a'.repeat(5999) + `\n... (truncated, was ${text.length} chars)`);
  });

  test('a cut between whole characters keeps exactly the budget', () => {
    const text = 'a'.repeat(5998) + EMOJI + 'tail';
    expect(truncateWithNote(text, 6000)).toBe('a'.repeat(5998) + EMOJI + `\n... (truncated, was ${text.length} chars)`);
  });

  test('text within the budget comes back as it was', () => {
    expect(truncateWithNote('short ' + EMOJI, 6000)).toBe('short ' + EMOJI);
  });

  test('a lone surrogate in text within the budget is repaired too', () => {
    expect(truncateWithNote('ok \uD83D', 6000)).toBe('ok \uFFFD');
  });

  test('a lone surrogate the input carried is repaired in the kept head', () => {
    const out = truncateHead('x\uDE00' + 'y'.repeat(10), 5);
    expect(lone(out)).toEqual([]);
    expect(out).toBe('x\ufffdyyy');
  });
});

describe('cap sites use the pair-safe cut', () => {
  test('capTextBlocks never leaves a lone surrogate at the cut', () => {
    const blocks = capTextBlocks([{ type: 'text', text: 'a'.repeat(5999) + EMOJI + 'b'.repeat(100) }], 6000);
    const text = (blocks[0] as { text: string }).text;
    expect(lone(text)).toEqual([]);
  });

  test('markUntrustedToolFailure never leaves a lone surrogate at the cut', () => {
    const out = markUntrustedToolFailure('some_tool', undefined, 'a'.repeat(5999) + EMOJI + 'b'.repeat(100), 6000);
    expect(lone(out)).toEqual([]);
  });
});
