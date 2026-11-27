import { describe, expect, test } from 'bun:test';
import { NOTCH_FUSE_SEEN_MS, NOTCH_GATE_MS, NOTCH_PROTOCOL_VERSION, notchRuled } from '../../../../src/notch/protocol.ts';
import type { NotchLine } from '../../../../src/notch/protocol.ts';
import {
  notchClicked, notchFuseUp, notchInput, notchLineUp, notchLost, notchMessage, notchPageStart, notchPainted, notchPainting, notchTick,
  notchTimed, notchTooSoon, notchWakeAt, notchWantsEsc, notchWithWord,
  type NotchPageModel, type NotchPageOut,
} from './core.ts';

// The page's model with no screen, no clock and no timers: every test says the time.

const BRAIN = 'b1';
const state = (line: NotchLine | null, seq = 1, more: Record<string, unknown> = {}): unknown =>
  ({ type: 'state', v: NOTCH_PROTOCOL_VERSION, brain: BRAIN, seq, line: line ? notchRuled(line) : null, count: 0, ...more });
const dos = (out: NotchPageOut[]): string[] => out.map((one) => one.do);
const answers = (out: NotchPageOut[]): unknown[] => out.flatMap((one) => (one.do === 'answer' ? [one.answer] : []));

/** A page told the whole once, with `line` up and drawn at `at`, as the joining code would do it. */
function upAt(line: NotchLine, at = 1000): NotchPageModel {
  let model = notchMessage(notchPageStart(), state(null)).model;
  model = notchLineUp(model, notchRuled(line), at).model;
  model = notchPainted(notchPainting(model, at));
  return model;
}

