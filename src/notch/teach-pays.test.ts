/**
 * A shown job that pays, done as rounds.
 *
 * The hardening audit, 17 November 2026: "Watch me", pick an invoice, click
 * "Pay now", Enter, twice, "done". The notch said "Learned it in 3 steps,
 * done twice. I can take it from here: 6 left." One yes, and "Pay now" was
 * clicked six times. A job done again as it was shown had always been
 * checked (`startSkill`); the same job done as rounds never was.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NotchInbox } from './inbox.ts';
import { attachNotchJobs } from './jobs.ts';
import type { NotchLine, NotchPart } from './protocol.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';
import { attachNotchTeach } from './teach.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string => (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? part.word.value : '')).join('');
const BANK = { id: '0x2b', pid: 200, w: 1200, h: 800 };
const ref = (name: string) => ({ role: 'Button', name, path: [], ordinal: 0, sig: name });

/** A showing of the same three steps twice, in a program where one of them pays or deletes. */
async function shownTwice(effect: { pays: boolean; deletes: boolean }) {
  let toSurface: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = { dispatchRPC() { return Promise.resolve({}); }, onEvent(listener) { toSurface = listener; }, onSidecarDisconnected() {} };
  const timers: { fn: () => void; at: number }[] = [];
  const now = new Date(2026, 10, 18, 10, 0, 0).getTime();
  const clock = { setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; }, clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); } };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => toSurface('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 2 });
  const inbox = new NotchInbox(surface, { clock, log: () => {} });
  const sent: Record<string, unknown>[] = [];
  const hands = { act: async (request: Record<string, unknown>) => { sent.push(request); return request.do === 'pitch' ? { done: true, known: true, dy: request.dy } : { done: true }; } };
  const db = new Database(':memory:');
  const jobs = attachNotchJobs(inbox, { db, hands, sleep: async () => {}, log: () => {} } as never);
  let recording = false;
  const shown: unknown[] = [];
  const hearers = new Set<(interaction: unknown, n: number) => void>();
  const asked: string[] = [];
  const teach = attachNotchTeach({
    inbox, jobs, hands, db, now: () => now, log: () => {},
    recorder: {
      async start() { recording = true; return { ok: true }; },
      async stop() { recording = false; return shown.splice(0); },
      onStep(listener: (interaction: unknown, n: number) => void) { hearers.add(listener); return () => hearers.delete(listener); },
    },
    save: (interactions: unknown[]) => ({ ok: true, skill: 'shown-bank', steps: interactions.length, notes: [], apps: ['Bank'] }),
    describe: async () => 'deals with an invoice',
    forget() {},
    effect: (skill: string) => { asked.push(skill); return { ...effect, missing: false }; },
    async runSkill() { return { end: { how: 'done' }, next: 1 }; },
    count: async () => 6,
  } as never);
  const line = (): NotchLine | null => surface.current().line;
  const does = async (interaction: unknown): Promise<void> => { if (!recording) return; shown.push(interaction); for (const hear of [...hearers]) hear(interaction, shown.length); await settle(); };
  const reply = async (act: string): Promise<void> => { fromPage({ type: 'answer', id: line()!.id, act }); await settle(); };
  teach.route('watch me')!.run();
  await settle();
  for (const n of [0, 1]) {
    await does({ action: 'click', ref: ref(`Invoice ${n}`), ts: now + n * 10, app: 'bank', win: BANK, pt: { x: 200, y: 300 + 30 * n } });
    await does({ action: 'click', ref: ref('The button'), ts: now + n * 10 + 1, app: 'bank', win: BANK, pt: { x: 900, y: 120 } });
    await does({ action: 'press_keys', value: 'enter', ts: now + n * 10 + 2, app: 'bank', win: BANK });
  }
  // "done"
  await reply('yes');
  for (let i = 0; i < 10; i++) await settle();
  const pressed = (): number => sent.filter((request) => request.do === 'click' && request.x === 900).length;
  return { line, said: () => text(line()?.say), reply, pressed, asked, teach, settle: async () => { for (let i = 0; i < 50; i++) await settle(); } };
}

test('a shown job that pays is learned and never taken over, however it is asked for', async () => {
  const h = await shownTwice({ pays: true, deletes: false });
  expect(h.said()).toBe('Learned it in 3 steps, done twice. It pays for something, so I do not take it over.');
  expect(h.line()?.kind).toBe('say');
  expect(h.asked).toEqual(['shown-bank']);
  // No yes takes it over, and neither does asking for it.
  await h.reply('done');
  h.teach.route('run it on six')?.run();
  await h.settle();
  expect(h.pressed()).toBe(0);
});

test('a shown job that deletes is asked about once more before it is taken over, and a no leaves everything as it is', async () => {
  const no = await shownTwice({ pays: false, deletes: true });
  expect(no.said()).toBe('Learned it in 3 steps, done twice. I can take it from here: 6 left.');
  await no.reply('yes');
  expect(no.said()).toBe('That job deletes something, 6 more times. Do it?');
  await no.reply('no');
  await no.settle();
  expect(no.pressed()).toBe(0);

  const yes = await shownTwice({ pays: false, deletes: true });
  await yes.reply('yes');
  await yes.reply('yes');
  await yes.settle();
  expect(yes.pressed()).toBe(6);
});

test('a job that does neither is taken over on the one yes, as before', async () => {
  const h = await shownTwice({ pays: false, deletes: false });
  await h.reply('yes');
  await h.settle();
  expect(h.pressed()).toBe(6);
});
