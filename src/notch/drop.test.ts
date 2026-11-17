import { describe, expect, test } from 'bun:test';
import type { NotchAskFile } from './asks.ts';
import { NOTCH_DROP_MAX_BYTES, attachNotchDrop, dropName, dropQuestion, dropVerdict } from './drop.ts';
import type { NotchDropped } from './drop.ts';
import { NotchInbox } from './inbox.ts';
import type { NotchBlock, NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import { NOTCH_DROP_PATH, notchRoutes, readNotchDrop } from './routes.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string => (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');
const MB = 1024 * 1024;

describe('whether a dropped file can be read', () => {
  // The plan: "PDF, image, text, CSV. An honest refusal for the rest."
  test('text, CSV, a PDF, a PNG and a JPEG can, by the end of their name', () => {
    expect(dropVerdict('Deck.pdf', 'application/pdf', 300_000)).toEqual({ ok: true, kind: 'document', mediaType: 'application/pdf' });
    expect(dropVerdict('payouts.CSV', 'application/vnd.ms-excel', 900)).toEqual({ ok: true, kind: 'document', mediaType: 'text/csv' });
    expect(dropVerdict('notes.md', '', 900)).toEqual({ ok: true, kind: 'document', mediaType: 'text/markdown' });
    expect(dropVerdict('server.log', '', 900)).toEqual({ ok: true, kind: 'document', mediaType: 'text/plain' });
    expect(dropVerdict('shot.png', 'image/png', 2 * MB)).toEqual({ ok: true, kind: 'image', mediaType: 'image/png' });
    expect(dropVerdict('photo.JPG', 'image/jpeg', 2 * MB)).toEqual({ ok: true, kind: 'image', mediaType: 'image/jpeg' });
    // No end to the name: what the browser says it is decides.
    expect(dropVerdict('README', 'text/plain; charset=utf-8', 900)).toEqual({ ok: true, kind: 'document', mediaType: 'text/plain' });
  });

  // The owner, 15 November 2026, after an HTML file was turned away: "we can use other files as well".
  test('a web page, a Word file, a spreadsheet, a deck and code are read as their words', () => {
    for (const name of ['page.html', 'page.HTM', 'Contract.docx', 'Payouts.xlsx', 'Pitch.pptx', 'config.yaml', 'main.go', 'query.sql', 'run.ps1']) {
      const verdict = dropVerdict(name, '', 40_000);
      expect(verdict).toMatchObject({ ok: true, kind: 'document', mediaType: 'text/plain' });
      expect((verdict as { reader?: string }).reader).toBeDefined();
    }
    expect(dropVerdict('Payouts.xlsx', '', 40_000)).toEqual({ ok: true, kind: 'document', mediaType: 'text/plain', reader: 'xlsx' });
    // No end to the name, and the browser says it is a web page.
    expect(dropVerdict('saved page', 'text/html', 900)).toEqual({ ok: true, kind: 'document', mediaType: 'text/plain', reader: 'html' });
    // These may be far larger than their words: a deck is mostly its pictures.
    expect(dropVerdict('Pitch.pptx', '', 9 * MB).ok).toBe(true);
    expect(dropVerdict('Pitch.pptx', '', 17 * MB)).toEqual({ ok: false, why: 'Pitch.pptx is larger than I can read yet: 16 MB is the most.' });
  });

  test('every kind it cannot read is refused in its own words, with what would work', () => {
    const why = (name: string): string => (dropVerdict(name, '', 40_000) as { why: string }).why;
    expect(why('Payouts.xls')).toBe('Payouts.xls is a spreadsheet of a kind I cannot read yet. Saved as .xlsx or CSV, I can.');
    expect(why('Contract.doc')).toBe('Contract.doc is a text document of a kind I cannot open yet. Saved as .docx, PDF or plain text, I can read it.');
    expect(why('Pitch.key')).toContain('a presentation');
    expect(why('Call with Anna.m4a')).toBe('Call with Anna.m4a is a sound file. I cannot listen to files yet.');
    expect(why('demo.mp4')).toContain('a video');
    expect(why('all.zip')).toContain('an archive');
    expect(why('anim.gif')).toContain('As PNG or JPEG, I can');
    expect(why('setup.exe')).toBe('setup.exe is a program. I do not read or run dropped programs.');
    expect(why('thing.xyz')).toBe('I cannot read that kind of file yet (.xyz). Text, a web page, Word, Excel, PowerPoint, CSV, a PDF, a PNG or a JPEG I can.');
    expect(why('thing')).toContain('I cannot read that kind of file yet.');
  });

  test('a file that is empty or too large is said to be so, with the limit', () => {
    expect(dropVerdict('Deck.pdf', 'application/pdf', 0)).toEqual({ ok: false, why: 'Deck.pdf is empty.' });
    expect(dropVerdict('Deck.pdf', 'application/pdf', MB + 1)).toEqual({ ok: false, why: 'Deck.pdf is larger than I can read yet: 1 MB is the most for a document.' });
    expect(dropVerdict('shot.png', 'image/png', 4 * MB + 1)).toEqual({ ok: false, why: 'shot.png is larger than I can read yet: 4 MB is the most for a picture.' });
    expect(dropVerdict('shot.png', 'image/png', 4 * MB).ok).toBe(true);
  });

  test('a name is shown without its path, on one line, and not too long', () => {
    expect(dropName('C:\\Users\\sam\\Desktop\\Deck  v3.pdf')).toBe('Deck v3.pdf');
    expect(dropName('/home/sam/notes\n.md')).toBe('notes .md');
    expect(dropName(`${'a'.repeat(300)}.pdf`).length).toBe(120);
    expect(dropName('')).toBe('');
  });

  test('what is asked about it names it and asks for a few short lines', () => {
    expect(dropQuestion('Deck.pdf', 'document')).toBe('Summarise the file I dropped, Deck.pdf: what it is, and the points that matter, in a few short lines.');
    expect(dropQuestion('shot.png', 'image')).toContain('what the picture I dropped, shot.png, shows');
  });
});

