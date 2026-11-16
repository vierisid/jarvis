import { describe, expect, test } from 'bun:test';
import {
  NOTCH_ROUND_MAX_MS, findRounds, parseWatchEvent, roundPlace, roundsApps, roundsCopy, roundsName, roundsSource, roundsThatFit, roundsToDo, watchKeysOk,
  type RoundStep, type WatchStep, type WatchWin,
} from './rounds.ts';

const FILE: WatchWin = { id: '0x1a', pid: 100, w: 900, h: 700 };
const SHEET: WatchWin = { id: '0x2b', pid: 200, w: 1200, h: 800 };

let clock = 0;
const click = (win: WatchWin, x: number, y: number, mods?: string): WatchStep =>
  ({ kind: 'click', app: win === FILE ? 'notepad' : 'excel', win, x, y, at: (clock += 400), ...(mods ? { mods } : {}) });
const keys = (win: WatchWin, spec: string): WatchStep => ({ kind: 'keys', app: win === FILE ? 'notepad' : 'excel', win, keys: spec, at: (clock += 400) });

/** One row copied from the file into the sheet: click it, copy, click the cell, paste. */
const row = (n: number): WatchStep[] => [
  click(FILE, 120, 200 + 22 * n), keys(FILE, 'ctrl,c'), click(SHEET, 300, 400 + 20 * n), keys(SHEET, 'ctrl,v'),
];

describe('what the desktop app tells of the hands', () => {
  test('a click is a window and a place in it, a key is a named key, and nothing else is taken', () => {
    expect(parseWatchEvent({ kind: 'click', app: 'excel', win: { id: '0x2b', pid: 200, w: 1200, h: 800 }, pt: { x: 300, y: 400 }, ts: 5 }, 9))
      .toEqual({ kind: 'click', app: 'excel', win: SHEET, x: 300, y: 400, at: 5 });
    expect(parseWatchEvent({ kind: 'click', app: 'excel', win: SHEET, pt: { x: 300, y: 400 }, mods: 'shift' }, 9))
      .toEqual({ kind: 'click', app: 'excel', win: SHEET, x: 300, y: 400, at: 9, mods: 'shift' });
    expect(parseWatchEvent({ kind: 'keys', keys: 'ctrl,v', app: 'excel', win: SHEET, ts: 5 }, 9)).toEqual({ kind: 'keys', app: 'excel', win: SHEET, keys: 'ctrl,v', at: 5 });
    expect(parseWatchEvent({ kind: 'typed', ts: 5 }, 9)).toEqual({ kind: 'typed', at: 5 });
    expect(parseWatchEvent({ kind: 'gap' }, 9)).toEqual({ kind: 'gap', at: 9 });
    for (const bad of [
      null, 'click', {}, { kind: 'click' },
      { kind: 'click', win: SHEET, pt: { x: 1.5, y: 2 } },
      { kind: 'click', win: SHEET, pt: { x: 1300, y: 2 } }, // outside its own window
      { kind: 'click', win: { id: 'excel', pid: 1, w: 10, h: 10 }, pt: { x: 1, y: 1 } },
      { kind: 'click', win: { id: '0x2b', pid: 0, w: 10, h: 10 }, pt: { x: 1, y: 1 } },
      { kind: 'keys', keys: 'ctrl+v', win: SHEET },
      { kind: 'keys', keys: 'hello', win: SHEET },
      { kind: 'keys', keys: 'ctrl,v' }, // in no window
      { kind: 'moved', win: SHEET },
    ]) expect(parseWatchEvent(bad, 9)).toBeNull();
  });

  // The line between "it saw that I pressed Ctrl + C" and "it saw what I wrote".
  test('a key that types is never kept as a key, even if one arrived', () => {
    for (const spec of ['a', 'shift,a', '7', 'space', 'backspace', 'shift,space']) {
      expect(watchKeysOk(spec)).toBe(false);
      expect(parseWatchEvent({ kind: 'keys', keys: spec, win: SHEET }, 9)).toBeNull();
    }
    for (const spec of ['ctrl,c', 'ctrl,shift,v', 'alt,tab', 'enter', 'shift,down', 'delete', 'f5', 'win,d', 'ctrl,backspace']) expect(watchKeysOk(spec)).toBe(true);
    // The name of a click's modifiers is not free text either.
    expect(parseWatchEvent({ kind: 'click', win: SHEET, pt: { x: 1, y: 1 }, mods: 'ctrl,c' }, 9)).toEqual({ kind: 'click', app: '', win: SHEET, x: 1, y: 1, at: 9 });
  });
});

