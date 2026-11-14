import { describe, expect, test } from 'bun:test';
import { MAIL_ANSWER_MAX, MAIL_PIECE, evaluateLong, gmailAddress, withoutAddresses, type MailBrowser } from './browser.ts';

/**
 * A page that really runs what it is handed, and cuts every answer the way
 * the desktop app does: at 20,000 characters, with a note after the cut.
 */
function page(options: { cut?: number } = {}) {
  const window: Record<string, unknown> = {};
  const asked: string[] = [];
  const browser: MailBrowser = {
    navigate: async () => {},
    evaluate: async (expression) => {
      asked.push(expression);
      const value = await new Function('window', 'btoa', 'TextEncoder', `return (${expression.replace(/^delete (window\[[^\]]+\]); 0$/, '(delete $1, 0)')});`)(window, btoa, TextEncoder);
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const cut = options.cut ?? 20_000;
      return text.length <= cut ? text : `${text.slice(0, cut)}... (${text.length - cut} chars truncated)`;
    },
  };
  return { browser, window, asked };
}

describe('a long answer from the page', () => {
  test('comes back whole, in pieces, whatever it is written in', async () => {
    const mail = { subject: 'Perché no? 日本語 😀 "quoted"\n\\', body: 'è'.repeat(30_000) + '\u0000\u2028' };
    const { browser, window, asked } = page();
    const answer = await evaluateLong(browser, `return ${JSON.stringify(mail)};`);
    expect(JSON.parse(answer)).toEqual(mail);
    // Three or more readings, each under the cut, and nothing left in the page.
    expect(asked.filter((expression) => expression.includes('.slice(')).length).toBeGreaterThan(2);
    expect(Object.keys(window)).toEqual([]);
  });

  test('a string is given back as it is, an awaited one too, and nothing as null', async () => {
    expect(await evaluateLong(page().browser, `return '12345';`)).toBe('12345');
    expect(await evaluateLong(page().browser, `return await Promise.resolve('later');`)).toBe('later');
    expect(await evaluateLong(page().browser, `return;`)).toBe('null');
    expect(await evaluateLong(page().browser, `return '';`)).toBe('');
  });

  test('a piece that was cut on the way is refused, and the page is cleaned', async () => {
    const { browser, window } = page({ cut: MAIL_PIECE - 1 });
    await expect(evaluateLong(browser, `return 'x'.repeat(40000);`)).rejects.toThrow('did not come back whole');
    expect(Object.keys(window)).toEqual([]);
  });

  test('an answer past the most that is read is refused before a piece is read', async () => {
    const { browser, window, asked } = page();
    await expect(evaluateLong(browser, `return 'x'.repeat(${MAIL_ANSWER_MAX});`)).rejects.toThrow('more than is read');
    expect(asked.some((expression) => expression.includes('.slice('))).toBe(false);
    expect(Object.keys(window)).toEqual([]);
  });

  test('a page that does not answer with a length is refused', async () => {
    const browser: MailBrowser = { navigate: async () => {}, evaluate: async () => '(no return value)' };
    await expect(evaluateLong(browser, `return 1;`)).rejects.toThrow('did not answer');
  });

  test('a script that throws says so, and nothing is read', async () => {
    await expect(evaluateLong(page().browser, `throw new Error('no list here');`)).rejects.toThrow('no list here');
  });
});

describe('where the reader may go', () => {
  test('only Gmail, over https, with nobody named in the address', () => {
    expect(gmailAddress('https://mail.google.com/mail/u/0/#inbox')).toBe(true);
    for (const url of [
      'http://mail.google.com/mail/u/0/', 'https://mail.google.com.example.org/', 'https://example.org/?u=https://mail.google.com/',
      'https://someone@mail.google.com/', 'https://accounts.google.com/', 'javascript:alert(1)', 'file:///C:/Users/x', '', 'mail.google.com',
    ]) expect(gmailAddress(url)).toBe(false);
  });

  test('a reason never repeats an address', () => {
    expect(withoutAddresses('the page navigated to https://mail.google.com/mail/u/0/#search/from%3Asam while it was being read'))
      .toBe('the page navigated to (an address) while it was being read');
    expect(withoutAddresses('nothing to hide')).toBe('nothing to hide');
  });
});