function harness(options: { paused?: () => boolean; busy?: boolean } = {}) {
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const pushed: NotchToPage[] = [];
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = 0;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  const inbox = new NotchInbox(surface, { clock, log: () => {} });
  const asked: { text: string; files: NotchAskFile[] }[] = [];
  const told: string[] = [];
  const logs: string[] = [];
  const drop = attachNotchDrop(surface, inbox, {
    ask: (words, files) => { asked.push({ text: words, files }); },
    tell: (parts) => { told.push(text(parts)); },
    paused: options.paused, holdMs: 80, log: (line) => logs.push(line),
  });
  if (options.busy) inbox.present('something', (stage) => stage.say(['Busy with something.'], 60_000));
  const line = (): NotchLine | null => surface.current().line;
  const file = (name: string, mediaType: string, size: number, extra: Partial<NotchDropped> = {}): NotchDropped =>
    ({ name, mediaType, size, bytes: new Uint8Array(size), count: 1, ...extra });
  const blocks = (): NotchBlock[] => { const now = line(); return now && 'blocks' in now ? now.blocks ?? [] : []; };
  const answer = async (act: string, more: Record<string, unknown> = {}): Promise<void> => {
    fromPage({ type: 'answer', id: line()!.id, act, ...more });
    await settle();
  };
  return {
    drop, asked, told, logs, line, fromPage, file, inbox, answer,
    said: (): string => text(line()?.say),
    /** What the mouth was told to do, in order. */
    mouth: (): string[] => pushed.flatMap((message) => (message.type === 'act' && message.mouth ? [message.mouth] : [])),
    /** "Got it" has had its moment: the page says so, and the question about the file comes up. */
    async got(): Promise<void> {
      await settle();
      if (line()?.kind === 'say') await answer('done');
    },
    cards: (): string[] => blocks().flatMap((block) => (block.kind === 'file' ? [`${block.icon} | ${block.name} | ${block.meta}`] : [])),
    buttons: (): string[] => blocks().flatMap((block) => (block.kind === 'buttons' ? block.buttons.map((button) => `${button.key ?? '-'} ${button.label}`) : [])),
  };
}

