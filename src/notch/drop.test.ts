import { describe, expect, test } from 'bun:test';
import type { NotchAskFile } from './asks.ts';
import { NOTCH_DROP_MAX_BYTES, attachNotchDrop, dropName, dropQuestion, dropVerdict } from './drop.ts';
import type { NotchDropped } from './drop.ts';
import { NotchInbox } from './inbox.ts';
import type { NotchLine, NotchPart, NotchToPage } from './protocol.ts';
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

  // The owner's test for pass 9: "Drop a spreadsheet: it says it cannot read that yet."
  test('a spreadsheet is refused in a sentence that says what it is and what would work', () => {
    expect(dropVerdict('Payouts.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 40_000))
      .toEqual({ ok: false, why: 'Payouts.xlsx is a spreadsheet. I cannot read those yet. Saved as CSV, I can.' });
    expect((dropVerdict('Budget.numbers', '', 40_000) as { why: string }).why).toContain('a spreadsheet');
  });

  test('so is every other kind it cannot read, each in its own words', () => {
    const why = (name: string): string => (dropVerdict(name, '', 40_000) as { why: string }).why;
    expect(why('Contract.docx')).toBe('Contract.docx is a text document I cannot open yet. Saved as PDF or plain text, I can read it.');
    expect(why('Pitch.pptx')).toContain('a presentation');
    expect(why('Call with Anna.m4a')).toBe('Call with Anna.m4a is a sound file. I cannot listen to files yet.');
    expect(why('demo.mp4')).toContain('a video');
    expect(why('all.zip')).toContain('an archive');
    expect(why('anim.gif')).toContain('As PNG or JPEG, I can');
    expect(why('setup.exe')).toBe('setup.exe is a program. I do not read or run dropped programs.');
    expect(why('thing.xyz')).toBe('I cannot read that kind of file yet (.xyz). Text, CSV, a PDF, a PNG or a JPEG I can.');
    expect(why('thing')).toBe('I cannot read that kind of file yet. Text, CSV, a PDF, a PNG or a JPEG I can.');
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
    paused: options.paused, overMs: 5000, log: (line) => logs.push(line),
  });
  if (options.busy) inbox.present('something', (stage) => stage.say(['Busy with something.'], 60_000));
  const line = (): NotchLine | null => surface.current().line;
  const file = (name: string, mediaType: string, size: number, extra: Partial<NotchDropped> = {}): NotchDropped =>
    ({ name, mediaType, size, bytes: new Uint8Array(size), count: 1, ...extra });
  return {
    drop, asked, told, logs, line, fromPage, file,
    said: (): string => text(line()?.say),
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const timer of [...timers].filter((entry) => entry.at <= now)) {
        const at = timers.indexOf(timer);
        if (at >= 0) { timers.splice(at, 1); timer.fn(); }
      }
      await settle();
    },
  };
}

describe('a file held over the notch', () => {
  test('the notch says where to let go, and stops saying it when the file is taken away', async () => {
    const h = harness();
    h.fromPage({ type: 'drag', state: 'over' });
    await settle();
    expect(h.said()).toBe('Let go of it here. I will read it.');
    // Said once for one drag, however often the page says "over".
    h.fromPage({ type: 'drag', state: 'over' });
    await settle();
    expect(h.said()).toBe('Let go of it here. I will read it.');
    h.fromPage({ type: 'drag', state: 'left' });
    await settle();
    expect(h.line()).toBeNull();
    // And again for the next one.
    h.fromPage({ type: 'drag', state: 'over' });
    await settle();
    expect(h.said()).toBe('Let go of it here. I will read it.');
  });

  test('held there and never let go: the line does not stay for ever', async () => {
    const h = harness();
    h.fromPage({ type: 'drag', state: 'over' });
    await settle();
    // The page shows a line for its time and then says it is done.
    expect(h.line()).toMatchObject({ kind: 'say', ms: 5000 });
    h.fromPage({ type: 'answer', id: h.line()!.id, act: 'done' });
    await settle();
    expect(h.line()).toBeNull();
    // Still held there, or brought back: it is said again.
    h.fromPage({ type: 'drag', state: 'over' });
    await settle();
    expect(h.said()).toBe('Let go of it here. I will read it.');
  });

  test('what is on the notch is not taken down for a file that may never be dropped', async () => {
    const h = harness({ busy: true });
    await settle();
    h.fromPage({ type: 'drag', state: 'over' });
    await settle();
    expect(h.said()).toBe('Busy with something.');
    // The file can still be let go on the notch as it is.
    expect(h.drop.take(h.file('Deck.pdf', 'application/pdf', 300_000))).toEqual({ taken: true });
    expect(h.asked.length).toBe(1);
  });

  test('a file that was let go and did not arrive is said to be lost', async () => {
    const h = harness();
    h.fromPage({ type: 'drag', state: 'over' });
    await settle();
    h.fromPage({ type: 'drag', state: 'lost' });
    await settle();
    expect(h.told).toEqual(['I could not take that file. Try dropping it again.']);
    expect(h.said()).not.toBe('Let go of it here. I will read it.');
  });

  test('a message about dragging that is not one of the three is not understood', async () => {
    const h = harness();
    h.fromPage({ type: 'drag', state: 'sideways' });
    h.fromPage({ type: 'drag' });
    await settle();
    expect(h.line()).toBeNull();
  });
});

