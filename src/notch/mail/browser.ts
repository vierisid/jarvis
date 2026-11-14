/**
 * Jarvis's own browser, as the mail reader uses it.
 *
 * Mail cannot come through Google's permission, so it is read in the browser
 * the desktop app drives, where the person signed in to Gmail once. The
 * reader needs two things of that browser: go to an address, and run a script
 * in the page and hear what it returned.
 *
 * What a script returns comes back through the desktop app, which cuts any
 * answer at 20,000 characters (it is text the page controls). A thread is
 * longer than that, so a long answer is left in the page and read in pieces.
 */

export interface MailBrowser {
  /** Goes to an address in Jarvis's own browser. */
  navigate(url: string, options?: { headless?: boolean }): Promise<void>;
  /** Runs an expression in the page and gives back what it returned, as text. */
  evaluate(expression: string): Promise<string>;
}

/** How much of an answer is read at a time: under the desktop app's cut. */
export const MAIL_PIECE = 16_000;
/** The most a single answer may be, as it travels. A thread of a hundred long messages is under it. */
export const MAIL_ANSWER_MAX = 6_000_000;

/** Only Gmail is ever opened by the reader. */
export function gmailAddress(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'mail.google.com' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** An address in a reason is where the person was: it is never repeated. */
export function withoutAddresses(reason: string): string {
  return reason.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '(an address)');
}

const PIECE_SHAPE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Runs a script whose answer may be long. `body` is the body of an async
 * function: it may `await`, and what it returns is the answer (anything but
 * a string is given back as JSON).
 *
 * The answer is left in the page under a name of its own, read in pieces, and
 * removed. It travels as base64, so that a piece is exactly as long as it
 * says whatever language the mail is in: the desktop app counts characters,
 * and a quoted piece of text grows by an amount nobody can know beforehand.
 */
export async function evaluateLong(browser: MailBrowser, body: string): Promise<string> {
  const slot = JSON.stringify(`__jarvisMail${Math.random().toString(36).slice(2, 10)}`);
  const length = Number(await browser.evaluate(
    `(async () => { const answer = await (async () => { ${body}\n })(); `
    + `const text = typeof answer === 'string' ? answer : JSON.stringify(answer ?? null); `
    + `const bytes = new TextEncoder().encode(text); let binary = ''; `
    + `for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000)); `
    + `window[${slot}] = btoa(binary); return window[${slot}].length; })()`,
  ));
  const forget = () => browser.evaluate(`delete window[${slot}]; 0`).then(() => {}, () => {});
  if (!Number.isInteger(length) || length < 0) throw new Error('the page did not answer');
  if (length > MAIL_ANSWER_MAX) {
    await forget();
    throw new Error(`the page answered with more than is read (${length} characters)`);
  }
  let text = '';
  try {
    for (let at = 0; at < length; at += MAIL_PIECE) {
      const piece = await browser.evaluate(`window[${slot}].slice(${at}, ${at + MAIL_PIECE})`);
      // A piece that is short, long or not what was left there means the page
      // changed under the reading, or the answer was cut on the way.
      if (piece.length !== Math.min(MAIL_PIECE, length - at) || !PIECE_SHAPE.test(piece)) {
        throw new Error('the answer did not come back whole');
      }
      text += piece;
    }
  } finally {
    await forget();
  }
  return Buffer.from(text, 'base64').toString('utf8');
}