describe('a file held over the notch', () => {
  // The owner, 16 November 2026: "the animation of the notch when I drop a file into it is not the same
  // as the one we built." The one we built is the mouth: it opens for a file, and swallows it.
  test('the notch opens its mouth, and shuts it when the file is taken away', async () => {
    const h = harness();
    h.fromPage({ type: 'drag', state: 'over' });
    await settle();
    expect(h.mouth()).toEqual(['open', 'over']);
    // No line is put up for it: the mouth says it.
    expect(h.line()).toBeNull();
    h.fromPage({ type: 'drag', state: 'left' });
    await settle();
    expect(h.mouth()).toEqual(['open', 'over', 'shut']);
    // Taken away twice is shut once.
    h.fromPage({ type: 'drag', state: 'left' });
    expect(h.mouth().length).toBe(3);
  });

  test('what is on the notch is not taken down for a file that may never be dropped', async () => {
    const h = harness({ busy: true });
    await settle();
    h.fromPage({ type: 'drag', state: 'over' });
    await settle();
    expect(h.said()).toBe('Busy with something.');
    expect(h.mouth()).toEqual(['open', 'over']);
  });

  test('a file that was let go and did not arrive is said to be lost, and the mouth shuts', async () => {
    const h = harness();
    h.fromPage({ type: 'drag', state: 'over' });
    h.fromPage({ type: 'drag', state: 'lost' });
    await settle();
    expect(h.told).toEqual(['I could not take that file. Try dropping it again.']);
    expect(h.mouth()).toEqual(['open', 'over', 'shut']);
  });

  test('with everything stopped the mouth stays shut', async () => {
    const h = harness({ paused: () => true });
    h.fromPage({ type: 'drag', state: 'over' });
    await settle();
    expect(h.mouth()).toEqual([]);
  });

  test('a message about dragging that is not one of the three is not understood', async () => {
    const h = harness();
    h.fromPage({ type: 'drag', state: 'sideways' });
    h.fromPage({ type: 'drag' });
    await settle();
    expect(h.line()).toBeNull();
    expect(h.mouth()).toEqual([]);
  });
});

