import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The last check before Send is pressed, run on a stand-in for Gmail's
 * writing window: a subject field, the people it is addressed to, and a
 * Send button that says "Message sent" when it is pressed.
 */
const source = readFileSync(join(import.meta.dir, 'page', 'compose-send.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...names: string[]) => (...values: unknown[]) => Promise<{ sent: boolean; why: string; people?: number }>;

async function compose(args: { subject: string; to: string | string[] }, window: { subject?: string; chips?: string[]; typed?: string; sends?: boolean; holds?: string } = {}) {
  let pressed = 0;
  const body = { innerText: window.holds ?? '' };
  const node = (attrs: Record<string, string>, value = '') => ({ offsetParent: {}, value, getAttribute: (name: string) => attrs[name] ?? null });
  const people = [...(window.chips ?? []).map((address) => node({ 'data-hovercard-id': address })), ...(window.typed ? [node({}, window.typed)] : [])];
  const form = { querySelectorAll: () => people };
  const subject = { ...node({}, window.subject ?? 'Following up on our call'), closest: () => form };
  const send = {
    ...node({ 'aria-label': 'Send ‪(Ctrl-Enter)‬' }),
    dispatchEvent: (event: { type: string }) => { if (event.type === 'click') { pressed++; if (window.sends !== false) body.innerText = 'Message sent'; } return true; },
  };
  const document = { body, querySelectorAll: (selector: string) => (selector.includes('subjectbox') ? [subject] : selector.includes('role="button"') ? [send] : []) };
  class Mouse { constructor(readonly type: string) {} }
  const run = new AsyncFunction('args', 'document', 'window', 'MouseEvent', 'setTimeout', source);
  const said = await run(args, document, {}, Mouse, (fn: () => void) => { fn(); return 0; });
  return { said, pressed };
}

describe('pressing Send on a new mail', () => {
  const subject = 'Following up on our call';

  test('one mail to the one expected person is sent, once', async () => {
    const { said, pressed } = await compose({ subject, to: 'Sam@Northwind.example' }, { chips: ['sam@northwind.example'] });
    expect(said.sent).toBe(true);
    expect(pressed).toBe(1);
  });

  test('a mail to several goes only when it is addressed to exactly those people', async () => {
    const to = ['sam@northwind.example', 'leo@lumen.example', 'anna@acme.example'];
    expect((await compose({ subject, to }, { chips: ['leo@lumen.example', 'anna@acme.example', 'sam@northwind.example'] })).said.sent).toBe(true);
    // One is missing, one too many, one swapped for somebody else, and one more typed into the field by hand.
    for (const chips of [['sam@northwind.example', 'leo@lumen.example'], [...to, 'tony@acme.example'], ['sam@northwind.example', 'leo@lumen.example', 'tony@acme.example']]) {
      const { said, pressed } = await compose({ subject, to }, { chips });
      expect(said).toMatchObject({ sent: false, why: 'it does not go to exactly the expected people' });
      expect(pressed).toBe(0);
    }
    const typed = await compose({ subject, to }, { chips: to, typed: 'tony@acme.example' });
    expect(typed.said.sent).toBe(false);
    expect(typed.pressed).toBe(0);
  });

  test('to nobody, to somebody else, or another mail: Send is not pressed', async () => {
    const cases: [{ subject: string; to: string | string[] }, { chips: string[]; subject?: string }][] = [
      [{ subject, to: 'sam@northwind.example' }, { chips: ['leo@lumen.example'] }],
      [{ subject, to: 'sam@northwind.example' }, { chips: ['sam@northwind.example', 'leo@lumen.example'] }],
      [{ subject, to: 'sam@northwind.example' }, { chips: [] }],
      [{ subject, to: [] }, { chips: [] }],
      [{ subject, to: 'sam@northwind.example' }, { chips: ['sam@northwind.example'], subject: 'Another mail' }],
    ];
    for (const [args, window] of cases) {
      const { said, pressed } = await compose(args, window);
      expect(said.sent).toBe(false);
      expect(pressed).toBe(0);
    }
  });

  test('when Gmail does not say it went, it is not called sent', async () => {
    const { said, pressed } = await compose({ subject, to: 'sam@northwind.example' }, { chips: ['sam@northwind.example'], sends: false });
    expect(said).toMatchObject({ sent: false, why: 'Gmail did not say it was sent' });
    expect(pressed).toBe(1);
  });

  // Whoever asked has to know whether the mail may be on its way: a refusal before Send sent nothing.
  test('the answer says whether Send was pressed', async () => {
    expect((await compose({ subject, to: 'sam@northwind.example' }, { chips: ['sam@northwind.example'] })).said).toMatchObject({ sent: true, pressed: true });
    expect((await compose({ subject, to: 'sam@northwind.example' }, { chips: ['sam@northwind.example'], sends: false })).said).toMatchObject({ sent: false, pressed: true });
    expect((await compose({ subject, to: 'sam@northwind.example' }, { chips: ['leo@lumen.example'] })).said).not.toHaveProperty('pressed');
  });

  // The words were looked for anywhere on the page: a mail that itself says them was called sent.
  test('a mail that itself says "message sent" is not Gmail saying so', async () => {
    const { said, pressed } = await compose({ subject, to: 'sam@northwind.example' }, { chips: ['sam@northwind.example'], sends: false, holds: 'Hi Sam, your message has been sent to the team.' });
    expect(said).toMatchObject({ sent: false, pressed: true });
    expect(pressed).toBe(1);
  });
});
