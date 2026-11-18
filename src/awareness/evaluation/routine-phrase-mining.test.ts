/**
 * #1068: phrase mining lists the frequent word sequences around routine
 * screens, and drops anything that looks like personal data.
 */
import { expect, test } from 'bun:test';
import { captureNgrams, mineRoutinePhrases, type PhraseMiningOptions } from './routine-phrase-mining.ts';
import { EVALUATION_NOW } from './routine-evaluation.ts';
import type { RoutineCapture } from '../routine-signals.ts';

const DAY = 86_400_000;
const MIN = 60_000;
const OPTIONS: PhraseMiningOptions = { minCount: 3, minDays: 2, top: 40 };

test('keeps 2-3 word runs of plain words, split at lines and separators', () => {
  const grams = captureNgrams({ windowTitle: 'Invoices | Acme Books', ocrText: 'Send reminder\nMark as paid' });
  expect([...grams].sort()).toEqual(['acme books', 'mark as paid', 'send reminder']);
  // "reminder mark" would cross a line; "invoices acme" would cross the | separator.
  expect(grams.has('reminder mark')).toBe(false);
  expect(grams.has('invoices acme')).toBe(false);
});

test('default-deny: emails, numbers, amounts, dates, domains, ids and long words break the run', () => {
  const grams = captureNgrams({ ocrText: [
    'Contact mario.rossi@example.com today',
    'Invoice INV2026 due 12/10/2026 total 1,200.50 EUR',
    'Visit acme.example.com now please',
    'Token abcdefghijklmnopqrstuvwxyz here',
    'Call +39 333 1234567 back',
  ].join('\n') });
  const all = [...grams].join('\n');
  for (const leak of ['@', 'example', 'mario', '2026', '1,200', '12', '333', 'abcdefghijklmnopqrstuvwxyz']) {
    expect(all).not.toContain(leak);
  }
  // Words on either side of a rejected word are not joined across it.
  expect(grams.has('contact today')).toBe(false);
  expect(grams.has('token here')).toBe(false);
  expect(grams.has('now please')).toBe(true);
});

test('drops sequences that start or end with a stopword, keeps inner ones and hyphenated words', () => {
  const grams = captureNgrams({ ocrText: 'the follow-up of the client' });
  expect(grams.has('follow-up of')).toBe(false);
  expect(grams.has('the follow-up')).toBe(false);
  expect(captureNgrams({ ocrText: 'Mark as paid' }).has('mark as paid')).toBe(true);
  expect(captureNgrams({ ocrText: 'Payment status. Next step' }).has('status next')).toBe(false);
});

function capture(id: string, timestamp: number, ocrText: string, extra: Partial<RoutineCapture> = {}): RoutineCapture {
  return { captureId: id, timestamp, app: 'Books', ocrText, sidecarId: 'device-a', ...extra };
}

/** Three days of a real-looking invoice routine: a list, then a payment check, then a reminder. */
function invoiceWeek(): RoutineCapture[] {
  return [-3, -2, -1].flatMap((d, i) => {
    const t = EVALUATION_NOW + d * DAY - 6 * 60 * MIN;
    return [
      capture(`s${i}`, t, `Overdue invoices\nCustomer name ${['Rossi', 'Bianchi', 'Verdi'][i]}\nSend reminder\nFile Edit View`),
      capture(`o${i}`, t + 5 * MIN, 'Payment received\nMark as paid\nFile Edit View'),
      capture(`x${i}`, t + 10 * MIN, 'Reminder email preview\nFile Edit View'),
      // Long after the routine: not a following screen.
      capture(`late${i}`, t + 3 * 60 * MIN, 'Team chat\nFile Edit View'),
    ];
  });
}

test('lists source and following sequences per family, with how common each is on all screens', () => {
  const report = mineRoutinePhrases(() => invoiceWeek(), OPTIONS);
  const f = report.families.invoice_review!;
  expect(f.sourceCaptures).toBe(3);
  expect(f.followingCaptures).toBe(6);
  const source = Object.fromEntries(f.source.map(p => [p.phrase, p]));
  expect(source['send reminder']).toEqual({ phrase: 'send reminder', captures: 3, days: 3, allCaptures: 3 });
  // Window chrome shows up everywhere, which allCaptures makes visible.
  expect(source['file edit view']!.allCaptures).toBe(12);
  // A customer name seen once is under the threshold.
  expect(f.source.some(p => /rossi|bianchi|verdi/.test(p.phrase))).toBe(false);
  const following = f.following.map(p => p.phrase);
  expect(following).toContain('mark as paid');
  expect(following).toContain('reminder email preview');
  expect(following).not.toContain('team chat');
  expect(report.families.lead_followup).toEqual({ sourceCaptures: 0, followingCaptures: 0, source: [], following: [] });
});

test('a sequence must appear on minCount captures across minDays days', () => {
  const sameDay = [0, 1, 2].map(i => capture(`d${i}`, EVALUATION_NOW - DAY + i * 60 * MIN, 'Overdue invoices\nSend reminder'));
  expect(mineRoutinePhrases(() => sameDay, OPTIONS).families.invoice_review!.source).toEqual([]);
  expect(mineRoutinePhrases(() => sameDay, { ...OPTIONS, minDays: 1 }).families.invoice_review!.source.map(p => p.phrase))
    .toContain('send reminder');
  // Three source screens: a minimum of four keeps none of them.
  expect(mineRoutinePhrases(() => invoiceWeek(), { ...OPTIONS, minCount: 4 }).families.invoice_review!.source).toEqual([]);
});

test('another device does not follow a source screen, and gated captures are never mined', () => {
  const t = EVALUATION_NOW - DAY;
  const report = mineRoutinePhrases(() => [
    capture('s', t, 'Overdue invoices'),
    capture('other', t + MIN, 'Mark as paid', { sidecarId: 'device-b' }),
    capture('priv', t + 2 * MIN, 'Overdue invoices\nSecret vault', { app: 'Bitwarden' }),
    capture('read', t + 3 * MIN, 'Mark as paid\nHelp guide'),
    capture('excl', t + 4 * MIN, 'Mark as paid', { excluded: true }),
  ], { ...OPTIONS, minCount: 2, minDays: 1 });
  expect(report.abstained).toMatchObject({ private: 1, reading: 1, excluded: 1 });
  expect(report.read).toBe(2);
  expect(report.families.invoice_review!.sourceCaptures).toBe(1);
  expect(report.families.invoice_review!.followingCaptures).toBe(0);
});

test('the report carries no capture ids, app names, device ids or timestamps', () => {
  const marker = 'zqmarker';
  const captures = invoiceWeek().map(c => ({ ...c, captureId: `${marker}-${c.captureId}`, app: `${marker}App`, sidecarId: `${marker}-device` }));
  const report = mineRoutinePhrases(() => captures, OPTIONS);
  expect(report.families.invoice_review!.source.length).toBeGreaterThan(0);
  const json = JSON.stringify(report);
  expect(json).not.toContain(marker);
  for (const c of captures) expect(json).not.toContain(String(c.timestamp));
});
