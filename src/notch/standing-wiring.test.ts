/**
 * Who wrote the words, through the notch as it is assembled (./real.ts): what
 * the owner typed or said is theirs, and a question the notch wrote for them
 * (a circle with nothing said, a button on a file) is not
 * (authority/standing.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApprovalManager } from '../authority/approval.ts';
import { isUnusedStanding } from '../authority/standing.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { NOTCH_LOOK_EVENT, NOTCH_LOOK_QUESTION } from './look.ts';
import type { NotchLine } from './protocol.ts';
import { attachNotchReal, type NotchReal } from './real.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** What the desktop app sends beside a `taken` event (./look.ts). */
function body(told: Record<string, unknown>, picture: Uint8Array): Uint8Array {
  const words = new TextEncoder().encode(JSON.stringify({ ...told, picture_bytes: picture.length }));
  const out = new Uint8Array(4 + words.length + picture.length);
  new DataView(out.buffer).setUint32(0, words.length, false);
  out.set(words, 4);
  out.set(picture, 4 + words.length);
  return out;
}

let live: NotchReal | null = null;
beforeEach(() => { initDatabase(':memory:', { quiet: true }); });
afterEach(() => { live?.stop(); live = null; closeDb(); });

function assembled() {
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = { dispatchRPC: () => Promise.resolve({}), onEvent(listener) { onEvent = listener; }, onSidecarDisconnected() {} };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  let fromApp: (sidecarId: string, event: { event_type: string; payload: unknown; binary?: unknown }) => void = () => {};
  /** Every turn the notch started: its words, how its id is written, who wrote the words, and what came with it. */
  const turns: { text: string; requestId: string; who: string | null; real: boolean; files: string[] }[] = [];
  const real = attachNotchReal(surface, {
    approvalManager: new ApprovalManager(),
    approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
    asks: {
      db: getDb(), modelReady: () => true, talkPort: { onEvent() {} }, stt: () => null,
      look: { port: { onEvent(listener) { fromApp = listener as typeof fromApp; }, onSidecarDisconnected() {} } },
      turns: () => ({
        ready: () => true, conversation: () => 'conv-notch',
        submit(turn: { text: string; requestId: string; standing?: { origin: string }; files?: { name: string }[] }) {
          turns.push({ text: turn.text, requestId: turn.requestId, who: turn.standing?.origin ?? null, real: isUnusedStanding(turn.standing), files: (turn.files ?? []).map((file) => file.name) });
        },
        cancel() {}, onEvent: () => () => {}, look: () => null, mark() {},
      }) as never,
    },
    day: { db: getDb(), noClock: true },
    lookMs: 3_600_000,
    log: () => {},
  });
  live = real;
  const wait = async (ms = 2): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, ms)); for (let i = 0; i < 60; i++) await Promise.resolve(); };
  const line = (): NotchLine | null => surface.current().line;
  const answer = async (act: string, more: Record<string, unknown> = {}): Promise<void> => {
    fromPage({ type: 'answer', id: line()!.id, act, ...more });
    await wait();
  };
  return {
    real, turns, line, wait, fromPage, answer,
    /** The desktop app says something was circled, with nothing said. */
    circle: (things: Record<string, unknown>[]): void => fromApp('pc', {
      event_type: NOTCH_LOOK_EVENT, payload: { phase: 'taken', look_id: 'L1', how: 'loop', things: things.length },
      binary: { type: 'inline', data: Buffer.from(body({ app: 'chrome', title: 'A page', around: ['Installs'], things }, PNG)).toString('base64') },
    }),
    /** A file is dropped, "Got it" has had its moment, and the question about the file is up. */
    async drop(name = 'Deck.pdf'): Promise<void> {
      expect(real.drop!.take({ name, mediaType: 'application/pdf', size: 3000, bytes: new Uint8Array(3000).fill(7), count: 1 }).taken).toBe(true);
      await wait();
      if (line()?.kind === 'say') await answer('done');
      expect(line()).toMatchObject({ kind: 'ask' });
    },
  };
}

describe('a question the notch wrote for the owner is not the owner\'s word', () => {
  test('a circle with nothing said', async () => {
    const h = assembled();
    h.circle([{ kind: 'text', name: '1,284' }]);
    // No recording opens: after a moment the look answers by itself.
    await h.wait(650);
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]).toMatchObject({ text: NOTCH_LOOK_QUESTION, who: 'shown', real: true });
    expect(h.turns[0]!.files.length).toBeGreaterThan(0);
    // It is kept and named like something typed: the id says nothing about its standing.
    expect(h.turns[0]!.requestId.startsWith('notch-typed-')).toBe(true);
  });

  test('"Summarise it" on a file that was dropped, and Enter on the empty field', async () => {
    const button = assembled();
    await button.drop();
    await button.answer('button', { button: 'ask0' });
    expect(button.turns).toEqual([{ text: 'Summarise the file I dropped: what it is, and the points that matter, in a few short lines.',
      requestId: button.turns[0]!.requestId, who: 'shown', real: true, files: ['Deck.pdf'] }]);
    live?.stop(); live = null;

    const enter = assembled();
    await enter.drop();
    await enter.answer('ask', { text: '   ' });
    expect(enter.turns.map((turn) => [turn.who, turn.real, turn.files])).toEqual([['shown', true, ['Deck.pdf']]]);
  });

  test('"Summarise it" on a file somebody sent', async () => {
    const h = assembled();
    expect(h.real.drop!.arrived({ name: 'Deck.pdf', bytes: new Uint8Array(2000).fill(7), from: 'Leo', place: 'Downloads' })).toBe(true);
    await h.wait();
    if (h.line()?.kind === 'say') await h.answer('done');
    await h.answer('button', { button: 'ask0' });
    expect(h.turns.map((turn) => [turn.text, turn.who, turn.real])).toEqual([
      ['Summarise the file I was sent: what it is, and the points that matter, in a few short lines.', 'shown', true],
    ]);
  });
});

describe('what the owner wrote or said is theirs', () => {
  test('a question typed about a dropped file', async () => {
    const h = assembled();
    await h.drop();
    await h.answer('ask', { text: 'open Notepad and write what slide four says' });
    expect(h.turns.map((turn) => [turn.text, turn.who, turn.real, turn.files])).toEqual([
      ['open Notepad and write what slide four says', 'typed', true, ['Deck.pdf']],
    ]);
  });

  test('typed in Home, and said with the talk keys held', async () => {
    const typed = assembled();
    typed.fromPage({ type: 'open' });
    await typed.wait();
    await typed.answer('ask', { text: 'open Notepad and write a poem' });
    expect(typed.turns.map((turn) => [turn.text, turn.who, turn.real])).toEqual([['open Notepad and write a poem', 'typed', true]]);
    live?.stop(); live = null;

    const said = assembled();
    said.real.asks!.listen('t1'); await said.wait();
    said.real.asks!.released('t1'); await said.wait();
    said.real.asks!.words('t1', 'open Notepad and write a poem'); await said.wait();
    // The words are shown for a moment before they are acted on.
    await said.wait(1100);
    expect(said.turns.map((turn) => [turn.text, turn.who, turn.real])).toEqual([['open Notepad and write a poem', 'spoken', true]]);
    expect(said.turns[0]!.requestId.startsWith('notch-spoken-')).toBe(true);
  });
});