describe('a file dropped on the notch', () => {
  // The owner, 16 November 2026: "right now it just gives me a summary, but it should either give me the
  // opportunity to ask a specific question about it, or give me a few options."
  test('it is swallowed, said, and then asked about: its card, three things to pick, and a field', async () => {
    const h = harness();
    h.fromPage({ type: 'drag', state: 'over' });
    expect(h.drop.take(h.file('C:\\Users\\sam\\Deck.pdf', 'application/pdf', 300_000))).toEqual({ taken: true });
    await settle();
    expect(h.mouth()).toEqual(['open', 'over', 'gulp']);
    expect(h.said()).toBe('Got Deck.pdf.');
    expect(h.line()).toMatchObject({ kind: 'say', mood: 'happy' });
    // Nothing is asked of a model yet: it waits to be told what is wanted.
    expect(h.asked).toEqual([]);
    expect(h.drop.holding()).toBe(true);
    await h.got();
    expect(h.line()).toMatchObject({ kind: 'ask', yes: 'ask', focus: true, placeholder: 'Ask about it, or hold the keys and say it' });
    expect(h.cards()).toEqual(['doc | Deck.pdf | PDF · 293 KB']);
    expect(h.buttons()).toEqual(['- Summarise it', '- Find the numbers', '- What is missing']);
    // The name of the file is the person's: sizes and kinds only in the log.
    expect(h.logs.join('\n')).not.toContain('Deck');
    expect(h.logs.join('\n')).toContain('300000 bytes');
  });

  test('one of the three is picked: that is asked, and it carries the file', async () => {
    const h = harness();
    h.drop.take(h.file('Deck.pdf', 'application/pdf', 300_000));
    await h.got();
    await h.answer('button', { button: 'ask1' });
    expect(h.asked.map((ask) => ask.text)).toEqual(['List the numbers that matter in the file I dropped, Deck.pdf, each with what it measures, in a few short lines.']);
    expect(h.asked[0]!.files.map((file) => [file.kind, file.name, file.mediaType, file.bytes.length])).toEqual([['document', 'Deck.pdf', 'application/pdf', 300_000]]);
    // Asked once: nothing is held any more, and the question about it is off the notch.
    expect(h.drop.holding()).toBe(false);
    expect(h.inbox.count()).toBe(0);
    expect(h.line()).toBeNull();
  });

  // "Sometimes I might want something specific, like I drop a deck and I ask what has changed since the last deck."
  test('his own question, typed: asked in his words, with the file', async () => {
    const h = harness();
    h.drop.take(h.file('Deck.pdf', 'application/pdf', 300_000));
    await h.got();
    await h.answer('ask', { text: '  what does slide four ask the reader to do?  ' });
    expect(h.asked.map((ask) => [ask.text, ask.files.map((file) => file.name)])).toEqual([['what does slide four ask the reader to do?', ['Deck.pdf']]]);
  });

  test('Enter on an empty field asks the first of the three', async () => {
    const h = harness();
    h.drop.take(h.file('shot.png', 'image/png', 40_000));
    await h.got();
    expect(h.cards()).toEqual(['image | shot.png | Picture · 39 KB']);
    expect(h.buttons()).toEqual(['- Describe it', '- Read the text in it', '- What stands out']);
    await h.answer('ask', { text: '' });
    expect(h.asked.map((ask) => ask.text)).toEqual(['Tell me what the picture I dropped, shot.png, shows, in a few short lines.']);
  });

  test('his own question, said with the keys held while the file waits: the words take the file', async () => {
    const h = harness();
    h.drop.take(h.file('Deck.pdf', 'application/pdf', 300_000));
    await h.got();
    // What talking does once words are in (talk.ts): it asks for what is held.
    const files = h.drop.claim();
    await settle();
    expect(files.map((file) => file.name)).toEqual(['Deck.pdf']);
    expect(h.drop.holding()).toBe(false);
    // The question about the file is gone from the notch and from the count: it was answered by voice.
    expect(h.line()).toBeNull();
    expect(h.inbox.count()).toBe(0);
    expect(h.asked).toEqual([]);
    // Nothing is handed over twice.
    expect(h.drop.claim()).toEqual([]);
  });

  test('Esc lets the file go: nothing is asked, and it is not kept', async () => {
    const h = harness();
    h.drop.take(h.file('Deck.pdf', 'application/pdf', 300_000));
    await h.got();
    await h.answer('no');
    expect(h.asked).toEqual([]);
    expect(h.drop.holding()).toBe(false);
    expect(h.drop.claim()).toEqual([]);
  });

  test('a file nobody asks about is let go after a while', async () => {
    const h = harness();
    h.drop.take(h.file('Deck.pdf', 'application/pdf', 300_000));
    await h.got();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await settle();
    expect(h.drop.holding()).toBe(false);
    expect(h.line()).toBeNull();
    expect(h.logs.join('\n')).toContain('1 dropped file(s) were let go');
    expect(h.logs.join('\n')).not.toContain('Deck');
  });

  test('a second file dropped while the first waits joins it: "what changed" can be asked of the two', async () => {
    const h = harness();
    h.drop.take(h.file('Deck October.pdf', 'application/pdf', 200_000));
    await h.got();
    h.drop.take(h.file('Deck November.pdf', 'application/pdf', 300_000));
    await settle();
    expect(h.said()).toBe('Got Deck November.pdf too.');
    await h.got();
    expect(h.cards()).toEqual(['doc | Deck October.pdf | PDF · 195 KB', 'doc | Deck November.pdf | PDF · 293 KB']);
    expect(h.buttons()).toEqual(['- What changed', '- Compare them', '- Summarise them']);
    expect(h.line()).toMatchObject({ placeholder: 'Ask about them, or hold the keys and say it' });
    await h.answer('button', { button: 'ask0' });
    expect(h.asked[0]!.text).toBe('I dropped these files, in this order: Deck October.pdf, Deck November.pdf. Tell me what changed from the first to the last, in a few short lines.');
    expect(h.asked[0]!.files.map((file) => file.name)).toEqual(['Deck October.pdf', 'Deck November.pdf']);
  });

  test('no more than three are held, and no more than a turn can carry', async () => {
    const h = harness();
    for (const name of ['a.txt', 'b.txt', 'c.txt']) expect(h.drop.take(h.file(name, 'text/plain', 10))).toEqual({ taken: true });
    expect(h.drop.take(h.file('d.txt', 'text/plain', 10))).toEqual({ taken: false });
    expect(h.told).toEqual(['I am holding 3 files already. Ask about those first.']);
    const big = harness();
    big.drop.take(big.file('one.png', 'image/png', 4 * MB));
    big.drop.take(big.file('two.png', 'image/png', 3 * MB));
    expect(big.drop.take(big.file('three.png', 'image/png', 2 * MB))).toEqual({ taken: false });
    expect(big.told).toEqual(['three.png is too large to read together with what I am holding. Ask about that first.']);
    expect(big.drop.claim().length).toBe(2);
  });

  test('a file it cannot read is not held: the notch says what it is and what would work, and the mouth shuts', () => {
    const h = harness();
    h.fromPage({ type: 'drag', state: 'over' });
    expect(h.drop.take(h.file('Call with Anna.m4a', 'audio/mp4', 40_000))).toEqual({ taken: false });
    expect(h.drop.holding()).toBe(false);
    expect(h.told).toEqual(['Call with Anna.m4a is a sound file. I cannot listen to files yet.']);
    expect(h.mouth()).toEqual(['open', 'over', 'shut']);
  });

  test('a web page is held as its words, under its own name', async () => {
    const h = harness();
    const page = new TextEncoder().encode('<html><head><script>steal()</script></head><body><h1>Receipt 114</h1><p>Paid in <b>full</b>.</p></body></html>');
    expect(h.drop.take({ name: 'receipt.html', mediaType: 'text/html', size: page.length, bytes: page, count: 1 })).toEqual({ taken: true });
    await h.got();
    await h.answer('button', { button: 'ask0' });
    expect(h.asked[0]!.text).toBe('Summarise the file I dropped, receipt.html: what it is, and the points that matter, in a few short lines.');
    const [file] = h.asked[0]!.files;
    expect([file!.kind, file!.name, file!.mediaType]).toEqual(['document', 'receipt.html', 'text/plain']);
    expect(new TextDecoder().decode(file!.bytes)).toBe('Receipt 114\nPaid in full.');
  });

  test('a spreadsheet and a code file are offered what fits them', async () => {
    const sheet = harness();
    sheet.drop.take(sheet.file('payouts.csv', 'text/csv', 2000));
    await sheet.got();
    expect(sheet.cards()).toEqual(['sheet | payouts.csv | Spreadsheet · 2 KB']);
    expect(sheet.buttons()).toEqual(['- Totals', '- What stands out', '- Summarise it']);
    const code = harness();
    const source = new TextEncoder().encode('export const one = 1;\n');
    code.drop.take({ name: 'one.ts', mediaType: '', size: source.length, bytes: source, count: 1 });
    await code.got();
    expect(code.cards()).toEqual(['doc | one.ts | Code · 1 KB']);
    expect(code.buttons()).toEqual(['- Explain it', '- Find problems', '- Summarise it']);
  });

  test('a long one is cut: its card says so, and so does what is asked', async () => {
    const h = harness();
    const long = new TextEncoder().encode('word '.repeat(60_000));
    expect(h.drop.take({ name: 'log.yaml', mediaType: '', size: long.length, bytes: long, count: 1 })).toEqual({ taken: true });
    await h.got();
    expect(h.cards()[0]).toContain('first part only');
    await h.answer('button', { button: 'ask0' });
    expect(h.asked[0]!.text).toContain('only its first part could be read');
    expect(h.asked[0]!.files[0]!.bytes.length).toBeLessThan(121_000);
  });

  test('a file that is not what its name says, or is locked, is said to be unreadable and nothing is held', () => {
    const h = harness();
    const junk = new TextEncoder().encode('this is not a zip, whatever the end of its name says about it');
    expect(h.drop.take({ name: 'Payouts.xlsx', mediaType: '', size: junk.length, bytes: junk, count: 1 })).toEqual({ taken: false });
    expect(h.drop.holding()).toBe(false);
    expect(h.told).toEqual(['I could not read Payouts.xlsx. It may be damaged, protected with a password, or hold no words.']);
  });

  test('a file too large to read arrives without its bytes, and is said to be too large', () => {
    const h = harness();
    expect(h.drop.take({ name: 'Report.pdf', mediaType: 'application/pdf', size: 9 * MB, bytes: new Uint8Array(0), count: 1 })).toEqual({ taken: false });
    expect(h.told).toEqual(['Report.pdf is larger than I can read yet: 1 MB is the most for a document.']);
  });

  test('a file that arrived in part is not read', () => {
    const h = harness();
    expect(h.drop.take({ name: 'Deck.pdf', mediaType: 'application/pdf', size: 300_000, bytes: new Uint8Array(1000), count: 1 })).toEqual({ taken: false });
    expect(h.drop.holding()).toBe(false);
    expect(h.told).toEqual(['Only part of Deck.pdf arrived, so I did not read it. Try dropping it again.']);
  });

  test('with everything stopped nothing is read', () => {
    const h = harness({ paused: () => true });
    expect(h.drop.take(h.file('Deck.pdf', 'application/pdf', 300_000))).toEqual({ taken: false });
    expect(h.drop.holding()).toBe(false);
    expect(h.told).toEqual(['Everything is stopped. Wake me first.']);
  });

  test('dropped while something else is on the notch: it takes the notch, because a file was handed over', async () => {
    const h = harness({ busy: true });
    await settle();
    expect(h.said()).toBe('Busy with something.');
    h.drop.take(h.file('Deck.pdf', 'application/pdf', 300_000));
    await settle();
    // What was there was not an item with a turn of its own, so the file's question waits for the notch to be free.
    expect(h.drop.holding()).toBe(true);
  });
});

