import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { NotchFromPage, NotchLine } from '../../../../src/notch/protocol.ts';
import type { NotchSurface } from './index.ts';

// A page without a screen: there is no layout here, so sizes are not tested
// (they are checked against the prototype in a real browser, by hand). What is
// tested is the contract: what each kind of line draws, and what each thing a
// person can do with it sends.
let createNotchSurface: (typeof import('./index.ts'))['createNotchSurface'];
let partsText: (typeof import('./sentence.ts'))['partsText'];
let root: HTMLElement, surface: NotchSurface, sent: NotchFromPage[], focus: boolean[];

const wait = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(selector: string): T | null => root.querySelector<T>(selector);
const all = (selector: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)];
const body = (): string | undefined => $('.nin')?.dataset.body;
const said = (): string => ($('.say')?.textContent ?? '').replace(/\s+/g, ' ').trim();
const show = (line: NotchLine): void => surface.receive({ type: 'show', line });

beforeAll(async () => {
  GlobalRegistrator.register();
  ({ createNotchSurface } = await import('./index.ts'));
  ({ partsText } = await import('./sentence.ts'));
});
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
  sent = [];
  focus = [];
  surface = createNotchSurface(root, (message) => sent.push(message), { focus: (take) => focus.push(take), reducedMotion: true });
  surface.receive({ type: 'state', line: null, count: 0 });
});
afterEach(() => {
  surface.destroy();
  root.remove();
});

describe('before the brain has spoken', () => {
  test('nothing is on screen and nothing is drawn', () => {
    const fresh = document.createElement('div');
    document.body.append(fresh);
    const quiet = createNotchSurface(fresh, () => {}, { reducedMotion: true });
    expect(quiet.outlines(0)).toEqual([]);
    quiet.receive({ type: 'show', line: { id: 'x', kind: 'say', say: ['Too early.'], ms: 1000 } });
    expect(fresh.querySelector<HTMLElement>('.nin')?.dataset.body).toBe('rest');
    quiet.destroy();
    fresh.remove();
  });

  test('a state with a line shows it at once', () => {
    surface.receive({ type: 'state', line: { id: 's', kind: 'offer', say: ['Reply to ', { em: 'Marco' }, '?'], yes: 'show' }, count: 3 });
    expect(body()).toBe('line');
    expect(said()).toContain('Reply to Marco?');
  });
});

describe('an offer', () => {
  test('shows its sentence, the word for yes, and answers yes once', () => {
    show({ id: 'o1', kind: 'offer', say: ['Reply to ', { em: 'Marco' }, '?'], yes: 'show' });
    expect(body()).toBe('line');
    expect($('.say .em')?.textContent).toBe('Marco');
    const yes = all('.hint .key')[0]!;
    expect(yes.textContent).toContain('show');
    yes.click();
    yes.click();
    expect(sent).toEqual([{ type: 'answer', id: 'o1', act: 'yes' }]);
    // It stays as it is until the brain says what comes next.
    expect(body()).toBe('line');
    expect($('.nin')?.classList.contains('answered')).toBe(true);
  });

  test('"not now" answers no and rests', () => {
    show({ id: 'o2', kind: 'offer', say: ['Reply?'], yes: 'show' });
    all('.hint .key')[1]!.click();
    expect(sent).toEqual([{ type: 'answer', id: 'o2', act: 'no' }]);
    expect(body()).toBe('rest');
  });

  test('left alone it folds after its time, and not before', async () => {
    show({ id: 'o3', kind: 'offer', say: ['Reply?'], yes: 'show', fold: 60 });
    await wait(20);
    expect(sent).toEqual([]);
    await wait(120);
    expect(sent).toEqual([{ type: 'answer', id: 'o3', act: 'fold' }]);
    expect(body()).toBe('rest');
  });

  test('with options it is a row of choices, and a click picks by text and place', () => {
    show({ id: 'c1', kind: 'offer', say: ['Which day?'], options: ['Thursday', 'Friday'] });
    expect(body()).toBe('choices');
    const buttons = all('.opts .btn');
    expect(buttons.map((b) => b.textContent)).toEqual(['1Thursday', '2Friday']);
    buttons[1]!.click();
    buttons[0]!.click();
    expect(sent).toEqual([{ type: 'answer', id: 'c1', act: 'pick', option: 'Friday', index: 1 }]);
  });
});

