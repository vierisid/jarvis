import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { NotchFromPage } from '../../../src/notch/protocol.ts';

let watchNotchDrops: (typeof import('./drop.ts'))['watchNotchDrops'];
let notchUpload: (typeof import('./drop.ts'))['notchUpload'];
let notchDropHeaders: (typeof import('./drop.ts'))['notchDropHeaders'];
let NOTCH_DROP_MAX_BYTES: number;

beforeAll(async () => {
  GlobalRegistrator.register();
  ({ watchNotchDrops, notchUpload, notchDropHeaders, NOTCH_DROP_MAX_BYTES } = await import('./drop.ts'));
});
afterAll(() => GlobalRegistrator.unregister());

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** A drag event as a browser makes one: with what is being dragged, and able to be refused. */
function drag(type: string, files: File[] | null): Event & { prevented: () => boolean; effect: () => string } {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
  const transfer = { types: files ? ['Files'] : ['text/plain'], files: files ?? [], dropEffect: 'none' };
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  return Object.assign(event, { prevented: () => event.defaultPrevented, effect: () => transfer.dropEffect });
}

function page(upload: (file: File, count: number) => Promise<boolean> = async () => true) {
  const sent: NotchFromPage[] = [];
  const uploads: [string, number][] = [];
  // A clock that is moved by hand: the mouth closes by itself when a drag goes quiet.
  const timers: { fn: () => void; ms: number }[] = [];
  const stop = watchNotchDrops(document, {
    send: (message) => { sent.push(message); },
    upload: (file, count) => { uploads.push([file.name, count]); return upload(file, count); },
  }, {
    set: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clear: (handle) => { const at = timers.indexOf(handle as { fn: () => void; ms: number }); if (at >= 0) timers.splice(at, 1); },
  });
  return { sent, uploads, stop, timers, quiet: (): void => { for (const timer of timers.splice(0)) timer.fn(); } };
}

const pdf = (): File => new File([new Uint8Array([1, 2, 3])], 'Deck.pdf', { type: 'application/pdf' });

describe('a file dragged over the notch\'s page', () => {
  test('is said to the brain once when it comes over, and once when it has gone', () => {
    const h = page();
    document.dispatchEvent(drag('dragenter', [pdf()]));
    // Into a child of the page: an enter before the leave of the parent.
    document.dispatchEvent(drag('dragenter', [pdf()]));
    document.dispatchEvent(drag('dragleave', [pdf()]));
    expect(h.sent).toEqual([{ type: 'drag', state: 'over' }]);
    document.dispatchEvent(drag('dragleave', [pdf()]));
    expect(h.sent).toEqual([{ type: 'drag', state: 'over' }, { type: 'drag', state: 'left' }]);
    h.stop();
  });

  test('is shown as something that can be let go here', () => {
    const h = page();
    const over = drag('dragover', [pdf()]);
    document.dispatchEvent(over);
    expect(over.prevented()).toBe(true);
    expect(over.effect()).toBe('copy');
    h.stop();
  });

  test('let go, the files are sent to the brain one after another, in order, and nothing more is said when they arrived', async () => {
    const h = page();
    document.dispatchEvent(drag('dragenter', [pdf()]));
    const drop = drag('drop', [pdf(), new File(['x'], 'second.txt')]);
    document.dispatchEvent(drop);
    await settle();
    expect(drop.prevented()).toBe(true);
    expect(h.uploads).toEqual([['Deck.pdf', 2], ['second.txt', 2]]);
    expect(h.sent).toEqual([{ type: 'drag', state: 'over' }]);
    h.stop();
  });

  test('no more than three of a drop are sent, and none after one that did not arrive', async () => {
    const h = page();
    const five = ['a', 'b', 'c', 'd', 'e'].map((name) => new File(['x'], `${name}.txt`));
    document.dispatchEvent(drag('drop', five));
    await settle();
    expect(h.uploads).toEqual([['a.txt', 5], ['b.txt', 5], ['c.txt', 5]]);
    h.stop();
    const lost = page(async (file) => file.name !== 'b.txt');
    document.dispatchEvent(drag('drop', five));
    await settle();
    expect(lost.uploads.map(([name]) => name)).toEqual(['a.txt', 'b.txt']);
    expect(lost.sent).toEqual([{ type: 'drag', state: 'lost' }]);
    lost.stop();
  });

  test('a file that did not arrive is said to be lost, whether the brain refused the request or it never got there', async () => {
    const refused = page(async () => false);
    document.dispatchEvent(drag('drop', [pdf()]));
    await settle();
    expect(refused.sent).toEqual([{ type: 'drag', state: 'lost' }]);
    refused.stop();
    const failed = page(async () => { throw new Error('offline'); });
    document.dispatchEvent(drag('drop', [pdf()]));
    await settle();
    expect(failed.sent).toEqual([{ type: 'drag', state: 'lost' }]);
    failed.stop();
  });
});