describe('the request a dropped file arrives in', () => {
  const request = (headers: Record<string, string>, body: Uint8Array | string = new Uint8Array([1, 2, 3])): Request =>
    new Request(`http://localhost${NOTCH_DROP_PATH}`, { method: 'POST', headers, body: body as BodyInit });

  test('is read as the file\'s name, kind, size and bytes', async () => {
    const got = await readNotchDrop(request({ 'content-type': 'application/pdf', 'x-notch-file': encodeURIComponent('Città – deck.pdf'), 'x-notch-size': '3', 'x-notch-count': '2' }));
    expect(got).toMatchObject({ name: 'Città – deck.pdf', mediaType: 'application/pdf', size: 3, count: 2 });
    expect([...got.bytes]).toEqual([1, 2, 3]);
  });

  test('what it does not say is not made up', async () => {
    const got = await readNotchDrop(request({ 'x-notch-file': '%E0%A4%A', 'x-notch-count': 'many' }));
    expect(got).toMatchObject({ name: '', size: 3, count: 1 });
  });

  test('a file too large to read came without its bytes; its size is still what the page saw', async () => {
    const got = await readNotchDrop(request({ 'content-type': 'application/pdf', 'x-notch-file': 'Report.pdf', 'x-notch-size': String(9 * MB) }, ''));
    expect(got.size).toBe(9 * MB);
    expect(got.bytes.length).toBe(0);
    // And a body that is larger than anything that could be read is thrown away, not kept.
    const huge = await readNotchDrop(request({ 'x-notch-file': 'x.bin', 'x-notch-size': '10' }, new Uint8Array(NOTCH_DROP_MAX_BYTES + 1)));
    expect(huge.bytes.length).toBe(0);
  });

  test('the route hands it to the notch, and is not there at all with the switch off', async () => {
    const seen: NotchDropped[] = [];
    const on = notchRoutes(true, { drop: (dropped) => { seen.push(dropped); return { taken: true }; } });
    const reply = await on[NOTCH_DROP_PATH]!.POST(request({ 'content-type': 'text/plain', 'x-notch-file': 'a.txt', 'x-notch-size': '3' }));
    expect(await reply.json()).toEqual({ taken: true });
    expect(seen[0]).toMatchObject({ name: 'a.txt', size: 3 });
    expect(notchRoutes(false, { drop: () => ({ taken: true }) })[NOTCH_DROP_PATH]).toBeUndefined();
    // On, with nothing to take it: there is nothing here.
    expect((await notchRoutes(true, {})[NOTCH_DROP_PATH]!.POST(request({}))).status).toBe(404);
  });
});

