import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { MAIL_WHY_DRAFT_THERE } from './mailbox.ts';

/**
 * The script that writes, sends and throws away one reply (./page/reply.js),
 * run as it is on a stand-in for a thread in Gmail: the thread's heading, one
 * mail, the Reply link, and a reply with its own frame (the fields a mail is
 * sent with, who it goes to, the text, Send and the bin).
 *
 * The stand-in is built from what the script itself looks for. It is not
 * Gmail: what it proves is the order of the script's own checks.
 */
const source = readFileSync(join(import.meta.dir, 'page', 'reply.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...names: string[]) => (...values: unknown[]) => Promise<Record<string, unknown>>;

const THREAD = '19a1b2c3d4e5f601';
const LEO = 'leo@lumen.example';
const TEXT = 'Hi Leo,\nThursday works.\nSam';

interface Draft {
  /** Who the reply goes to. */
  to: string[];
  /** The words in it, a line each. */
  lines?: string[];
}

function thread(options: {
  /** A reply that is open when the script begins: somebody's draft. */
  open?: Draft;
  /** What pressing Reply brings up. */
  reply?: Draft;
  /** Whether Gmail says "Message sent" when Send is pressed, and whether the reply closes. */
  says?: boolean;
  closes?: boolean;
  /** Words that stand in the thread itself, in a mail somebody sent. */
  mail?: string;
  /** A bin that belongs to something else in the thread. */
  strayBin?: boolean;
} = {}) {
  const window = new Window();
  const document = window.document;
  // What is shown has a place on the page: that is how the script tells.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', { configurable: true, get(this: { isConnected: boolean; parentElement: unknown }) { return this.isConnected ? this.parentElement : null; } });
  const pressed = { reply: 0, send: 0, bin: 0, stray: 0 };
  document.body.innerHTML = `
    <h2 data-legacy-thread-id="${THREAD}">Deck</h2>
    <div data-legacy-message-id="m1"><span email="${LEO}">Leo</span><div>${options.mail ?? 'Does Thursday work?'}</div></div>
    ${options.strayBin ? '<div role="button" id="stray" aria-label="Discard draft">x</div>' : ''}
    <span class="ams bkH" role="link" id="reply">Reply</span>
    <div id="replies"></div>`;
  const frameOf = (draft: Draft): string => `
    <div class="frame"><input name="composeid" value="c1">
      ${draft.to.map((address) => `<span email="${address}">${address}</span>`).join('')}
      <div contenteditable="true" role="textbox">${(draft.lines ?? []).map((line) => `<div>${line}</div>`).join('')}<div class="gmail_signature">Sam Rossi</div><div class="gmail_quote">Does Thursday work?</div></div>
      <div role="button" class="send" aria-label="Send (Ctrl-Enter)">Send</div>
      <div role="button" class="bin" data-tooltip="Discard draft (Ctrl-Shift-D)">x</div>
    </div>`;
  const replies = document.getElementById('replies')!;
  const wire = (): void => {
    const frame = replies.querySelector('.frame');
    frame?.querySelector('.bin')?.addEventListener('click', () => { pressed.bin++; frame.remove(); });
    frame?.querySelector('.send')?.addEventListener('click', () => {
      pressed.send++;
      if (options.closes !== false) frame.remove();
      if (options.says !== false) document.body.insertAdjacentHTML('beforeend', '<div class="toast">Message sent</div>');
    });
  };
  if (options.open) { replies.innerHTML = frameOf(options.open); wire(); }
  document.getElementById('reply')!.addEventListener('click', () => {
    pressed.reply++;
    if (!replies.querySelector('.frame')) { replies.innerHTML = frameOf(options.reply ?? { to: [LEO] }); wire(); }
  });
  document.getElementById('stray')?.addEventListener('click', () => { pressed.stray++; });
  // Typing: each line lands above what Gmail put in the reply by itself.
  (document as unknown as { execCommand: (name: string, ui: boolean, value?: string) => boolean }).execCommand = (name, _ui, value) => {
    const box = document.querySelector('[contenteditable="true"]');
    if (!box || name !== 'insertText') return true;
    const line = document.createElement('div');
    line.textContent = value ?? '';
    box.insertBefore(line, box.querySelector('.gmail_signature'));
    return true;
  };
  const run = (step: string, args: { to?: string[]; cc?: string[]; text?: string } = {}) =>
    new AsyncFunction('args', 'document', 'window', 'MouseEvent', 'getSelection', 'setTimeout', source)(
      { do: step, thread: THREAD, to: args.to ?? [LEO], cc: args.cc ?? [], text: args.text ?? TEXT },
      document, window, window.MouseEvent, () => window.getSelection(), (fn: () => void) => { fn(); return 0; });
  const box = () => document.querySelector('[contenteditable="true"]');
  return { run, pressed, box, words: (): string[] => [...(box()?.children ?? [])].filter((node) => !node.className).map((node) => node.textContent ?? '') };
}

describe('writing a reply into its thread', () => {
  test('a thread with no reply open: Reply is pressed, the words are written, and it says it opened one', async () => {
    const page = thread();
    expect(await page.run('write')).toMatchObject({ ok: true, written: true, opened: true });
    expect(page.pressed.reply).toBe(1);
    expect(page.words()).toEqual(['Hi Leo,', 'Thursday works.', 'Sam']);
  });

  // README 156: a draft that is already in a thread is somebody's. It was answered "not the expected
  // people" when the owner had changed who it goes to, and whoever asked then threw it away.
  test('the owner\'s own draft, to other people: it is a draft that is there, said before who it goes to is looked at', async () => {
    const page = thread({ open: { to: ['anna@acme.example', 'tony@acme.example'], lines: ['Anna, about Thursday: I would rather'] } });
    expect(await page.run('write')).toMatchObject({ ok: false, why: MAIL_WHY_DRAFT_THERE, opened: false });
    expect(page.pressed.reply).toBe(0);
    expect(page.words()).toEqual(['Anna, about Thursday: I would rather']);
  });

  test('a reply that was open before, even with no words in it, is not written into', async () => {
    const page = thread({ open: { to: [LEO] } });
    expect(await page.run('write')).toMatchObject({ ok: false, why: MAIL_WHY_DRAFT_THERE, opened: false });
    expect(page.words()).toEqual([]);
  });

  test('a draft Gmail brings up when Reply is pressed, with words and other people: a draft that is there', async () => {
    const page = thread({ reply: { to: ['anna@acme.example'], lines: ['Half a sentence'] } });
    expect(await page.run('write')).toMatchObject({ ok: false, why: MAIL_WHY_DRAFT_THERE, opened: true });
    expect(page.words()).toEqual(['Half a sentence']);
  });

  test('an empty reply that goes to somebody else is refused for that, and nothing is written', async () => {
    const page = thread({ reply: { to: ['anna@acme.example'] } });
    expect(await page.run('write')).toMatchObject({ ok: false, why: 'the reply does not go to exactly the expected people', opened: true });
    expect(page.words()).toEqual([]);
  });
});

describe('throwing a reply away', () => {
  test('the reply that was written here is thrown away', async () => {
    const page = thread();
    await page.run('write');
    expect(await page.run('discard')).toMatchObject({ ok: true, discarded: true });
    expect(page.pressed.bin).toBe(1);
    expect(page.box()).toBeNull();
  });

  test('an earlier one of ours that did not go is thrown away too: it begins with the same words', async () => {
    const page = thread({ open: { to: [LEO], lines: ['Hi Leo,', 'Thursday works.', 'Sam'] } });
    expect(await page.run('write')).toMatchObject({ ok: false, why: MAIL_WHY_DRAFT_THERE });
    expect(await page.run('discard')).toMatchObject({ ok: true, discarded: true });
  });

  test('a reply opened here that holds no words is thrown away', async () => {
    const page = thread({ reply: { to: ['anna@acme.example'] } });
    await page.run('write');
    expect(await page.run('discard')).toMatchObject({ ok: true, discarded: true });
    expect(page.box()).toBeNull();
  });

  test('somebody\'s draft is never thrown away: the bin is not pressed, and the words stay', async () => {
    const page = thread({ open: { to: ['anna@acme.example', 'tony@acme.example'], lines: ['Anna, about Thursday: I would rather'] } });
    expect(await page.run('discard')).toMatchObject({ ok: false, why: 'the reply being written is not the one that was written here', kept: true });
    expect(page.pressed.bin).toBe(0);
    expect(page.words()).toEqual(['Anna, about Thursday: I would rather']);
  });

  test('only the bin of this reply is pressed, not the first one in the thread', async () => {
    const page = thread({ strayBin: true });
    await page.run('write');
    expect(await page.run('discard')).toMatchObject({ ok: true, discarded: true });
    expect(page.pressed).toMatchObject({ stray: 0, bin: 1 });
  });

  test('nothing is being written: nothing to throw away, and that is no failure', async () => {
    expect(await thread().run('discard')).toMatchObject({ ok: true, discarded: false });
  });
});

// README 62: sent means it is the last word in its thread. The page says two smaller things:
// whether Send was pressed, and whether Gmail said it went.
describe('pressing Send on a reply', () => {
  test('Gmail says it went: pressed, and said', async () => {
    const page = thread();
    await page.run('write');
    expect(await page.run('send')).toMatchObject({ ok: true, pressed: true, said: true, closed: true });
    expect(page.pressed.send).toBe(1);
  });

  test('the reply closing is not Gmail saying it went', async () => {
    const page = thread({ says: false });
    await page.run('write');
    expect(await page.run('send')).toMatchObject({ ok: false, why: 'Gmail did not say it was sent', pressed: true, closed: true });
    expect(page.pressed.send).toBe(1);
  });

  test('words in the thread that read like Gmail\'s are not Gmail saying so', async () => {
    const page = thread({ mail: 'Your message has been sent to the team. Does Thursday work?', says: false, closes: false });
    await page.run('write');
    expect(await page.run('send')).toMatchObject({ ok: false, pressed: true, closed: false });
  });

  test('a reply that goes to somebody else, or is not the one shown: Send is not pressed, and the answer says so', async () => {
    const page = thread();
    await page.run('write');
    expect(await page.run('send', { to: ['anna@acme.example'] })).toMatchObject({ ok: false, why: 'the reply does not go to exactly the expected people', pressed: false });
    expect(await page.run('send', { text: 'Something else' })).toMatchObject({ ok: false, why: 'the reply is not the one that was shown', pressed: false });
    expect(page.pressed.send).toBe(0);
    expect(await thread().run('send')).toMatchObject({ ok: false, why: 'no reply is being written', pressed: false });
  });
});