describe('anything else dragged to the page', () => {
  // A browser that is given a drop it was not stopped from taking leaves the page and shows what was dropped.
  test('is never left to the browser, and says nothing to the brain', () => {
    const h = page();
    const enter = drag('dragenter', null);
    const over = drag('dragover', null);
    const drop = drag('drop', null);
    document.dispatchEvent(enter);
    document.dispatchEvent(over);
    document.dispatchEvent(drop);
    expect(over.prevented()).toBe(true);
    expect(drop.prevented()).toBe(true);
    expect(over.effect()).toBe('none');
    expect(h.sent).toEqual([]);
    expect(h.uploads).toEqual([]);
    h.stop();
  });

  test('once the watch is ended the page hears nothing more', () => {
    const h = page();
    h.stop();
    document.dispatchEvent(drag('dragenter', [pdf()]));
    expect(h.sent).toEqual([]);
  });
});

describe('sending a dropped file', () => {
  test('one request to the brain the page came from, with the file as its body and what it is in the headers', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const request = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}'); }) as unknown as typeof fetch;
    const file = new File([new Uint8Array([1, 2, 3])], 'Città – deck.pdf', { type: 'application/pdf' });
    expect(await notchUpload(file, 1, request)).toBe(true);
    expect(calls[0]!.url).toBe('/api/notch/drop');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(calls[0]!.init.body).toBe(file);
    expect(calls[0]!.init.headers).toEqual({
      'content-type': 'application/pdf', 'x-notch-file': 'Citt%C3%A0%20%E2%80%93%20deck.pdf', 'x-notch-size': '3', 'x-notch-count': '1',
    });
  });

  test('a file too large to be read is not sent: only what it is', async () => {
    const calls: RequestInit[] = [];
    const request = (async (_url: string, init: RequestInit) => { calls.push(init); return new Response('{}'); }) as unknown as typeof fetch;
    const big = { name: 'Report.pdf', type: 'application/pdf', size: NOTCH_DROP_MAX_BYTES + 1 } as File;
    await notchUpload(big, 1, request);
    expect(calls[0]!.body).toBe('');
    expect((calls[0]!.headers as Record<string, string>)['x-notch-size']).toBe(String(NOTCH_DROP_MAX_BYTES + 1));
  });

  test('a file with no kind is sent as one', () => {
    expect(notchDropHeaders({ name: 'notes.md', type: '', size: 10 }, 1)['content-type']).toBe('application/octet-stream');
  });

  test('a brain that refuses it is a file that did not arrive', async () => {
    const request = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    expect(await notchUpload(pdf(), 1, request)).toBe(false);
  });
});

// The hardening audit, 17 November 2026: the name was cut after it was encoded. A long name in another script
// lost its ending, or was cut inside one letter and could not be read back at all: a Word file was refused
// as a kind that cannot be read, or arrived with no name.
describe('a long name', () => {
  test('is cut in whole letters and keeps its ending', async () => {
    const { notchDropName } = await import('./drop.ts');
    for (const name of [`${'報告書'.repeat(40)}.docx`, `${'отчёт'.repeat(40)}.xlsx`, `${'a'.repeat(2000)}.pdf`, `${'😀'.repeat(200)}.png`]) {
      const sent = notchDropName(name);
      expect(sent.length).toBeLessThanOrEqual(900);
      const back = decodeURIComponent(sent);
      expect(back.endsWith(name.slice(name.lastIndexOf('.')))).toBe(true);
      expect(name.startsWith(back.slice(0, 5))).toBe(true);
    }
    // A short name goes as it is.
    expect(decodeURIComponent(notchDropName('Budget Q4 (final).xlsx'))).toBe('Budget Q4 (final).xlsx');
    expect(decodeURIComponent(notchDropName('no ending at all'))).toBe('no ending at all');
  });
});