describe('the same thing done twice, one place further along', () => {
  test('two rows copied across are a round of four steps, and the third is the same steps moved on', () => {
    const rounds = findRounds([...row(0), ...row(1)])!;
    expect(rounds.shown).toBe(2);
    expect(rounds.steps.map((step) => step.kind)).toEqual(['click', 'keys', 'click', 'keys']);
    const [from, copy, to, paste] = rounds.steps as [Extract<RoundStep, { kind: 'click' }>, Extract<RoundStep, { kind: 'keys' }>, Extract<RoundStep, { kind: 'click' }>, Extract<RoundStep, { kind: 'keys' }>];
    // Each place as it was in the LAST round by hand, and how far it moves on.
    expect({ x: from.x, y: from.y, dx: from.dx, dy: from.dy }).toEqual({ x: 120, y: 222, dx: 0, dy: 22 });
    expect({ x: to.x, y: to.y, dx: to.dx, dy: to.dy }).toEqual({ x: 300, y: 420, dx: 0, dy: 20 });
    expect(copy.copy).toBe(true);
    expect(paste.paste).toBe(true);
    // A pointer of its own for each place a round touches.
    expect([from.hand, to.hand]).toEqual([0, 1]);
    // The third row, and the tenth.
    expect(roundPlace(from, 1)).toEqual({ x: 120, y: 244 });
    expect(roundPlace(to, 1)).toEqual({ x: 300, y: 440 });
    expect(roundPlace(to, 8)).toEqual({ x: 300, y: 580 });
    expect(roundsSource(rounds)).toBe(from);
    expect(roundsCopy(rounds)).toBe(true);
    expect(roundsApps(rounds)).toEqual(['notepad', 'excel']);
  });

  test('a hand that is not steady to the pixel is still the same place, or the same step on', () => {
    const wobbly = [
      click(FILE, 120, 200), keys(FILE, 'ctrl,c'), click(SHEET, 300, 400), keys(SHEET, 'ctrl,v'),
      click(FILE, 123, 221), keys(FILE, 'ctrl,c'), click(SHEET, 298, 421), keys(SHEET, 'ctrl,v'),
    ];
    const rounds = findRounds(wobbly)!;
    const [from, , to] = rounds.steps as Extract<RoundStep, { kind: 'click' }>[];
    // Sideways it held still: it moves on down, and not a little sideways each time.
    expect({ dx: from!.dx, dy: from!.dy }).toEqual({ dx: 0, dy: 21 });
    expect({ dx: to!.dx, dy: to!.dy }).toEqual({ dx: 0, dy: 21 });
  });

  // Found by review before the first hand test: a cell is clicked anywhere along its width.
  test('how far to the side the hand landed is the hand, not the job', () => {
    const sideways = [
      click(FILE, 120, 200), keys(FILE, 'ctrl,c'), click(SHEET, 300, 400), keys(SHEET, 'ctrl,v'),
      click(FILE, 190, 222), keys(FILE, 'ctrl,c'), click(SHEET, 255, 420), keys(SHEET, 'ctrl,v'),
    ];
    const rounds = findRounds(sideways)!;
    const [from, , to] = rounds.steps as Extract<RoundStep, { kind: 'click' }>[];
    // It goes on straight down from where the last click was, not off to the side.
    expect({ x: from!.x, dx: from!.dx, dy: from!.dy }).toEqual({ x: 190, dx: 0, dy: 22 });
    expect({ x: to!.x, dx: to!.dx, dy: to!.dy }).toEqual({ x: 255, dx: 0, dy: 20 });
    expect(roundPlace(to!, 9)).toEqual({ x: 255, y: 600 });
  });

  test('a place is whole pixels even when the rows are not a whole number of pixels apart', () => {
    const rounds = findRounds([...row(0), ...row(1)])!;
    const to = { ...(rounds.steps[2] as Extract<RoundStep, { kind: 'click' }>), dy: 26.25 };
    expect(roundPlace(to, 1)).toEqual({ x: 300, y: 446 });
    expect(roundPlace(to, 4)).toEqual({ x: 300, y: 525 });
    // Nine rows on it is nine rows on, not nine times a rounded row.
    expect(roundPlace(to, 9)).toEqual({ x: 300, y: 656 });
  });

  test('a step that stays where it is stays, while another moves on', () => {
    // Pick the next file in a list, then press the same Delete button each time.
    const pick = (n: number): WatchStep[] => [click(FILE, 200, 100 + 30 * n), click(FILE, 800, 40), keys(FILE, 'enter')];
    const rounds = findRounds([...pick(0), ...pick(1)])!;
    const [item, button] = rounds.steps as Extract<RoundStep, { kind: 'click' }>[];
    expect({ dx: item!.dx, dy: item!.dy }).toEqual({ dx: 0, dy: 30 });
    expect({ x: button!.x, y: button!.y, dx: button!.dx, dy: button!.dy }).toEqual({ x: 800, y: 40, dx: 0, dy: 0 });
    expect(roundPlace(button!, 5)).toEqual({ x: 800, y: 40 });
  });

  test('done three times, it says so, and the round is still the short one', () => {
    const rounds = findRounds([...row(0), ...row(1), ...row(2)])!;
    expect(rounds.shown).toBe(3);
    expect(rounds.steps.length).toBe(4);
    expect((rounds.steps[0] as Extract<RoundStep, { kind: 'click' }>).y).toBe(244);
  });

  test('what came before the job began does not hide it', () => {
    const before = [click(SHEET, 50, 50), keys(SHEET, 'ctrl,s'), click(FILE, 700, 20)];
    expect(findRounds([...before, ...row(0), ...row(1)])?.steps.length).toBe(4);
  });

  test('the same job has the same name from round to round, and another job another', () => {
    const two = findRounds([...row(0), ...row(1)])!;
    const three = findRounds([...row(0), ...row(1), ...row(2)])!;
    expect(roundsName(three)).toBe(roundsName(two));
    const other = findRounds([click(FILE, 120, 200), keys(FILE, 'ctrl,x'), click(SHEET, 300, 400), keys(SHEET, 'ctrl,v'),
      click(FILE, 120, 222), keys(FILE, 'ctrl,x'), click(SHEET, 300, 420), keys(SHEET, 'ctrl,v')])!;
    expect(roundsName(other)).not.toBe(roundsName(two));
  });
});