describe('a lit word', () => {
  const chase: NotchLine = {
    id: 'w1', kind: 'offer', yes: 'draft', fold: 0,
    say: ['Chase ', { word: { name: 'tone', value: 'politely', options: ['politely', 'firmly'], label: 'Tone', syn: { firmly: ['tough'] } } }, '?'],
  };

  test('a click moves it to its next option, opens the strip, and says what it is now', () => {
    show(chase);
    $('.say .live')!.click();
    expect($('.say .live')?.textContent).toBe('firmly');
    expect(all('.pick .o').map((o) => [o.textContent, o.getAttribute('aria-pressed')])).toEqual([['politely', 'false'], ['firmly', 'true']]);
    expect(sent).toEqual([{ type: 'answer', id: 'w1', act: 'word', word: 'tone', value: 'firmly' }]);
  });

  test('a typed value is read, and one that means nothing is refused without a word to the brain', () => {
    show(chase);
    $('.say .live')!.click();
    $('.say .live')!.click();
    sent.length = 0;
    const field = $<HTMLInputElement>('.pick input')!;
    const type = (text: string): void => {
      field.value = text;
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    };
    type('xyzzy');
    expect(sent).toEqual([]);
    expect(field.classList.contains('no')).toBe(true);
    expect(field.placeholder).toBe('I did not get that');
    type('be tough');
    expect(sent).toEqual([{ type: 'answer', id: 'w1', act: 'word', word: 'tone', value: 'firmly' }]);
    expect($('.pick')?.childElementCount).toBe(0);
  });

  test('the sentence read out carries the word as it stands', () => {
    expect(partsText(chase.say)).toBe('Chase politely?');
    expect(partsText(['Hold ', { key: 'esc' }, ' and ', { em: 'wait' }])).toBe('Hold esc and wait');
  });
});