describe('a page that is no longer signed in', () => {
  test('says so when a dropped file is refused for it, and not for any other refusal', async () => {
    const { notchUpload } = await import('./drop.ts');
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    let told = 0;
    expect(await notchUpload(file, 1, (async () => new Response('', { status: 401 })) as never, () => { told++; })).toBe(false);
    expect(told).toBe(1);
    expect(await notchUpload(file, 1, (async () => new Response('', { status: 413 })) as never, () => { told++; })).toBe(false);
    expect(await notchUpload(file, 1, (async () => new Response('{}', { status: 200 })) as never, () => { told++; })).toBe(true);
    expect(told).toBe(1);
  });

  test('asks the brain now and then, which keeps its sign-in from going idle, and says once when it has ended', async () => {
    const { watchNotchSignIn } = await import('./drop.ts');
    const asked: string[] = [];
    let status = 200;
    let told = 0;
    const stop = watchNotchSignIn(() => { told++; }, {
      every: 15, path: '/notch.html',
      request: (async (path: string, init: { method: string }) => { asked.push(`${init.method} ${path}`); if (status === 0) throw new Error('offline'); return new Response(null, { status }); }) as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(asked[0]).toBe('HEAD /notch.html');
    expect(told).toBe(0);
    // The brain is away for a moment: nothing is said of that.
    status = 0;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(told).toBe(0);
    status = 401;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(told).toBe(1);
    const before = asked.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Said once, and then it asks no more: the brain opens the page again.
    expect(asked.length).toBe(before);
    stop();
  });
});

// The hardening audit, 17 November 2026: a leave that the page never hears of
// left the mouth open until the next real drop. The prototype closes it a
// moment after the last sign of the drag, and so does the page now.
describe('a drag that goes quiet', () => {
  test('the mouth closes by itself a moment after the last sign of the drag', () => {
    const h = page();
    document.dispatchEvent(drag('dragenter', [pdf()]));
    expect(h.sent).toEqual([{ type: 'drag', state: 'over' }]);
    // Still over it: each sign puts the moment off, and only one clock runs.
    document.dispatchEvent(drag('dragover', [pdf()]));
    document.dispatchEvent(drag('dragover', [pdf()]));
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(700);
    expect(h.sent).toHaveLength(1);
    // No further sign, and no leave either.
    h.quiet();
    expect(h.sent).toEqual([{ type: 'drag', state: 'over' }, { type: 'drag', state: 'left' }]);
    // The same drag coming back opens it again.
    document.dispatchEvent(drag('dragenter', [pdf()]));
    expect(h.sent.at(-1)).toEqual({ type: 'drag', state: 'over' });
    h.stop();
  });

  test('a leave that is heard needs no clock, and leaves none running', () => {
    const h = page();
    document.dispatchEvent(drag('dragenter', [pdf()]));
    document.dispatchEvent(drag('dragleave', [pdf()]));
    expect(h.sent).toEqual([{ type: 'drag', state: 'over' }, { type: 'drag', state: 'left' }]);
    expect(h.timers).toHaveLength(0);
    h.stop();
  });

  test('something dropped that holds no file is said as lost, not passed over in silence', () => {
    const h = page();
    document.dispatchEvent(drag('dragenter', [pdf()]));
    document.dispatchEvent(drag('drop', []));
    expect(h.sent).toEqual([{ type: 'drag', state: 'over' }, { type: 'drag', state: 'lost' }]);
    expect(h.uploads).toEqual([]);
    expect(h.timers).toHaveLength(0);
    h.stop();
  });
});
