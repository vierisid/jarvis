/**
 * #723: `uiEffectHints` is shared by `ui_act`'s gate and `run_skill`'s
 * classifier. It reads a label as it is, as the card shows it, and folded for
 * matching, pairs every reading of the name with every reading of the context,
 * and keeps every category any pairing reaches.
 */
import { describe, expect, test } from 'bun:test';
import { confusableSkeleton, skeletonPattern, uiEffectHints, uiEffectHintsWithoutSkeleton } from './ui-intent.ts';
import { CONFUSABLE_PROTOTYPES } from './confusables-data.ts';
import { buildTable } from '../../scripts/gen-confusables.ts';

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

  test('a cross-script look-alike is caught by the skeleton reading (#794)', () => {
    // #723 pinned this as the stated limit ([] here). #794 added the UTS #39
    // skeleton reading, so the Cyrillic U+0405 S now reads as the S it looks like.
    expect(uiEffectHints('click', `${c(0x405)}end`, 'Gmail')).toEqual(['send_email']);
  });

  test('a hostile title of punctuation is classified in linear time', () => {
    // Measured: 6.8 s for these two calls with the anchored-regex trim, 2 ms
    // with the scan. The bound sits two orders of magnitude from each.
    // #794's skeleton pass measured 7-16 ms for the same two calls (2 ms
    // before it), still more than an order of magnitude under the bound.
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

/**
 * #794. A cross-script look-alike read as the real word to a person and got no
 * category, so a button that sends was approved as if it did nothing notable.
 * The skeleton reading (UTS #39) closes that, and can only ADD a category.
 */
describe('#794: a confusable look-alike is classified as what it looks like', () => {
  test.each([
    ['Send with a Cyrillic capital S (U+0405)', `${c(0x405)}end`, 'Gmail', 'send_email'],
    ['Submit with a Turkish dotless i (U+0131)', `Subm${c(0x131)}t`, 'Gmail', 'send_email'],
    ['Send with a Cyrillic small e (U+0435)', `S${c(0x435)}nd`, 'Slack', 'send_message'],
    ['Pay with a Cyrillic small a (U+0430)', `P${c(0x430)}y`, 'Shop', 'make_payment'],
    ['Delete with a Cyrillic small ie (U+0435)', `D${c(0x435)}lete`, 'Files', 'delete_data'],
    ['Delete with a capital I for the l', 'DeIete', 'Files', 'delete_data'],
    ['Submit with rn for the m', 'Subrnit', 'Gmail', 'send_email'],
    ['SUBMIT in capitals with a Cyrillic capital I (U+0406)', `SUBM${c(0x406)}T`, 'Gmail', 'send_email'],
  ])('%s', (_label, name, context, expected) => {
    expect(uiEffectHintsWithoutSkeleton('click', name, context)).not.toContain(expected as never);
    expect(uiEffectHints('click', name, context)).toContain(expected as never);
  });

  test('a look-alike in the app name still makes a send an email', () => {
    // `Gmail` with a Cyrillic small a: the context reading folds the same way.
    expect(uiEffectHints('click', 'Send', `Gm${c(0x430)}il`)).toContain('send_email');
  });

  test('the skeleton reading only adds: every category found without it is still found', () => {
    const names = ['Send', 'Pay now', 'Delete', 'Apply', 'Reply all', `Se${ZWSP}nd`, FULLWIDTH_SEND, 'Archive', `${c(0x405)}end`,
      'Subrnit', 'Save changes', 'Grant', 'Purchase', 'Trash', 'Forward', 'x', '', 'Tweet'];
    const contexts = ['Gmail', 'Slack', 'Notes', `x${SHY}mail`, 'Teams chat', ''];
    for (const n of names) for (const ctx of contexts) {
      for (const [action, value] of [['click', ''], ['press_keys', 'enter'], ['press_keys', 'ctrl+enter']] as const) {
        const without = uiEffectHintsWithoutSkeleton(action, n, ctx, value);
        expect(uiEffectHints(action, n, ctx, value)).toEqual(expect.arrayContaining(without));
      }
    }
  });

  test('a label only the plain readings classify keeps its category: the skeleton is a union, not a replacement', () => {
    // The skeleton maps `|` to `l`, which removes the word boundary after
    // Delete, so a skeleton-only classifier would miss this one.
    expect(confusableSkeleton('Delete|x')).toBe('Deletelx');
    expect(uiEffectHints('click', 'Delete|x', 'Files')).toContain('delete_data');
  });

  test('ordinary labels gain nothing: measured over 81 common labels in four apps', () => {
    const labels = ['Close', 'Cancel', 'OK', 'Next', 'Back', 'Search', 'Settings', 'Open', 'Archive', 'Save draft', 'Compose',
      'Inbox', 'Refresh', 'Help', 'Menu', 'Home', 'Profile', 'Log in', 'Sign in', 'Sign up', 'Continue', 'Done', 'Edit',
      'Copy', 'Paste', 'Undo', 'Redo', 'Print', 'Download', 'Upload', 'Attach', 'More', 'Filter', 'Sort', 'View',
      'Mark as read', 'Star', 'Snooze', 'Move', 'Label', 'Like', 'Comment', 'Follow', 'Join', 'Leave', 'Mute', 'Accept',
      'Decline', 'Confirm', 'Submit', 'Send', 'Pay', 'Delete', 'Remove', 'Apply', 'Allow access', 'Payment', 'Display',
      'Spam', 'Rename', 'Summary', 'Prepay', 'Delegate', 'Public', 'Payroll', 'Remind me', 'Reply all', 'Forward', 'Post',
      'Share', 'Publish', 'Tweet', 'Buy', 'Checkout', 'Subscribe', 'Unsubscribe', 'Trash', 'Erase', 'Discard',
      'Uninstall', 'Ignore'];
    expect(labels).toHaveLength(81);
    for (const l of labels) for (const ctx of ['Gmail', 'Slack', 'Notepad', 'Shop']) {
      expect(uiEffectHints('click', l, ctx).sort()).toEqual(uiEffectHintsWithoutSkeleton('click', l, ctx).sort());
    }
  });
});

describe('#794: the skeleton and its data', () => {
  test('the skeleton maps look-alikes to their prototype, as UTS #39 defines it', () => {
    expect(confusableSkeleton(`${c(0x405)}end`)).toBe('Send');
    expect(confusableSkeleton(`subm${c(0x131)}t`)).toBe('subrnit');
    expect(confusableSkeleton('submit')).toBe('subrnit');
    expect(confusableSkeleton('Il1|')).toBe('llll');
  });

  test('the generated table holds exactly what can reach an ASCII match', () => {
    const hasAscii = (t: string) => [...t.normalize('NFKD')].some((ch) => ch.codePointAt(0)! < 0x80);
    expect(CONFUSABLE_PROTOTYPES.length).toBe(3007);
    for (const [source, target] of CONFUSABLE_PROTOTYPES) expect(hasAscii(source) || hasAscii(target)).toBe(true);
    const map = new Map(CONFUSABLE_PROTOTYPES);
    expect(map.get(c(0x405))).toBe('S');
    expect(map.get(c(0x131))).toBe('i');
    expect(map.get('m')).toBe('rn');
    // A mixed prototype is kept: its ASCII letter can complete a word (#794 review).
    expect(map.get(c(0x147a))).toBe(`${c(0xb7)}d`);
  });

  test('the generator keeps ASCII-reaching MA lines and drops the rest', () => {
    const sample = [
      '0405 ;\t0053 ;\tMA\t# ( S -> S ) CYRILLIC CAPITAL LETTER DZE',
      '006D ;\t0072 006E ;\tMA\t# ( m -> rn )',
      '05AD ;\t0596 ;\tMA\t# Hebrew accent to Hebrew accent: no ASCII side',
      '147A ;\t00B7 0064 ;\tMA\t# a mixed prototype',
      '# a comment',
    ].join('\n');
    expect(buildTable(sample)).toEqual([['m', 'rn'], [c(0x405), 'S'], [c(0x147a), `${c(0xb7)}d`]]);
  });
});

/**
 * #794 review. The first cut dropped mixed prototypes, missed all-capitals
 * look-alikes of words with m or i, did not fold a skeleton's edge punctuation
 * or marks, and paid the full product of readings.
 */
describe('#794 review: the skeleton reading covers what the first cut missed', () => {
  test.each([
    ['a mixed prototype (U+147A -> middle dot + d)', `${c(0x147a)}elete`, 'Files', 'delete_data'],
    ['a mixed prototype (U+044A -> macron + b)', `${c(0x44a)}uy`, 'Shop', 'make_payment'],
    ['a mixed prototype (U+1476 -> middle dot + P)', `${c(0x1476)}ay`, 'Shop', 'make_payment'],
    ['capitals with a Greek capital Mu', `SUB${c(0x39c)}IT`, 'Gmail', 'send_email'],
    ['capitals with a Cyrillic capital Em', `SUB${c(0x41c)}IT`, 'Gmail', 'send_email'],
    ['capitals with a palochka for the I', `SUBM${c(0x4c0)}T`, 'Gmail', 'send_email'],
    ['capitals with a Greek capital Mu in Remove', `RE${c(0x39c)}OVE`, 'Files', 'delete_data'],
    ['a prototype with edge punctuation (U+01A4 -> apostrophe + P)', `${c(0x1a4)}ost`, 'Slack', 'send_message'],
    ['a prototype with edge punctuation (U+01AC -> apostrophe + T)', `${c(0x1ac)}weet`, 'Slack', 'send_message'],
    ['a prototype with inner punctuation (U+0187 -> C + apostrophe)', `${c(0x187)}heckout`, 'Shop', 'make_payment'],
    ['a prototype with a combining mark (U+0257 -> d + mark)', `Sen${c(0x257)}`, 'Slack', 'send_message'],
  ])('%s', (_label, name, context, expected) => {
    expect(uiEffectHints('click', name, context)).toContain(expected as never);
  });

  test('an all-capitals look-alike app name is still a mail app, and an all-capitals word is matched case-sensitively', () => {
    // The plain reading still adds send_message: GMAIL with a Greek Mu is no
    // mail app as written. The skeleton adds send_email; nothing is removed.
    expect(uiEffectHints('click', 'Send', `G${c(0x39c)}AIL`)).toContain('send_email');
    // MALL is not MAIL: the upper-case skeleton of MAIL is MAlL, and it is case-sensitive.
    expect(uiEffectHints('click', 'Send', 'MALL')).toEqual(['send_message']);
  });

  test('a large name, title and value together are classified within the bound', () => {
    // 70k characters whose readings all differ (a soft hyphen in every word).
    // Measured: 57 ms (click) and 40 ms (press_keys) with the first cut's full
    // product of readings, 26 and 13 ms now; a click on Send and an Enter
    // under such a title, which must read it, 40 and 20 ms (3 and 2 ms before
    // #794). At 350k characters the worst measured was 109 ms: linear.
    const big = (ch: string) => `${ch}${'Se\u00adnd '.repeat(10_000)}${'-'.repeat(10_000)}`;
    const t0 = performance.now();
    uiEffectHints('click', big('A'), big('B'), big('C'));
    uiEffectHints('press_keys', big('D'), big('E'), big('F'));
    uiEffectHints('click', 'Send', big('G'));
    uiEffectHints('press_keys', 'x', big('H'), 'enter');
    expect(performance.now() - t0).toBeLessThan(250);
  });

  test('a pattern the skeleton rewrite cannot handle is refused at load, not silently rewritten', () => {
    expect(() => skeletonPattern(/[m]ail/i, false)).toThrow('cannot handle');
    expect(() => skeletonPattern(/\p{L}/u, false)).toThrow('cannot handle');
    expect(() => skeletonPattern(/Mail/, false)).toThrow('upper-case');
    expect(skeletonPattern(/\bmail\b/i, false).source).toBe('\\brnail\\b');
    expect(skeletonPattern(/\bmail\b/i, true).source).toBe('\\bMAlL\\b');
  });
});