describe('what the brain says', () => {
  test('nothing but a state is heard before the brain has told the whole once', () => {
    const start = notchPageStart();
    const patch = notchMessage(start, { type: 'patch', seq: 1, count: 3 });
    expect(patch.out).toEqual([]);
    expect(patch.model).toBe(start);
    const told = notchMessage(start, state(null, 4));
    expect(told.model.born).toBe(true);
    expect(told.model.seq).toBe(4);
    expect(dos(told.out)).toEqual(['whole', 'appear', 'rest', 'park', 'mouth', 'sync', 'beat']);
  });

  test('a state with a line draws it at once, and the first state with a birth is born', () => {
    const line: NotchLine = { id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show' };
    expect(notchMessage(notchPageStart(), state(line)).out).toContainEqual({ do: 'draw', line: notchRuled(line), restore: false, instant: true });
    expect(dos(notchMessage(notchPageStart(), state(null, 1, { born: 'bead' })).out)).toContain('birth');
  });

  test('a copy is passed over, a gap is said and what came is still taken', () => {
    const model = notchMessage(notchPageStart(), state(null, 1)).model;
    expect(notchMessage(model, { type: 'patch', seq: 1, count: 2 })).toEqual({ model, out: [] });
    const gap = notchMessage(model, { type: 'patch', seq: 3, count: 2 });
    expect(gap.model.seq).toBe(3);
    expect(gap.model.count).toBe(2);
    expect(gap.out[0]).toEqual({ do: 'outOfStep', what: 'patch 3 came after 1' });
  });

  test('a kind the page does not know is counted when it was the next, and said nothing of; one that is wrong is said', () => {
    const model = notchMessage(notchPageStart(), state(null, 1)).model;
    const unknown = notchMessage(model, { type: 'sparkle', seq: 2 });
    expect(unknown).toEqual({ model: { ...model, seq: 2 }, out: [] });
    const wrong = notchMessage(model, { type: 'patch', seq: 2, line: { id: 'x', kind: 'sheet' } });
    expect(wrong.model.seq).toBe(2);
    expect(wrong.out).toEqual([{ do: 'outOfStep', what: 'patch sheet' }]);
  });

  test('another version is not read, and a refusal in this version is a page the brain does not know', () => {
    expect(notchMessage(notchPageStart(), { type: 'state', v: 9, brain: BRAIN, seq: 1, line: null, count: 0 }).out).toEqual([{ do: 'version', v: 9 }]);
    expect(notchMessage(notchPageStart(), { type: 'refuse', v: NOTCH_PROTOCOL_VERSION }).out)
      .toEqual([{ do: 'outOfStep', what: 'the brain does not know this page', refused: true }]);
  });

  test('another run of the brain clears what was said to the last, and its line of the same name is drawn anew', () => {
    const line: NotchLine = { id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show' };
    const model = upAt(line);
    const again = notchMessage(model, state(line, 2));
    expect(dos(again.out)).not.toContain('draw');
    const other = notchMessage(model, { ...(state(line, 1) as object), brain: 'b2' });
    expect(dos(other.out)).toEqual(expect.arrayContaining(['clearAnswers', 'draw']));
  });

  test('the line already up, told again held, is held here and not drawn again', () => {
    const line: NotchLine = { id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show' };
    const held = notchMessage(upAt(line), state({ ...line, held: true }, 2));
    expect(dos(held.out)).toContain('held');
    expect(dos(held.out)).not.toContain('draw');
  });

  test('a line that comes in along the edge makes what was scheduled void, and lands changed', () => {
    const say: NotchLine = { id: 's', kind: 'say', say: ['Done.'], ms: 3000 };
    let model = upAt(say);
    model = notchTimed(model, 's', 3000, 1000);
    const arrive = notchMessage(model, { type: 'patch', seq: 2, line: { ...notchRuled({ id: 'n', kind: 'offer', say: ['Next?'], yes: 'go' } as NotchLine), arrive: 'left' } });
    expect(dos(arrive.out)).toEqual(['kept', 'arrive']);
    expect(notchWakeAt(arrive.model)).toBeNull();
    const edited = notchMessage(arrive.model, { type: 'patch', seq: 3, edit: { id: 'n', say: ['Next, now?'] } });
    expect(dos(edited.out)).toEqual(['kept']);
    expect(edited.model.arriving?.line.say).toEqual(['Next, now?']);
    // Still looked drawn: the line there before keeps being answered as itself.
    expect(edited.model.line?.id).toBe('s');
  });
});

describe('too soon', () => {
  const unasked: NotchLine = { id: 'u', kind: 'offer', say: ['Shall I?'], yes: 'go', unasked: true };

  test('a key is too soon for the dead time, an Esc for a line that came by itself, from when it was drawn', () => {
    const model = upAt(unasked, 1000);
    expect(notchTooSoon(model, 'key', 1000 + NOTCH_GATE_MS.unasked - 1)).toBe(true);
    expect(notchTooSoon(model, 'key', 1000 + NOTCH_GATE_MS.unasked)).toBe(false);
    expect(notchTooSoon(model, 'esc', 1000 + NOTCH_GATE_MS.unasked - 1)).toBe(true);
    const asked = upAt({ id: 'a', kind: 'offer', say: ['Reply?'], yes: 'show' }, 1000);
    expect(notchTooSoon(asked, 'esc', 1000)).toBe(false);
    expect(notchTooSoon(asked, 'key', 1000 + NOTCH_GATE_MS.dead - 1)).toBe(true);
  });

  test('the second half of a double click that began before the line is not a click on it', () => {
    let model = upAt({ id: 'a', kind: 'offer', say: ['Reply?'], yes: 'show' }, 1000);
    model = notchClicked(model, 900);
    model = notchClicked(model, 1200);
    expect(notchTooSoon(model, 'click', 1200)).toBe(true);
    model = notchClicked(model, 1800);
    expect(notchTooSoon(model, 'click', 1800)).toBe(false);
  });

  test('a yes by the keys in the dead time does nothing at all', () => {
    const model = upAt(unasked, 1000);
    expect(notchInput(model, { kind: 'key', name: 'yes' }, 1100, { shown: true })).toEqual({ model, out: [] });
    const later = notchInput(model, { kind: 'key', name: 'yes' }, 1000 + NOTCH_GATE_MS.unasked, { shown: true });
    expect(answers(later.out)).toEqual([{ type: 'answer', id: 'u', act: 'yes', since: NOTCH_GATE_MS.unasked, brain: BRAIN }]);
  });
});

describe('what the person did', () => {
  const offer: NotchLine = { id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show' };

  test('yes on an offer nods, is said once to settle it, and holds it; a second does nothing', () => {
    const step = notchInput(upAt(offer), { kind: 'yes' }, 2000);
    expect(step.out).toEqual([
      { do: 'nod' },
      { do: 'answer', answer: { type: 'answer', id: 'o', act: 'yes', since: 1000, brain: BRAIN }, once: true },
      { do: 'settle' },
    ]);
    expect(step.model.cur?.done).toBe(true);
    expect(notchInput(step.model, { kind: 'yes' }, 2100).out).toEqual([]);
  });

  test('Esc on an offer turns it down: said, a shake, and back to the eyes', () => {
    const step = notchInput(upAt(offer), { kind: 'key', name: 'esc' }, 2000);
    expect(dos(step.out)).toEqual(['answer', 'shake', 'sfx', 'rest']);
    expect(step.model.line).toBeNull();
  });

  test('an open strip of choices closes first; Esc twice stops everything', () => {
    expect(notchInput(upAt(offer), { kind: 'key', name: 'esc' }, 2000, { picking: true }).out).toEqual([{ do: 'closePick' }]);
    expect(notchInput(upAt(offer), { kind: 'key', name: 'esc-twice' }, 2000).out).toContainEqual({ do: 'send', message: { type: 'stop' } });
  });

  test('a yes with nothing up opens the notch, and with something typed takes what is typed', () => {
    const resting = notchMessage(notchPageStart(), state(null)).model;
    expect(notchInput(resting, { kind: 'key', name: 'yes' }, 5000, { shown: true }).out).toEqual([{ do: 'send', message: { type: 'open' } }]);
    expect(notchInput(resting, { kind: 'key', name: 'yes' }, 5000, { shown: false }).out).toEqual([]);
    expect(notchInput(upAt(offer), { kind: 'key', name: 'yes' }, 5000, { shown: true, typed: true }).out).toEqual([{ do: 'commit' }]);
  });

  test('choices have no yes: the keys nudge them, Enter and a click do nothing; a pick nods and is said', () => {
    const choices = upAt({ id: 'c', kind: 'offer', say: ['Which?'], options: ['A', 'B'] });
    expect(notchInput(choices, { kind: 'key', name: 'yes' }, 3000, { shown: true, choices: true }).out).toEqual([{ do: 'nudge' }]);
    expect(notchInput(choices, { kind: 'enter' }, 3000).out).toEqual([]);
    const pick = notchInput(choices, { kind: 'pick', option: 'B', index: 1 }, 3000);
    expect(dos(pick.out)).toEqual(['nod', 'answer', 'settle']);
    expect(answers(pick.out)[0]).toMatchObject({ act: 'pick', option: 'B', index: 1 });
  });

  test('a sheet that must be seen whole goes down a page until its end was up long enough', () => {
    const sheet = upAt({ id: 'p', kind: 'sheet', say: ['Read'], yes: 'send', stay: true, whole: true, blocks: [{ kind: 'note', say: ['long'] }] } as NotchLine);
    const whole = sheet.line?.gate?.whole ?? NOTCH_GATE_MS.whole;
    expect(notchInput(sheet, { kind: 'yes' }, 5000, { sheetSeenAt: null }).out).toEqual([{ do: 'scrollSheet' }]);
    expect(notchInput(sheet, { kind: 'yes' }, 5000, { sheetSeenAt: 5000 - whole + 1 }).out).toEqual([]);
    expect(answers(notchInput(sheet, { kind: 'yes' }, 5000, { sheetSeenAt: 5000 - whole }).out)).toHaveLength(1);
  });

  test('a field sends what is typed in it, once, and nothing when it is empty', () => {
    const ask = upAt({ id: 'q', kind: 'ask', say: [], placeholder: 'Ask', yes: 'ask', blocks: [] } as NotchLine);
    expect(notchInput(ask, { kind: 'submit' }, 3000, { askText: '' }).out).toEqual([]);
    const sent = notchInput(ask, { kind: 'submit' }, 3000, { askText: 'why' });
    expect(dos(sent.out)).toEqual(['sfx', 'answer', 'blurAsk', 'settle']);
    expect(notchInput(sent.model, { kind: 'field-esc' }, 3100).out).toEqual([{ do: 'blurAsk' }]);
  });

  test('a press away is a no only where the line says so, and not in its first moment', () => {
    const sheet = upAt({ id: 'p', kind: 'sheet', say: ['See'], blocks: [{ kind: 'note', say: ['x'] }] } as NotchLine);
    expect(sheet.line?.away).toBe('no');
    expect(notchInput(sheet, { kind: 'away' }, 1100).out).toEqual([]);
    expect(dos(notchInput(sheet, { kind: 'away' }, 3000).out)).toEqual(['answer', 'rest']);
    expect(notchInput(upAt(offer), { kind: 'away' }, 3000, { picking: true }).out).toEqual([{ do: 'closePick' }]);
  });

  test('a word changed stands in the model, and is said only while the line can be answered', () => {
    const line: NotchLine = { id: 'w', kind: 'offer', yes: 'go', say: ['Chase ', { word: { name: 'tone', value: 'politely', options: ['politely', 'firmly'] } }] };
    const model = upAt(line);
    const before = model.line;
    const changed = notchInput(model, { kind: 'word', name: 'tone', value: 'firmly' }, 2000);
    expect(answers(changed.out)).toEqual([{ type: 'answer', id: 'w', act: 'word', word: 'tone', value: 'firmly', since: 1000, brain: BRAIN }]);
    expect(JSON.stringify(changed.model.line?.say)).toContain('"value":"firmly"');
    // Nothing was changed in place.
    expect(before).toBe(model.line);
    expect(JSON.stringify(before?.say)).toContain('"value":"politely"');
    const done = notchInput(notchInput(model, { kind: 'yes' }, 2000).model, { kind: 'word', name: 'tone', value: 'firmly' }, 2100);
    expect(done.out).toEqual([]);
  });

  test('notchWithWord adds a value that is not an option, and leaves a line without the word as it is', () => {
    const line: NotchLine = { id: 'w', kind: 'offer', say: [{ word: { name: 'when', value: 'Friday', options: ['Friday'] } }] };
    const next = notchWithWord(line, 'when', 'Monday');
    expect(next.say).toEqual([{ word: { name: 'when', value: 'Monday', options: ['Friday', 'Monday'] } }]);
    expect(notchWithWord(line, 'other', 'x')).toBe(line);
  });
});

describe('time on the line', () => {
  test('a result runs out once, when its time is up, and is said as done', () => {
    const say: NotchLine = { id: 's', kind: 'say', say: ['Done.'], ms: 3000 };
    let model = upAt(say, 1000);
    model = notchTimed(model, 's', 3000, 1000);
    expect(notchWakeAt(model)).toBe(4000);
    expect(notchTick(model, 3999).out).toEqual([]);
    const out = notchTick(model, 4000);
    expect(dos(out.out)).toEqual(['answer', 'rest']);
    expect(notchWakeAt(out.model)).toBeNull();
  });

  test('a drawing after the timer was set makes it void', () => {
    const say: NotchLine = { id: 's', kind: 'say', say: ['Done.'], ms: 3000 };
    let model = notchTimed(upAt(say, 1000), 's', 3000, 1000);
    model = notchPainting(model, 2000);
    expect(notchTick(model, 5000).out).toEqual([]);
  });

  test('drawn again, a line goes on from what it had left; from the brain, what the brain says is left', () => {
    const send: NotchLine = { id: 'f', kind: 'send', say: ['Sending'], ms: 4000 };
    let model = notchTimed(upAt(send, 1000), 'f', 4000, 1000);
    expect(notchLineUp(model, notchRuled(send), 2500, true).timing).toMatchObject({ left: 2500, seen: true });
    // A page that comes up with too little of the fuse left cannot say it saw it burn.
    model = notchMessage(notchPageStart(), state(null)).model;
    expect(notchLineUp(model, notchRuled({ ...send, left: NOTCH_FUSE_SEEN_MS - 1 }), 0).timing.seen).toBe(false);
    expect(notchLineUp(model, notchRuled({ ...send, left: NOTCH_FUSE_SEEN_MS }), 0).timing.seen).toBe(true);
  });

  test('a fuse takes Esc only once it is up; taken back it never runs out', () => {
    const send: NotchLine = { id: 'f', kind: 'send', say: ['Sending'], ms: 4000 };
    let model = upAt(send, 1000);
    expect(notchInput(model, { kind: 'key', name: 'esc' }, 1500).out).toEqual([]);
    model = notchTimed(notchFuseUp(model, model.drawn), 'f', 4000, 1000);
    const undo = notchInput(model, { kind: 'key', name: 'esc' }, 1500);
    expect(dos(undo.out)).toEqual(['unfuse', 'shake', 'sfx', 'answer', 'settle']);
    expect(undo.model.cur?.undone).toBe(true);
    expect(notchTick(undo.model, 6000).out).toEqual([]);
  });

  test('a letter that ran out is vouched for only when the page saw it', () => {
    const letter = { id: 'l', kind: 'send', say: ['Sending'], ms: 4000, blocks: [{ kind: 'note', say: ['Hi'] }] } as NotchLine;
    const model = notchTimed(notchFuseUp(upAt(letter, 1000), 1), 'l', 4000, 1000);
    const seen = notchTick(model, 5000, { letterSeen: true });
    expect(dos(seen.out)).toEqual(['unfuse', 'depart', 'clearHint', 'answer', 'settle']);
    expect(answers(seen.out)[0]).toMatchObject({ act: 'done', seen: true });
    const unseen = notchTick(model, 5000, { letterSeen: false });
    expect(dos(unseen.out)).toEqual(['unfuse', 'clearHint', 'answer', 'settle']);
    expect(answers(unseen.out)[0]).not.toHaveProperty('seen');
  });
});

describe('what follows from the line', () => {
  const offer: NotchLine = { id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show' };

  test('an answer the brain never had reopens the line it held, but never a fuse said to have run out', () => {
    const held = notchInput(upAt(offer), { kind: 'yes' }, 2000).model;
    const lost = notchLost(held, { type: 'answer', id: 'o', act: 'yes' });
    expect(dos(lost.out)).toEqual(['reopen', 'outOfStep']);
    expect(lost.model.cur?.done).toBe(false);
    const send: NotchLine = { id: 'f', kind: 'send', say: ['Sending'], ms: 10 };
    const ran = notchTick(notchTimed(notchFuseUp(upAt(send), 1), 'f', 10, 1000), 2000).model;
    expect(dos(notchLost(ran, { type: 'answer', id: 'f', act: 'done' }).out)).toEqual(['outOfStep']);
  });

  test('Esc is wanted for an open line, not for work unless pointed at, and not in the first moment of one that came by itself', () => {
    const facts = { alive: true, work: false, pointerOnNotch: false, picking: false };
    expect(notchWantsEsc(upAt(offer), 2000, facts)).toEqual({ want: true, again: null });
    expect(notchWantsEsc(upAt(offer), 2000, { ...facts, work: true }).want).toBe(false);
    expect(notchWantsEsc(upAt(offer), 2000, { ...facts, work: true, pointerOnNotch: true }).want).toBe(true);
    const early = notchWantsEsc(upAt({ ...offer, unasked: true }, 1000), 1100, facts);
    expect(early).toEqual({ want: false, again: NOTCH_GATE_MS.unasked - 100 + 20 });
  });
});