describe('a sheet', () => {
  const sheet: NotchLine = {
    id: 's1', kind: 'sheet', say: ['Overnight'], yes: 'send',
    blocks: [
      { kind: 'row', id: 'pay', lead: 'Otto', say: ['wants to pay ', { em: 'Brightline' }], small: '07:32', buttons: [{ id: 'pay', label: 'Pay', key: 1 }, { id: 'notyet', label: 'Not yet', key: 2 }] },
      { kind: 'row', id: 'agents', say: [{ em: '2 agents' }, ' on duty.'], go: true },
      { kind: 'paper', to: ['To ', { em: 'Marco' }], lines: [['Hi Marco,'], ['Does ', { word: { name: 'when', value: 'Thursday', options: ['Thursday', 'Friday'] } }, ' work?']], file: { name: 'Deck.pdf', size: '2.4 MB' } },
      { kind: 'note', say: ['Not sent yet.'] },
      { kind: 'buttons', buttons: [{ id: 'memory', label: 'Memory', quiet: true }] },
      { kind: 'file', icon: 'audio', name: 'Call.m4a', meta: 'Audio' },
    ],
  };

  test('draws every kind of block', () => {
    show(sheet);
    expect(body()).toBe('sheet');
    expect(said()).toContain('Overnight');
    expect($('.sheet .row.stack .mn')?.textContent).toBe('Otto wants to pay Brightline');
    expect($('.sheet .row.stack .at')?.textContent).toBe('07:32');
    expect(all('.sheet .row.stack .btn').map((b) => b.textContent)).toEqual(['1Pay', '2Not yet']);
    expect($('.sheet .row.go')?.textContent).toContain('2 agents on duty.');
    expect($('.sheet .paper .to')?.textContent).toBe('To Marco');
    expect(all('.sheet .paper p').length).toBe(3);
    expect($('.sheet .paper .live')?.textContent).toBe('Thursday');
    expect($('.sheet .paper .file')?.textContent).toBe('Deck.pdf2.4 MB');
    expect($('.sheet .note')?.textContent).toBe('Not sent yet.');
    expect($('.sheet .quietlinks button')?.textContent).toBe('Memory');
    expect($('.sheet .filecard b')?.textContent).toBe('Call.m4a');
  });

  test('a button answers with its id and its row; a row that opens answers go', () => {
    show(sheet);
    all('.sheet .row.stack .btn')[0]!.click();
    $('.sheet .row.go')!.click();
    $<HTMLElement>('.sheet .quietlinks button')!.click();
    expect(sent).toEqual([
      { type: 'answer', id: 's1', act: 'button', button: 'pay', row: 'pay' },
      { type: 'answer', id: 's1', act: 'go', row: 'agents' },
      { type: 'answer', id: 's1', act: 'button', button: 'memory' },
    ]);
  });

  test('an update replaces its content in place, without showing it again', () => {
    show(sheet);
    surface.receive({ type: 'update', id: 's1', blocks: [{ kind: 'row', id: 'pay', lead: 'Otto', say: ['will pay Brightline on Friday.'] }] });
    expect(body()).toBe('sheet');
    expect(all('.sheet .btn')).toEqual([]);
    expect($('.sheet')?.textContent).toContain('will pay Brightline on Friday.');
    surface.receive({ type: 'update', id: 'another', blocks: [] });
    expect($('.sheet')?.textContent).toContain('will pay Brightline on Friday.');
  });

  test('closing it answers no and rests', () => {
    show(sheet);
    all('.hint .key').at(-1)!.click();
    expect(sent).toEqual([{ type: 'answer', id: 's1', act: 'no' }]);
    expect(body()).toBe('rest');
  });
});

describe('the other kinds of line', () => {
  test('a result leaves by itself and says so', async () => {
    show({ id: 'r1', kind: 'say', say: ['Sent.'], ms: 40, mark: 'check', mood: 'happy' });
    expect($('.nin')?.dataset.mark).toBe('check');
    expect($('.nin')?.dataset.mood).toBe('happy');
    await wait(120);
    expect(sent).toEqual([{ type: 'answer', id: 'r1', act: 'done' }]);
    expect(body()).toBe('rest');
  });

  test('work shows its beads and moves them on; stop answers stop', () => {
    show({ id: 'k1', kind: 'work', say: ['Pasting'], steps: 4, done: 1 });
    expect(body()).toBe('work');
    expect(all('.beads i').map((b) => b.className)).toEqual(['on', 'now', '', '']);
    surface.receive({ type: 'update', id: 'k1', done: 3, say: ['Pasting, ', { em: 'without fees' }] });
    expect(all('.beads i').map((b) => b.className)).toEqual(['on', 'on', 'on', 'now']);
    expect($('.hint .count')?.textContent).toBe('3/4');
    expect(said()).toContain('without fees');
    all('.hint .key').at(-1)!.click();
    expect(sent).toEqual([{ type: 'answer', id: 'k1', act: 'stop' }]);
  });

  test('a send answers done when its window runs out, and only undo if it is taken back', async () => {
    show({ id: 'f1', kind: 'send', say: ['Sending…'], ms: 40 });
    await wait(120);
    expect(sent).toEqual([{ type: 'answer', id: 'f1', act: 'done' }]);
    sent.length = 0;
    show({ id: 'f2', kind: 'send', say: ['Sending…'], ms: 60 });
    all('.hint .key')[0]!.click();
    await wait(140);
    expect(sent).toEqual([{ type: 'answer', id: 'f2', act: 'undo' }]);
  });

  test('typed text is sent as ask, and the keyboard is asked for and given back', () => {
    show({ id: 'a1', kind: 'ask', say: [], yes: 'go', placeholder: 'Try: every Monday', blocks: [] });
    expect(body()).toBe('ask');
    const field = $<HTMLInputElement>('input.ask')!;
    expect(field.placeholder).toBe('Try: every Monday');
    field.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(focus).toEqual([true]);
    field.value = '  Who said what  ';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(sent).toEqual([{ type: 'answer', id: 'a1', act: 'ask', text: 'Who said what' }]);
  });

  test('words heard appear as they are made out', () => {
    show({ id: 'l1', kind: 'listen', say: [], heard: '' });
    surface.receive({ type: 'update', id: 'l1', heard: 'Every Monday' });
    expect($('.heard')?.textContent).toBe('Every Monday');
  });

  test('who is speaking and which app it is about', () => {
    show({ id: 'p1', kind: 'offer', say: ['Stopped.'], yes: 'sign in', who: 'Otto', mark: 'fail' });
    expect($('.appicon .who')?.textContent).toBe('O');
    show({ id: 'p2', kind: 'offer', say: ['Reply?'], yes: 'show', src: 'mail' });
    expect($('.appicon svg')).not.toBeNull();
    expect($('.appicon')?.classList.contains('from')).toBe(true);
  });
});