describe('pass 12: day one hears of a file that was taken', () => {
  test('the real drop with the real day one: the file is asked about as ever, and day one goes on after it', async () => {
    const { attachNotchDayOne } = await import('./dayone.ts');
    const { NotchSettings } = await import('./settings.ts');
    const { Database } = await import('bun:sqlite');
    let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    const port: NotchSurfacePort = {
      dispatchRPC() { return Promise.resolve({}); },
      onEvent(listener) { onEvent = listener; },
      onSidecarDisconnected() {},
    };
    const timers: { fn: () => void; at: number }[] = [];
    let now = 0;
    const clock = {
      setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
      clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
    };
    const pass = async (ms: number): Promise<void> => {
      const until = now + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at; timers.splice(timers.indexOf(next), 1); next.fn();
        await settle();
      }
      now = until;
      await settle();
    };
    const surface = new NotchSurface(port, () => {});
    const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
    fromPage({ type: 'hello', v: 1 });
    const inbox = new NotchInbox(surface, { clock, log: () => {} });
    const settings = new NotchSettings(new Database(':memory:'));
    const { NOTCH_DAY_ONE_ORDER } = await import('./dayone.ts');
    const dropStep = NOTCH_DAY_ONE_ORDER.indexOf('drop') + 1;
    settings.set('dayone', { step: dropStep, done: false });
    const day = attachNotchDayOne({
      inbox, settings, clock, log: () => {}, fresh: () => true,
      model: { ready: () => true, name: () => 'test', hosted: () => false, setUp: () => {} },
    });
    const asked: string[] = [];
    const drop = attachNotchDrop(surface, inbox, {
      ask: (words) => { asked.push(words); },
      tell: () => {},
      taken: () => day.gave(),
      gotMs: 10, log: () => {},
    });
    const said = (): string => text(surface.current().line?.say ?? []);
    day.cameUp();
    await pass(5000);
    expect(said()).toBe('Now hand me a file. Drag any file from your desktop onto me.');
    // A file that is refused is no lesson: day one is still waiting for one.
    expect(drop.take({ name: 'film.mov', mediaType: 'video/quicktime', size: 10, bytes: new Uint8Array(10), count: 1 }).taken).toBe(false);
    await settle();
    expect(day.step()).toBe(dropStep);
    // A file that is taken: what is wanted from it takes the notch.
    expect(drop.take({ name: 'notes.txt', mediaType: 'text/plain', size: 4, bytes: new Uint8Array(4), count: 1 }).taken).toBe(true);
    await settle();
    expect(said()).toBe('Got notes.txt.');
    await pass(2000);
    expect(surface.current().line?.kind).toBe('ask');
    // The first of the three questions is picked: the file goes with it, and day one has the notch back.
    fromPage({ type: 'answer', id: surface.current().line!.id, act: 'button', button: 'ask0' });
    await settle();
    expect(asked.length).toBe(1);
    await pass(600);
    expect(said()).toBe('That is all there is to it: drop it, then ask.');
    fromPage({ type: 'answer', id: surface.current().line!.id, act: 'done' });
    await settle();
    expect(day.step()).toBe(dropStep + 1);
  });
});
