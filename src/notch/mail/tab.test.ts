import { describe, expect, test } from 'bun:test';
import { MailSignedOut, MailTabTurn, mailTabBrowser } from './tab.ts';

describe('the tab as a browser', () => {
  test('goes where it is sent and hears what a script answered', async () => {
    const calls: unknown[] = [];
    const browser = mailTabBrowser(async (method, params) => { calls.push([method, params]); return method === 'mail_tab_navigate' ? { site: 'mail' } : 'what the page said'; });
    await browser.navigate('https://mail.google.com/mail/u/0/');
    expect(await browser.evaluate('1 + 1')).toBe('what the page said');
    expect(calls).toEqual([['mail_tab_navigate', { url: 'https://mail.google.com/mail/u/0/' }], ['mail_tab_evaluate', { expression: '1 + 1' }]]);
  });

  // Not signed in is "this way is not here", and the callers tell it from a failure by its kind.
  test('landing on the sign-in page, or being told so by a script call, is being signed out', async () => {
    const landed = mailTabBrowser(async () => ({ site: 'sign-in' }));
    await expect(landed.navigate('https://mail.google.com/mail/u/0/')).rejects.toBeInstanceOf(MailSignedOut);
    const told = mailTabBrowser(async () => { throw new Error('RPC failed: mail tab: signed out'); });
    await expect(told.evaluate('1')).rejects.toBeInstanceOf(MailSignedOut);
    await expect(told.navigate('https://mail.google.com/')).rejects.toBeInstanceOf(MailSignedOut);
  });

  test('landing anywhere else is a failure, and so is a call that fails', async () => {
    const elsewhere = mailTabBrowser(async () => ({ site: 'elsewhere' }));
    await expect(elsewhere.navigate('https://mail.google.com/')).rejects.toThrow('not one of the sites');
    const silent = mailTabBrowser(async () => null);
    await expect(silent.navigate('https://mail.google.com/')).rejects.toThrow('not one of the sites');
    const broken = mailTabBrowser(async () => { throw new Error('Sidecar x is not connected'); });
    await expect(broken.evaluate('1')).rejects.toThrow('not connected');
  });
});

describe('whose turn the tab is', () => {
  const gate = () => { let open!: () => void; const wait = new Promise<void>((resolve) => { open = resolve; }); return { wait, open }; };

  test('one piece of work at a time, in the order asked', async () => {
    const turn = new MailTabTurn();
    const order: string[] = [];
    const first = gate();
    const a = turn.take(async () => { order.push('a starts'); await first.wait; order.push('a ends'); return 'a'; });
    const b = turn.take(async () => { order.push('b'); return 'b'; });
    const c = turn.take(async () => { order.push('c'); return 'c'; });
    await Promise.resolve();
    expect(order).toEqual(['a starts']);
    expect(turn.taken()).toBe(true);
    first.open();
    expect(await Promise.all([a, b, c])).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a starts', 'a ends', 'b', 'c']);
    expect(turn.taken()).toBe(false);
  });

  // A reply the owner said yes to does not wait behind a look at a month of mail.
  test('what the owner is waiting on goes before what Jarvis does by itself, and never cuts into work under way', async () => {
    const turn = new MailTabTurn();
    const order: string[] = [];
    const first = gate();
    const look = turn.take(async () => { order.push('look starts'); await first.wait; order.push('look ends'); });
    const batch = turn.take(async () => { order.push('next batch'); });
    const send = turn.take(async () => { order.push('send'); }, { first: true });
    const other = turn.take(async () => { order.push('second send'); }, { first: true });
    first.open();
    await Promise.all([look, batch, send, other]);
    expect(order).toEqual(['look starts', 'look ends', 'send', 'second send', 'next batch']);
  });

  test('work that fails gives the turn up all the same', async () => {
    const turn = new MailTabTurn();
    await expect(turn.take(async () => { throw new Error('the page changed'); })).rejects.toThrow('the page changed');
    expect(turn.taken()).toBe(false);
    expect(await turn.take(async () => 'next')).toBe('next');
  });
});
