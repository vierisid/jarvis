/**
 * #723: `uiEffectHints` is shared by `ui_act`'s gate and `run_skill`'s
 * classifier. It reads a label as it is, as the card shows it, and folded for
 * matching, pairs every reading of the name with every reading of the context,
 * and keeps every category any pairing reaches.
 */
import { describe, expect, test } from 'bun:test';
import { uiEffectHints } from './ui-intent.ts';

const c = String.fromCharCode;
const ZWSP = c(0x200b);
const RLO = c(0x202e);
const SHY = c(0xad);
/** `Send` in fullwidth letters (U+FF33 U+FF45 U+FF4E U+FF44). */
const FULLWIDTH_SEND = c(0xff33, 0xff45, 0xff4e, 0xff44);

describe('#723: uiEffectHints', () => {
  test.each([
    ['plain', 'Send', ['send_email']],
    ['a zero-width space', `Se${ZWSP}nd`, ['send_email']],
    ['a bidi override', `Send${RLO}`, ['send_email']],
    ['a double space', 'Send  now', ['send_email']],
    ['a tab', `Reply${c(9)}all`, ['send_email']],
    ['an ignorable in a delete', `Del${ZWSP}ete`, ['delete_data']],
    ['an ignorable in a payment', `Pay${ZWSP} now`, ['make_payment']],
  ])('a click on a label with %s is classified as what it reads', (_label, name, expected) => {
    expect(uiEffectHints('click', name, 'Gmail')).toEqual(expected as never);
  });

  test('the mail context is read the same way, and the raw pairing is kept', () => {
    // Raw name with raw context gives what the raw-only classifier gave
    // (send_message); the reduced context adds send_email. Only adds.
    expect(uiEffectHints('click', 'Send', `Gm${ZWSP}ail`)).toEqual(['send_message', 'send_email']);
  });

  test('ordinary labels are unchanged, and the union never duplicates a category', () => {
    expect(uiEffectHints('click', 'Archive', 'Gmail')).toEqual([]);
    expect(uiEffectHints('click', 'Send', 'Slack')).toEqual(['send_message']);
    expect(uiEffectHints('press_keys', 'Message', 'Slack', 'enter')).toEqual(['send_message']);
  });
});

describe('#723 review: readings are cross-paired, and a folded reading catches more disguises', () => {
  test('a name that matches only reduced, in a context that matches mail only as written, is a send_email', () => {
    // `x<SHY>mail` reduces to `xmail`, which loses the `\bmail\b` boundary.
    expect(uiEffectHints('click', `Se${ZWSP}nd`, `x${SHY}mail`)).toContain('send_email');
    expect(uiEffectHints('click', `Se${ZWSP}nd`, `Inbox x${SHY}mail`)).toContain('send_email');
  });

  test.each([
    ['fullwidth letters', FULLWIDTH_SEND],
    ['a combining mark', `Se${c(0x332)}nd`],
    ['a format character outside Default_Ignorable', `Se${c(0xfff9)}nd`],
    ['an Arabic number sign', `Se${c(0x600)}nd`],
    ['a trailing period', 'Send.'],
    ['a trailing ellipsis', `Send${c(0x2026)}`],
    ['a trailing Braille blank', `Send${c(0x2800)}`],
    ['a keycap mark', `Send${c(0x20e3)}`],
  ])('%s does not hide a send', (_label, name) => {
    expect(uiEffectHints('click', name, 'Gmail')).toContain('send_email');
  });

  test('fullwidth Pay and a combining mark in Delete are caught too', () => {
    expect(uiEffectHints('click', c(0xff30, 0xff41, 0xff59), 'Shop')).toContain('make_payment');
    expect(uiEffectHints('click', `De${c(0x301)}lete`, 'Files')).toContain('delete_data');
  });

  test('a cross-script look-alike is NOT caught: no reading folds confusables', () => {
    // Pinned so the docblock's stated limit stays true; a confusables fold would change this.
    expect(uiEffectHints('click', `${c(0x405)}end`, 'Gmail')).toEqual([]);
  });

  test('a hostile title of punctuation is classified in linear time', () => {
    // Measured: 6.8 s for these two calls with the anchored-regex trim, 2 ms
    // with the scan. The bound sits two orders of magnitude from each.
    const title = `a${'-'.repeat(80_000)}a`;
    const t0 = performance.now();
    uiEffectHints('click', 'Send', title);
    uiEffectHints('press_keys', 'x', title, title);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  test('press_keys values are read every way too', () => {
    expect(uiEffectHints('press_keys', 'Message', 'Slack', `En${ZWSP}ter`)).toEqual(['send_message']);
    expect(uiEffectHints('press_keys', 'Message', `Sl${ZWSP}ack`, 'enter')).toEqual(['send_message']);
  });
});