describe('a round is a circle', () => {
  // Found by test: turned down after two rows, the offer came back at the next click, as if it were another job.
  test('the person who goes on by hand is in the same job, at another step of it', () => {
    const whole = findRounds([...row(0), ...row(1)])!;
    // One click further: the next row of the file is picked, and not yet copied.
    const further = findRounds([...row(0), ...row(1), click(FILE, 120, 244)])!;
    expect(further.steps.map((step) => (step.kind === 'keys' ? step.keys : 'click'))).toEqual(['ctrl,c', 'click', 'ctrl,v', 'click']);
    expect(roundsName(further)).toBe(roundsName(whole));
    // Where the things come from is still the click in the file, though it is now the last step of the round.
    expect(roundsSource(further)).toMatchObject({ win: FILE, x: 120, y: 244, dy: 22 });
    expect(roundsSource(whole)).toMatchObject({ win: FILE, x: 120, y: 222, dy: 22 });
  });

  test('a thing already picked and not yet copied is still to be done', () => {
    const whole = findRounds([...row(0), ...row(1)])!;
    const further = findRounds([...row(0), ...row(1), click(FILE, 120, 244)])!;
    // Six rows stand after the last one picked. Stopped after a paste, that is six rounds.
    expect(roundsToDo(whole, 6)).toBe(6);
    // Stopped after picking the next row, five stand after it, and it is itself still to copy: six again.
    expect(roundsToDo(further, 5)).toBe(6);
    // A job that copies nothing has no such step.
    const ticks = findRounds([click(SHEET, 40, 300), click(SHEET, 40, 324), click(SHEET, 40, 348)])!;
    expect(roundsToDo(ticks, 4)).toBe(4);
  });
});