describe('a file dropped on the notch', () => {
  // The owner's test for pass 9: "Drop a PDF: a sheet with a summary."
  test('a PDF is asked about at once, as an instruction that carries it', async () => {
    const h = harness();
    h.fromPage({ type: 'drag', state: 'over' });
    await settle();
    expect(h.drop.take(h.file('C:\\Users\\sam\\Deck.pdf', 'application/pdf', 300_000))).toEqual({ taken: true });
    await settle();
    expect(h.asked.map((ask) => ask.text)).toEqual(['Summarise the file I dropped, Deck.pdf: what it is, and the points that matter, in a few short lines.']);
    expect(h.asked[0]!.files.map((file) => [file.kind, file.name, file.mediaType, file.bytes.length])).toEqual([['document', 'Deck.pdf', 'application/pdf', 300_000]]);
    // "Let go of it here" has left.
    expect(h.said()).not.toBe('Let go of it here. I will read it.');
    // The name of the file is the person's: sizes and kinds only in the log.
    expect(h.logs.join('\n')).not.toContain('Deck');
    expect(h.logs.join('\n')).toContain('300000 bytes');
  });

  test('a spreadsheet is not asked about: the notch says it cannot read that yet', () => {
    const h = harness();
    expect(h.drop.take(h.file('Payouts.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 40_000))).toEqual({ taken: false });
    expect(h.asked).toEqual([]);
    expect(h.told).toEqual(['Payouts.xlsx is a spreadsheet. I cannot read those yet. Saved as CSV, I can.']);
  });

  test('a file too large to read arrives without its bytes, and is said to be too large', () => {
    const h = harness();
    expect(h.drop.take({ name: 'Report.pdf', mediaType: 'application/pdf', size: 9 * MB, bytes: new Uint8Array(0), count: 1 })).toEqual({ taken: false });
    expect(h.told).toEqual(['Report.pdf is larger than I can read yet: 1 MB is the most for a document.']);
  });

  test('a file that arrived in part is not read', () => {
    const h = harness();
    expect(h.drop.take({ name: 'Deck.pdf', mediaType: 'application/pdf', size: 300_000, bytes: new Uint8Array(1000), count: 1 })).toEqual({ taken: false });
    expect(h.asked).toEqual([]);
    expect(h.told).toEqual(['Only part of Deck.pdf arrived, so I did not read it. Try dropping it again.']);
  });

  test('several at once: the first is taken, and that is said', () => {
    const h = harness();
    expect(h.drop.take(h.file('a.txt', 'text/plain', 10, { count: 3 }))).toEqual({ taken: true });
    expect(h.told).toEqual(['One file at a time. I took the first: a.txt.']);
    expect(h.asked.length).toBe(1);
  });

  test('with everything stopped nothing is read', () => {
    const h = harness({ paused: () => true });
    expect(h.drop.take(h.file('Deck.pdf', 'application/pdf', 300_000))).toEqual({ taken: false });
    expect(h.asked).toEqual([]);
    expect(h.told).toEqual(['Everything is stopped. Wake me first.']);
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