describe('rest, the count and the eyes', () => {
  test('the count shows at rest and hides behind a line', () => {
    surface.receive({ type: 'count', count: 3 });
    expect($('.badge')?.textContent).toBe('3');
    expect($('.nin')?.dataset.wait).toBe('count');
    show({ id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show' });
    expect($('.badge')?.textContent).toBe('');
    surface.receive({ type: 'rest' });
    expect($('.badge')?.textContent).toBe('3');
    surface.receive({ type: 'count', count: 0 });
    expect($('.nin')?.dataset.wait).toBe('');
  });

  test('a click on the resting notch says open, and on a line it does not', () => {
    $('.notch')!.click();
    expect(sent).toEqual([{ type: 'open' }]);
    show({ id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show' });
    $('.notch')!.click();
    expect(sent).toEqual([{ type: 'open' }]);
  });

  test('an act changes the face and is not a line', () => {
    surface.receive({ type: 'act', mood: 'focus', eye: true });
    expect($('.nin')?.dataset.mood).toBe('focus');
    expect($('.nin')?.dataset.eye).toBe('eye');
    expect(body()).toBe('rest');
    surface.receive({ type: 'act', eye: false });
    expect($('.nin')?.dataset.eye).toBeUndefined();
  });
});

describe('the keys', () => {
  // A line that only just appeared cannot be answered by keys already on their way down.
  const settleKeys = (): Promise<void> => wait(380);

  test('yes answers what is offered, and not before the line has been up a moment', async () => {
    show({ id: 'o1', kind: 'offer', say: ['Reply?'], yes: 'show' });
    surface.key('yes');
    expect(sent).toEqual([]);
    await settleKeys();
    surface.key('yes');
    surface.key('yes');
    expect(sent).toEqual([{ type: 'answer', id: 'o1', act: 'yes' }]);
  });

  test('yes with nothing on the notch opens it', async () => {
    await settleKeys();
    surface.key('yes');
    expect(sent).toEqual([{ type: 'open' }]);
  });

  test('yes on a row of choices picks nothing: the row nods', async () => {
    show({ id: 'c1', kind: 'offer', say: ['Which?'], options: ['A', 'B'] });
    await settleKeys();
    surface.key('yes');
    expect(sent).toEqual([]);
    expect($('.opts')?.classList.contains('nudge')).toBe(true);
  });

  test('Esc closes what is on the notch, and an open strip first', async () => {
    show({ id: 's1', kind: 'sheet', say: ['Overnight'], blocks: [] });
    surface.key('esc');
    expect(sent).toEqual([{ type: 'answer', id: 's1', act: 'no' }]);
    expect(body()).toBe('rest');
    sent.length = 0;
    show({ id: 'w1', kind: 'offer', yes: 'draft', fold: 0, say: ['Chase ', { word: { name: 'tone', value: 'politely', options: ['politely', 'firmly'] } }, '?'] });
    $('.say .live')!.click();
    sent.length = 0;
    surface.key('esc');
    expect($('.pick')?.childElementCount).toBe(0);
    expect(sent).toEqual([]);
    surface.key('esc');
    expect(sent).toEqual([{ type: 'answer', id: 'w1', act: 'no' }]);
  });

  test('Esc twice asks for everything to stop', () => {
    surface.key('esc-twice');
    expect(sent).toEqual([{ type: 'stop' }]);
  });

  test('holding the talk pair perks it up, and letting go rests it', () => {
    surface.key('talk-start');
    expect($('.wrap')?.classList.contains('att')).toBe(true);
    expect($('.lead .cap.held')).not.toBeNull();
    surface.key('talk-end');
    expect($('.wrap')?.classList.contains('att')).toBe(false);
  });

  test('it says when Esc would do something here, and when it would not', () => {
    const wants: boolean[] = [];
    surface.onWantEsc((want) => wants.push(want));
    show({ id: 'o1', kind: 'offer', say: ['Reply?'], yes: 'show' });
    expect(wants).toEqual([true]);
    all('.hint .key')[0]!.click();
    // Answered: Esc would do nothing now, so it is the app's again.
    expect(wants).toEqual([true, false]);
    show({ id: 'o2', kind: 'offer', say: ['Again?'], yes: 'show' });
    surface.receive({ type: 'rest' });
    expect(wants).toEqual([true, false, true, false]);
  });

  test('the hints show the machine\'s own keys, and nonsense leaves them as they were', () => {
    show({ id: 'o1', kind: 'offer', say: ['Reply?'], yes: 'show' });
    const caps = (): string => all('.hint .key .cap b').map((b) => b.textContent).join('+');
    const before = caps();
    surface.setPairs({ talk: ['ctrl', 'alt'], yes: ['shift', 'meta'] });
    expect(caps()).not.toBe(before);
    const changed = caps();
    for (const bad of [null, {}, { talk: ['ctrl', 'ctrl'], yes: ['alt', 'meta'] }, { talk: ['ctrl', 'alt'], yes: ['alt', 'ctrl'] }, { talk: ['ctrl', 'f1'], yes: ['alt', 'meta'] }]) {
      surface.setPairs(bad);
      expect(caps()).toBe(changed);
    }
    surface.setPairs({ talk: ['ctrl', 'meta'], yes: ['meta', 'alt'] });
    expect(caps()).toBe(before);
  });

  test('a key it does not know is ignored', () => {
    surface.key('f13');
    surface.key('');
    expect(sent).toEqual([]);
  });
});

describe('what should never break it', () => {
  test('nonsense is ignored, and the line on the notch stays', () => {
    show({ id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show' });
    const junk: unknown[] = [null, 'show', 42, {}, { type: 'nothing' }, { type: 'update', id: 'o' },
      { type: 'show', line: { id: 'x', kind: 'sheet', say: ['T'], blocks: [{ kind: 'unknown' }] } }];
    for (const message of junk) surface.receive(message as never);
    expect(sent).toEqual([]);
    expect(body()).not.toBeUndefined();
  });

  test('an answer about a line names that line, never the one before', () => {
    show({ id: 'first', kind: 'offer', say: ['One?'], yes: 'yes' });
    show({ id: 'second', kind: 'offer', say: ['Two?'], yes: 'yes' });
    all('.hint .key')[0]!.click();
    expect(sent).toEqual([{ type: 'answer', id: 'second', act: 'yes' }]);
  });
});