describe('what is not a round', () => {
  test('one time is not twice', () => {
    expect(findRounds(row(0))).toBeNull();
    expect(findRounds([])).toBeNull();
  });

  // Typing is told only as "typed": there is a part of the job Jarvis did not see.
  test('a stretch with typing in it, however regular', () => {
    const typed = (n: number): WatchStep[] => [click(SHEET, 300, 400 + 20 * n), { kind: 'typed', at: (clock += 400) }, keys(SHEET, 'enter')];
    expect(findRounds([...typed(0), ...typed(1)])).toBeNull();
    // Typing in the middle of two rounds parts them.
    expect(findRounds([...row(0), { kind: 'typed', at: (clock += 1) }, ...row(1)])).toBeNull();
  });

  test('anything across a moment the desktop app looked away', () => {
    expect(findRounds([...row(0), { kind: 'gap', at: (clock += 1) }, ...row(1)])).toBeNull();
    // After it, two fresh rounds are a job again.
    expect(findRounds([...row(0), { kind: 'gap', at: (clock += 1) }, ...row(1), ...row(2)])?.shown).toBe(2);
  });

  test('a round in which nothing moves on: there is no rest to do', () => {
    const same = (): WatchStep[] => [click(FILE, 120, 200), keys(FILE, 'ctrl,c'), click(SHEET, 300, 400), keys(SHEET, 'ctrl,v')];
    expect(findRounds([...same(), ...same()])).toBeNull();
    expect(findRounds([keys(SHEET, 'ctrl,z'), keys(SHEET, 'ctrl,z'), keys(SHEET, 'ctrl,z')])).toBeNull();
  });

  // Two clicks in a window happen all day.
  test('clicks alone done twice. A third time makes them a pattern', () => {
    const tick = (n: number): WatchStep => click(SHEET, 40, 300 + 24 * n);
    expect(findRounds([tick(0), tick(1)])).toBeNull();
    const rounds = findRounds([tick(0), tick(1), tick(2)])!;
    expect(rounds.shown).toBe(3);
    expect((rounds.steps[0] as Extract<RoundStep, { kind: 'click' }>).dy).toBe(24);
    // Three clicks that do not move evenly are not one.
    expect(findRounds([tick(0), tick(1), click(SHEET, 40, 500)])).toBeNull();
  });

  test('a place that moved a little, neither still nor on', () => {
    expect(findRounds([click(FILE, 120, 200), keys(FILE, 'ctrl,c'), click(FILE, 120, 206), keys(FILE, 'ctrl,c')])).toBeNull();
  });

  // Columns are not evenly wide: going on across by the same distance would land between cells.
  test('a job that goes across a row, not down a list', () => {
    const across = (n: number): WatchStep[] => [click(SHEET, 300 + 110 * n, 400), keys(SHEET, 'ctrl,v')];
    expect(findRounds([...across(0), ...across(1)])).toBeNull();
    // The same button pressed a little to the side is still the same button.
    const button = (n: number): WatchStep[] => [click(FILE, 200, 100 + 30 * n), click(FILE, 800 + 15 * n, 40), keys(FILE, 'enter')];
    expect(findRounds([...button(0), ...button(1)])?.steps[1]).toMatchObject({ kind: 'click', x: 815, y: 40, dx: 0, dy: 0 });
  });

  test('other keys, another window, other things held, or a window that changed size', () => {
    const base = row(0);
    expect(findRounds([...base, click(FILE, 120, 222), keys(FILE, 'ctrl,x'), click(SHEET, 300, 420), keys(SHEET, 'ctrl,v')])).toBeNull();
    expect(findRounds([...base, click(FILE, 120, 222), keys(FILE, 'ctrl,c'), click(FILE, 300, 420), keys(SHEET, 'ctrl,v')])).toBeNull();
    expect(findRounds([...base, click(FILE, 120, 222, 'shift'), keys(FILE, 'ctrl,c'), click(SHEET, 300, 420), keys(SHEET, 'ctrl,v')])).toBeNull();
    const wider = { ...SHEET, w: 1400 };
    expect(findRounds([...base, click(FILE, 120, 222), keys(FILE, 'ctrl,c'), click(wider, 300, 420), keys(wider, 'ctrl,v')])).toBeNull();
  });

  test('two rounds a long time apart, or one that took a long time', () => {
    const first = row(0);
    clock += NOTCH_ROUND_MAX_MS + 1;
    expect(findRounds([...first, ...row(1)])).toBeNull();
    const slow = [click(FILE, 120, 200), keys(FILE, 'ctrl,c')];
    clock += NOTCH_ROUND_MAX_MS + 1;
    slow.push(click(SHEET, 300, 400), keys(SHEET, 'ctrl,v'));
    expect(findRounds([...slow, ...row(1)])).toBeNull();
  });
});

describe('how far a job can go', () => {
  test('a place that would leave its window is nowhere', () => {
    const rounds = findRounds([...row(0), ...row(1)])!;
    const to = rounds.steps[2] as Extract<RoundStep, { kind: 'click' }>;
    // The sheet is 800 high and the last cell clicked was at 420, 20 apart: 18 more fit.
    expect(roundPlace(to, 18)).toEqual({ x: 300, y: 780 });
    expect(roundPlace(to, 19)).toBeNull();
    // The file is 700 high, 22 apart from 222: 21 fit there. The smaller of the two is how far the job can go.
    expect(roundsThatFit(rounds, 200)).toBe(18);
    expect(roundsThatFit(rounds, 5)).toBe(5);
  });
});
