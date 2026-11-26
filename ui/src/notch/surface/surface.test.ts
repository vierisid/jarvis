import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { NotchFromPage, NotchLine } from '../../../../src/notch/protocol.ts';
import { scripted, type ScriptedSurface as NotchSurface } from './test-brain.ts';

// A page without a screen: there is no layout here, so sizes are not tested
// (they are checked against the prototype in a real browser, by hand). What is
// tested is the contract: what each kind of line draws, and what each thing a
// person can do with it sends.
let createNotchSurface: ReturnType<typeof scripted>;
let partsText: (typeof import('./sentence.ts'))['partsText'];
let NOTCH_GECKO_MS: number;
let root: HTMLElement, surface: NotchSurface, sent: NotchFromPage[], focus: boolean[];

const wait = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(selector: string): T | null => root.querySelector<T>(selector);
const all = (selector: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)];
const body = (): string | undefined => $('.nin')?.dataset.body;
const said = (): string => ($('.say')?.textContent ?? '').replace(/\s+/g, ' ').trim();
const show = (line: NotchLine): void => surface.receive({ type: 'show', line });

beforeAll(async () => {
  GlobalRegistrator.register();
  // The page behind a brain that says what the tests say in version 2 of the messages (./test-brain.ts).
  createNotchSurface = scripted((await import('./index.ts')).createNotchSurface);
  ({ partsText } = await import('./sentence.ts'));
  ({ NOTCH_GECKO_MS } = await import('./eyes.ts'));
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

  test('left alone it stays: when it folds is the brain\'s to say, and the page says no fold of its own', async () => {
    show({ id: 'o3', kind: 'offer', say: ['Reply?'], yes: 'show', fold: 60 });
    await wait(150);
    expect(sent).toEqual([]);
    expect(body()).toBe('line');
    // The brain folds it: the page is told to rest, like any page that shows it.
    surface.receive({ type: 'rest' });
    expect(sent).toEqual([]);
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

  describe('that must be seen whole', () => {
    const whole: NotchLine = { id: 'w1', kind: 'sheet', say: ['For Sam. Send only that?'], yes: 'send', no: 'not now', stay: true, whole: true, blocks: [{ kind: 'paper', lines: [['One.'], ['Two.']] }] };
    /** There is no layout here: the sheet is given a height and a length of its own. */
    const sized = (visible: number, total: number): HTMLElement => {
      const el = $('.sheet')!;
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => visible });
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => total });
      return el;
    };
    const answers = (): string[] => sent.filter((m) => m.type === 'answer').map((m) => (m as { act: string }).act);

    test('a yes with its end out of sight moves it down a page, and answers nothing', async () => {
      show(whole);
      const el = sized(500, 1700);
      await wait(400);
      surface.key('yes');
      expect(answers()).toEqual([]);
      expect(el.scrollTop).toBe(436);
      surface.key('yes');
      surface.key('yes');
      expect(answers()).toEqual([]);
      expect(el.scrollTop).toBeGreaterThanOrEqual(1200);
      // Its end has only just come up: a press straight behind the one that brought it is not a yes.
      surface.key('yes');
      expect(answers()).toEqual([]);
      await wait(650);
      surface.key('yes');
      expect(answers()).toEqual(['yes']);
    });

    test('once its end was seen, scrolling back up does not take the yes away', async () => {
      show(whole);
      const el = sized(500, 1700);
      await wait(400);
      el.scrollTop = 1200;
      el.dispatchEvent(new Event('scroll'));
      await wait(700);
      el.scrollTop = 0;
      surface.key('yes');
      expect(answers()).toEqual(['yes']);
    });

    test('one that fits is answered by a yes once it has been up for a moment, and Esc is never held back', async () => {
      show(whole);
      sized(500, 300);
      await wait(1000);
      surface.key('yes');
      expect(answers()).toEqual(['yes']);
      show({ ...whole, id: 'w2' });
      sized(500, 1700);
      await wait(400);
      surface.key('esc');
      expect(answers()).toEqual(['yes', 'no']);
    });

    test('the next sheet starts unseen again', async () => {
      show(whole);
      sized(500, 300);
      await wait(1000);
      surface.key('yes');
      show({ ...whole, id: 'w3' });
      sized(500, 1700);
      await wait(400);
      surface.key('yes');
      expect(answers()).toEqual(['yes']);
    });

    test('a sheet that grew after its end was seen is unseen again', async () => {
      show(whole);
      const el = sized(500, 300);
      await wait(1000);
      surface.receive({ type: 'update', id: 'w1', blocks: [{ kind: 'paper', lines: [['One.'], ['Two.'], ['Three.']] }] });
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1700 });
      await wait(60);
      surface.key('yes');
      expect(answers()).toEqual([]);
    });

    test('a sheet that does not ask for it is answered as before', async () => {
      show({ ...whole, id: 'w4', whole: false });
      sized(500, 1700);
      await wait(400);
      surface.key('yes');
      expect(answers()).toEqual(['yes']);
    });
  });

  describe('a click that cannot have been meant for the line', () => {
    const answers = (): string[] => sent.filter((m) => m.type === 'answer').map((m) => `${(m as { id: string }).id}:${(m as { act: string }).act}`);
    const yesOf = (): HTMLElement => all('.hint .key').find((el) => /read|do it|send|ok/.test(el.textContent ?? ''))!;

    test('a line that came by itself takes no click on its yes or on a choice for its first moment, as it takes no key', async () => {
      show({ id: 'u1', kind: 'offer', say: ['Approve?'], yes: 'ok', unasked: true });
      yesOf().click();
      expect(answers()).toEqual([]);
      await wait(750);
      yesOf().click();
      expect(answers()).toEqual(['u1:yes']);
      show({ id: 'u2', kind: 'offer', say: ['Sam asks me: the deck. Do it here?'], options: ['Do it', 'No'], unasked: true });
      all('.opts > *')[0]!.click();
      expect(answers()).toEqual(['u1:yes']);
    });

    test('the second half of a double click does not answer the line the first half brought up', async () => {
      show({ id: 'r1', kind: 'offer', say: ['Sam asks me for something. Read it?'], yes: 'read' });
      await wait(400);
      yesOf().click();
      expect(answers()).toEqual(['r1:yes']);
      // The brain puts the request up within milliseconds. The second click of the double click is already on its way.
      show({ id: 'r2', kind: 'sheet', say: ['Sam asks me'], yes: 'do it', no: 'not now', stay: true, blocks: [{ kind: 'paper', lines: [['Short.']] }] });
      await wait(120);
      yesOf().click();
      expect(answers()).toEqual(['r1:yes']);
      // A click made on purpose, later, is an answer.
      await wait(700);
      yesOf().click();
      expect(answers()).toEqual(['r1:yes', 'r2:yes']);
    });
  });

  test('a field that stays is not closed by a press somewhere else, and Esc still closes it', async () => {
    show({ id: 'n1', kind: 'ask', say: ['The code matched. Name them.'], placeholder: 'Their name', yes: 'connect', stay: true, blocks: [] });
    await wait(400);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    document.body.click();
    expect(sent.filter((m) => m.type === 'answer')).toEqual([]);
    expect(body()).toBe('ask');
    surface.key('esc');
    expect(sent.filter((m) => m.type === 'answer').map((m) => (m as { act: string }).act)).toEqual(['no']);
  });

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

describe('a sentence that must be shown whole', () => {
  let wordBlocks: (typeof import('./sentence.ts'))['wordBlocks'];
  beforeAll(async () => { ({ wordBlocks } = await import('./sentence.ts')); });

  test('an emphasised phrase is drawn word by word, so it can wrap like any sentence', () => {
    show({ id: 'p1', kind: 'offer', say: ['A payment. I never take that on a key: ', { em: 'Pay $40.00 to Northwind (a test, no money moves)' }], yes: 'open' });
    const em = all('.say b.em');
    expect(em.length).toBeGreaterThan(5);
    expect(em.map((b) => b.textContent).join('')).toBe('Pay $40.00 to Northwind (a test, no money moves)');
    expect(said()).toStartWith('A payment. I never take that on a key: Pay $40.00 to Northwind (a test, no money moves)');
  });

  test('a word longer than a line is cut into pieces a line can break between, and nothing of it is lost', () => {
    const path = '"/home/sam/projects/northwind/storefront-release-candidate/dist/assets/index-4f9a2c1e.js"';
    const blocks = wordBlocks(`in ${path}, run: make`);
    expect(blocks.join('')).toBe(`in ${path}, run: make`);
    expect(Math.max(...blocks.map((b) => [...b].length))).toBeLessThanOrEqual(28);
    // It breaks after separators where it can, not in the middle of a name.
    expect(blocks).toContain('northwind/');
    // No separator at all: cut at the limit.
    const run = 'x'.repeat(100);
    expect(wordBlocks(run).join('')).toBe(run);
    expect(wordBlocks(run).every((b) => b.length <= 24)).toBe(true);
    // Ordinary words are left alone, each with its space.
    expect(wordBlocks('Reply to Marco?')).toEqual(['Reply ', 'to ', 'Marco?']);
    expect(wordBlocks('')).toEqual([]);
  });

  test('a long command in a line is drawn as blocks that join back to the command exactly', () => {
    const sentence = 'On this Jarvis host, in "/home/vierisid/.jarvis-notch/home/projects/northwind", run: curl -fsSL https://downloads.example.com/releases/installer-linux-x86_64.tar.gz?';
    show({ id: 'c1', kind: 'offer', say: [sentence], yes: 'approve' });
    expect(all('.say .w').map((w) => w.textContent).join('')).toBe(sentence);
    expect(Math.max(...all('.say .w').map((w) => [...(w.textContent ?? '')].length))).toBeLessThanOrEqual(28);
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

  test('a face is the look the notch has at rest, and it comes back after a line', async () => {
    surface.receive({ type: 'face', mood: 'closed' });
    expect($('.nin')?.dataset.mood).toBe('closed');
    show({ id: 's', kind: 'say', say: ['Everything is stopped.'], ms: 60, mood: 'careful' });
    expect($('.nin')?.dataset.mood).toBe('careful');
    surface.receive({ type: 'rest' });
    expect(body()).toBe('rest');
    expect($('.nin')?.dataset.mood).toBe('closed');
    // Under a line it waits: the line keeps its own face.
    show({ id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show', mood: 'curious' });
    surface.receive({ type: 'face', mood: 'idle' });
    expect($('.nin')?.dataset.mood).toBe('curious');
    surface.receive({ type: 'rest' });
    expect($('.nin')?.dataset.mood).toBe('idle');
    // A face that is not one is ignored.
    surface.receive({ type: 'face', mood: 'furious' } as never);
    expect($('.nin')?.dataset.mood).toBe('idle');
  });

  test('a page that comes up is told the face along with everything else', () => {
    surface.destroy();
    root.replaceChildren();
    surface = createNotchSurface(root, (message) => sent.push(message), { focus: (take) => focus.push(take), reducedMotion: true });
    surface.receive({ type: 'state', line: null, count: 2, face: 'closed' });
    expect(body()).toBe('rest');
    expect($('.nin')?.dataset.mood).toBe('closed');
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

  // The test from the plan: tap yes within half a second of a line arriving.
  test('a line that came by itself takes no yes for 0.7 seconds', async () => {
    show({ id: 'a1', kind: 'offer', say: ['Send the pricing to Anna?'], yes: 'send', unasked: true });
    await wait(500);
    surface.key('yes');
    expect(sent).toEqual([]);
    await wait(260);
    surface.key('yes');
    expect(sent).toEqual([{ type: 'answer', id: 'a1', act: 'yes' }]);
  });

  test('a line that came by itself takes no Esc for 0.7 seconds either, and then Esc is its no', async () => {
    show({ id: 'a2', kind: 'offer', say: ['Get system info?'], yes: 'approve', unasked: true });
    await wait(300);
    surface.key('esc');
    expect(sent).toEqual([]);
    expect(body()).toBe('line');
    await wait(460);
    surface.key('esc');
    expect(sent).toEqual([{ type: 'answer', id: 'a2', act: 'no' }]);
    expect(body()).toBe('rest');
  });

  test('a line the person asked for takes Esc at once', () => {
    show({ id: 'a3', kind: 'offer', say: ['Get system info?'], yes: 'approve' });
    surface.key('esc');
    expect(sent).toEqual([{ type: 'answer', id: 'a3', act: 'no' }]);
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

describe('talking and typing (pass 5)', () => {
  test('Esc on what is being heard turns it away', () => {
    show({ id: 'l', kind: 'listen', say: [], heard: 'delete every' });
    expect($('.heard')?.textContent).toBe('delete every');
    surface.key('esc');
    expect(sent).toEqual([{ type: 'answer', id: 'l', act: 'no' }]);
    expect(body()).toBe('rest');
  });

  test('a recording ended by a slip lets go of the keys like one that was let go', () => {
    surface.key('talk-start');
    expect($('.wrap')?.classList.contains('att')).toBe(true);
    surface.key('talk-cancel');
    expect($('.wrap')?.classList.contains('att')).toBe(false);
  });

  test('work with no known number of steps draws no beads, and Esc still stops it', () => {
    show({ id: 'w', kind: 'work', say: ['Running a command.'], steps: 0, done: 0 });
    expect(body()).toBe('work');
    expect(said()).toBe('Running a command.');
    expect($('.beads')).toBeNull();
    expect($('.count')).toBeNull();
    surface.receive({ type: 'update', id: 'w', say: ['Searching the web.'] });
    expect(said()).toBe('Searching the web.');
    surface.key('esc');
    expect(sent).toEqual([{ type: 'answer', id: 'w', act: 'stop' }]);
  });

  test('a text field opened to type in takes the keyboard, and gives it back when it goes', () => {
    show({ id: 'h', kind: 'ask', say: [], yes: 'ask', placeholder: 'Ask', blocks: [], focus: true });
    const input = $<HTMLInputElement>('input.ask')!;
    expect(focus).toEqual([true]);
    expect(document.activeElement).toBe(input);
    // Esc from the key watcher, not from the field: the field never saw it.
    surface.key('esc');
    expect(sent).toEqual([{ type: 'answer', id: 'h', act: 'no' }]);
    expect(focus).toEqual([true, false]);
  });

  test('a field replaced by another line gives the keyboard back too', () => {
    show({ id: 'h', kind: 'ask', say: [], yes: 'ask', placeholder: 'Ask', blocks: [], focus: true });
    show({ id: 'w', kind: 'work', say: ['On it.'], steps: 0, done: 0 });
    expect(focus).toEqual([true, false]);
  });

  test('a field that is only drawn again does not take the keyboard', () => {
    surface.receive({ type: 'state', count: 0, line: { id: 'h', kind: 'ask', say: [], yes: 'ask', placeholder: 'Ask', blocks: [], focus: true } });
    expect(focus).toEqual([]);
  });

  test('a field without the word for it waits for a click, as before', () => {
    show({ id: 'h', kind: 'ask', say: [], yes: 'ask', placeholder: 'Ask', blocks: [] });
    expect(focus).toEqual([]);
  });
});

describe('what was heard, once the keys are up', () => {
  const hints = (): string => ($('.hint')?.textContent ?? '').replace(/\s+/g, ' ').trim();

  test('while listening the hint is to let go; once the keys are up it is Esc', () => {
    show({ id: 'l', kind: 'listen', say: [], heard: '' });
    expect(hints()).toContain('let go when done');
    expect($('.wrap')?.classList.contains('talk')).toBe(true);
    surface.receive({ type: 'update', id: 'l', over: true });
    expect(hints()).not.toContain('let go');
    expect(hints()).toContain('not this');
    expect($('.wrap')?.classList.contains('talk')).toBe(false);
    surface.receive({ type: 'update', id: 'l', heard: 'send Leo the numbers', over: true });
    expect($('.heard')?.textContent).toBe('send Leo the numbers');
    surface.key('esc');
    expect(sent).toEqual([{ type: 'answer', id: 'l', act: 'no' }]);
  });

  test('a line that arrives already over never asks to let go', () => {
    show({ id: 'l', kind: 'listen', say: [], heard: 'send Leo the numbers', over: true });
    expect(hints()).toContain('not this');
    expect($('.wrap')?.classList.contains('talk')).toBe(false);
  });
});

test('a row that opens something still shows its small word', () => {
  show({ id: 's', kind: 'sheet', say: ['What you asked'], blocks: [{ kind: 'row', id: 'a1', lead: '15:08', say: ['send Leo the numbers'], small: 'done', go: true }] });
  const row = $('.sheet button.row.go')!;
  expect(row.querySelector('.at')?.textContent).toBe('done');
  row.click();
  expect(sent).toEqual([{ type: 'answer', id: 's', act: 'go', row: 'a1' }]);
});

describe('a sheet that asks for a decision', () => {
  const ask = (stay: boolean): NotchLine => ({
    id: 'a', kind: 'sheet', say: ['Look up where Steam is installed?'], yes: 'approve', ...(stay ? { stay: true } : {}),
    blocks: [{ kind: 'paper', lines: [['On this computer, run: reg query HKCU\\Software\\Valve\\Steam /v SteamExe']] }],
  });

  test('shows the question, the exact action under it, and what yes means', () => {
    show(ask(true));
    expect(said()).toContain('Look up where Steam is installed?');
    expect($('.sheet .paper')?.textContent).toContain('reg query HKCU\\Software\\Valve\\Steam /v SteamExe');
    const hint = ($('.hint')?.textContent ?? '').replace(/\s+/g, ' ');
    expect(hint).toContain('approve');
    // Yes is the pair of keys, not Enter: the notch has no keyboard here. And Esc says what it means.
    expect(hint.toLowerCase()).not.toContain('enter');
    expect(hint).toContain('no');
  });

  test('is not answered by a click somewhere else on the screen', () => {
    show(ask(true));
    surface.pointer(5, 600, true);
    surface.pointer(5, 600, false);
    expect(sent).toEqual([]);
    expect(body()).toBe('sheet');
    // Esc is a no, and yes is a yes.
    surface.key('esc');
    expect(sent).toEqual([{ type: 'answer', id: 'a', act: 'no' }]);
  });

  // A draft the owner opened to read: Esc closes it and throws nothing away, and the key says so.
  test('says what Esc does when that is not a no, and sends the same answer', () => {
    show({ ...ask(true), yes: 'send', no: 'back' } as NotchLine);
    const hint = ($('.hint')?.textContent ?? '').replace(/\s+/g, ' ');
    expect(hint).toContain('send');
    expect(hint).toContain('back');
    expect(hint).not.toMatch(/\bno\b/);
    surface.key('esc');
    expect(sent).toEqual([{ type: 'answer', id: 'a', act: 'no' }]);
  });

  test('a sheet that is only to be read still closes on a click away, once its first moment is over', async () => {
    show({ id: 'a', kind: 'sheet', say: ['What I can do'], blocks: [{ kind: 'note', say: ['Ask me anything.'] }] });
    // The press was on its way before the sheet was there: it answers nothing.
    surface.pointer(5, 600, true);
    surface.pointer(5, 600, false);
    expect(sent).toEqual([]);
    await wait(400);
    surface.pointer(5, 600, true);
    expect(sent).toEqual([{ type: 'answer', id: 'a', act: 'no' }]);
  });

  // The hardening audit, 17 November 2026: the chase sheet ("I will get it from Sam by Friday. Go?") came up
  // seconds after it was asked for, and the person's next click in their own app turned it down unseen.
  test('a sheet with a yes is a question: a click in another app does not answer it, stay or not', async () => {
    show(ask(false));
    await wait(400);
    surface.pointer(5, 600, true);
    expect(sent).toEqual([]);
    surface.key('esc');
    expect(sent).toEqual([{ type: 'answer', id: 'a', act: 'no' }]);
  });

  test('a question about a dropped file is not answered by the press that picks up a second file', async () => {
    show({ id: 'f', kind: 'ask', say: [], yes: 'ask', placeholder: 'Ask about it', blocks: [{ kind: 'file', icon: 'doc', name: 'Deck.pdf', meta: 'PDF' }] });
    await wait(400);
    surface.pointer(5, 600, true);
    expect(sent).toEqual([]);
  });
});

describe('first batch of the edge-case audit, on the page', () => {
  test('Esc is taken from the app in front for a piece of work only while the pointer is on the notch', () => {
    const wants: boolean[] = [];
    surface.onWantEsc((want) => wants.push(want));
    show({ id: 'w', kind: 'work', say: ['Running a command.'], steps: 0, done: 0 });
    // The work is up, the person is in their own app: Esc is theirs.
    expect(wants.at(-1) ?? false).toBe(false);
    // An offer takes it, as before.
    show({ id: 'o', kind: 'offer', say: ['Run it?'], yes: 'approve' });
    expect(wants.at(-1)).toBe(true);
  });

  test('the text field takes no more than the brain will read', () => {
    show({ id: 'h', kind: 'ask', say: [], yes: 'ask', placeholder: 'Ask', blocks: [] });
    expect($<HTMLInputElement>('input.ask')!.maxLength).toBe(4000);
  });
});

describe('the rest of the edge-case audit, on the page', () => {
  test('it says when a question is waiting for a yes or a no, and when it no longer is', () => {
    const asking: boolean[] = [];
    surface.onAsking((now) => asking.push(now));
    // A result is not a question: the window may stay hidden behind a film.
    show({ id: 's', kind: 'say', say: ['Done.'], ms: 4000 });
    expect(asking).toEqual([]);
    // An approval by key is one.
    show({ id: 'o', kind: 'offer', say: ['Run it?'], yes: 'approve' });
    expect(asking).toEqual([true]);
    all('.hint .key')[0]!.click();
    // Answered: nothing waits any more.
    expect(asking).toEqual([true, false]);
    // A sheet that stays until it is answered is one; a sheet to read is not.
    show({ id: 'r', kind: 'sheet', say: ['Your day'], blocks: [] });
    expect(asking).toEqual([true, false]);
    // Nor is a long answer, which stays until it is closed but asks nothing.
    show({ id: 'l', kind: 'sheet', say: ['You asked: tips'], stay: true, blocks: [] });
    expect(asking).toEqual([true, false]);
    show({ id: 'a', kind: 'sheet', say: ['Write the file?'], yes: 'approve', stay: true, blocks: [] });
    expect(asking).toEqual([true, false, true]);
    surface.receive({ type: 'rest' });
    expect(asking).toEqual([true, false, true, false]);
  });
});

describe('pass 6 on the page: where you are, beside the eyes', () => {
  // A 1 by 1 PNG.
  const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const icon = (): HTMLImageElement | null => $<HTMLImageElement>('.appicon img');
  const shown = (): boolean => $('.nin')!.dataset.icon === '1';

  test('at rest the front app\'s icon is drawn as a picture, and follows the app', () => {
    surface.receive({ type: 'where', app: { name: 'Notepad', icon: ICON } });
    expect(shown()).toBe(true);
    expect(icon()?.getAttribute('src')).toBe(ICON);
    // Another app with no icon: nothing is drawn rather than the old one.
    surface.receive({ type: 'where', app: { name: 'Steam' } });
    expect(shown()).toBe(false);
    expect(icon()).toBeNull();
    surface.receive({ type: 'where', app: { name: 'Notepad', icon: ICON } });
    surface.receive({ type: 'where', app: null });
    expect(shown()).toBe(false);
  });

  test('an icon is only ever a PNG picture: anything else is not drawn', () => {
    for (const bad of ['<svg onload=alert(1)>', 'javascript:alert(1)', 'https://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', `data:image/png;base64,${'A'.repeat(70_000)}`, 42]) {
      surface.receive({ type: 'where', app: { name: 'X', icon: bad as string } });
      expect([String(bad).slice(0, 30), shown(), icon()]).toEqual([String(bad).slice(0, 30), false, null]);
    }
    expect($('.appicon')!.innerHTML).toBe('');
  });

  test('a line takes the icon\'s place, and the icon is back when the notch rests again', () => {
    surface.receive({ type: 'where', app: { name: 'Notepad', icon: ICON } });
    show({ id: 's', kind: 'say', say: ['Done.'], ms: 4000 });
    expect(icon()).toBeNull();
    surface.receive({ type: 'rest' });
    expect(icon()?.getAttribute('src')).toBe(ICON);
  });

  test('with the eyes closed or turned aside no app is shown: I am not watching it', () => {
    surface.receive({ type: 'where', app: { name: 'Notepad', icon: ICON } });
    surface.receive({ type: 'face', mood: 'away' });
    expect(shown()).toBe(false);
    expect($('.nin')!.dataset.mood).toBe('away');
    surface.receive({ type: 'face', mood: 'closed' });
    expect(shown()).toBe(false);
    surface.receive({ type: 'face', mood: 'idle' });
    expect(icon()?.getAttribute('src')).toBe(ICON);
  });

  test('a page that comes up later is told where you are with everything else', () => {
    surface.receive({ type: 'state', line: null, count: 0, where: { name: 'Notepad', icon: ICON } });
    expect(icon()?.getAttribute('src')).toBe(ICON);
    surface.receive({ type: 'state', line: null, count: 0 });
    expect(shown()).toBe(false);
  });
});

describe('pass 12 on the page: the movements of the prototype, played for real', () => {
  // These need motion: the tests above run with it reduced.
  let moving: NotchSurface, stage: HTMLElement, told: NotchFromPage[];
  const m = <T extends Element = HTMLElement>(selector: string): T | null => stage.querySelector<T>(selector);
  const bumps = (): number => stage.querySelectorAll('.line .bumps path').length;
  beforeEach(() => {
    stage = document.createElement('div');
    document.body.append(stage);
    told = [];
    moving = createNotchSurface(stage, (message) => told.push(message), { reducedMotion: false });
    moving.receive({ type: 'state', line: null, count: 0 });
  });
  afterEach(() => { moving.destroy(); stage.remove(); });

  test('a yes is seen: the eyes nod as it is given', () => {
    moving.receive({ type: 'show', line: { id: 'o', kind: 'offer', say: ['Reply?'], yes: 'send' } });
    expect(m('.eyes')!.classList.contains('nodg')).toBe(false);
    stage.querySelector<HTMLElement>('.hint .key')!.click();
    expect(told).toEqual([{ type: 'answer', id: 'o', act: 'yes' }]);
    expect(m('.eyes')!.classList.contains('nodg')).toBe(true);
  });

  test('a pick nods too, and a no shakes', () => {
    moving.receive({ type: 'show', line: { id: 'c', kind: 'offer', say: ['Which?'], options: ['Friday', 'Monday'] } });
    stage.querySelector<HTMLElement>('.opts .btn')!.click();
    expect(m('.eyes')!.classList.contains('nodg')).toBe(true);
    moving.receive({ type: 'show', line: { id: 'o', kind: 'offer', say: ['Reply?'], yes: 'send' } });
    moving.key('esc');
    expect(m('.eyes')!.classList.contains('shake')).toBe(true);
  });

  test('a wink is one of the eyes\' own movements', () => {
    moving.receive({ type: 'act', gesture: 'wink' });
    expect(m('.eyes')!.classList.contains('wink')).toBe(true);
  });

  // Asked for on 18 November 2026: one eye closes and opens, and then the other, as a gecko blinks.
  test('the gecko\'s blink is a movement of its own, and lasts long enough for both eyes', async () => {
    moving.receive({ type: 'act', gesture: 'gecko' });
    expect(m('.eyes')!.classList.contains('gecko')).toBe(true);
    // A blink is over in a fraction of a second. This one is still going: the second eye has not had its turn.
    await wait(700);
    expect(m('.eyes')!.classList.contains('gecko')).toBe(true);
    await wait(NOTCH_GECKO_MS - 700 + 120);
    expect(m('.eyes')!.classList.contains('gecko')).toBe(false);
  });

  test('something leaves along the edge at once, and a new agent buds off a moment after the notch swells', async () => {
    moving.receive({ type: 'act', edge: 'depart', side: 'right' });
    expect(bumps()).toBe(1);
    moving.receive({ type: 'act', edge: 'bud' });
    expect(bumps()).toBe(1);
    await wait(300);
    expect(bumps()).toBeGreaterThanOrEqual(1);
  });

  test('a line that tells of several things comes in from both sides, and is said when they land', async () => {
    moving.receive({ type: 'show', line: { id: 'p', kind: 'say', say: ['Two things.'], ms: 4000, arrive: 'pair' } });
    // Not said yet: it is still on its way along the edge.
    expect(m('.nin')!.dataset.body).toBe('rest');
    expect(bumps()).toBe(2);
    await wait(1100);
    expect(m('.nin')!.dataset.body).toBe('line');
    expect(bumps()).toBe(0);
  });

  test('a way of arriving the page does not know is no reason to hold the line back', () => {
    moving.receive({ type: 'show', line: { id: 'x', kind: 'say', say: ['Here.'], ms: 4000, arrive: 'teleport' as 'left' } });
    expect(m('.nin')!.dataset.body).toBe('line');
    expect(bumps()).toBe(0);
  });

  test('it ducks out of the way only at rest, and what it shows is unseen while it is down', () => {
    moving.receive({ type: 'act', body: 'duck' });
    expect(m('.nin')!.style.opacity).toBe('0');
  });

  test('with a line up it does not duck: the line stays readable', () => {
    moving.receive({ type: 'show', line: { id: 'o', kind: 'offer', say: ['Reply?'], yes: 'send' } });
    moving.receive({ type: 'act', body: 'duck' });
    expect(m('.nin')!.style.opacity).toBe('');
  });

  test('a nod, two hops, a kick and a reach with nonsense for numbers do not break it', () => {
    for (const act of [{ body: 'nod' }, { body: 'hops' }, { kick: 9e9 }, { kick: Number.NaN }, { lip: 'reach', aim: -4 }, { lip: 'reach', aim: 'left' }, { edge: 'carry', side: 'right' }, { edge: 'fly' }, { body: 'dance' }]) {
      moving.receive({ type: 'act', ...act } as never);
    }
    moving.receive({ type: 'show', line: { id: 's', kind: 'say', say: ['Still here.'], ms: 4000 } });
    expect(m('.nin')!.dataset.body).toBe('line');
  });
});

describe('pass 12 on the page: day one, the map and a row that is gone', () => {
  test('a row that is gone is drawn struck through', () => {
    show({ id: 'm', kind: 'sheet', say: ['What I remember'], blocks: [
      { kind: 'row', id: 'f1', lead: 'Sam', say: ['prefers calls'], small: 'forgotten', gone: true },
      { kind: 'row', id: 'f2', lead: 'Anna', say: ['works at Northwind'], buttons: [{ id: 'forget', label: 'Forget', quiet: true }] },
    ] });
    const rows = all('.sheet .row');
    expect(rows[0]!.classList.contains('gone')).toBe(true);
    expect(rows[1]!.classList.contains('gone')).toBe(false);
  });

  test('where in a sequence a line is, is said in small words after its keys', () => {
    show({ id: 'd', kind: 'offer', say: ['Say hello?'], yes: 'hello', step: 'step 1/11' });
    expect($('.hint .count')?.textContent).toBe('step 1/11');
    show({ id: 'e', kind: 'offer', say: ['Reply?'], yes: 'send' });
    expect($('.hint .count')).toBeNull();
  });

  test('a line that shows only Esc tells a yes to the brain and stays, for the brain to answer it there', async () => {
    show({ id: 'd', kind: 'offer', say: ['For not now, press esc. Try it.'], keys: 'esc' });
    expect(all('.hint .key').map((key) => key.textContent)).toEqual(['escnot now']);
    // A yes cannot land in the first moment of any line.
    await wait(400);
    surface.key('yes');
    surface.key('yes');
    // Told each time, and never settled: Esc still answers it.
    expect(sent).toEqual([{ type: 'answer', id: 'd', act: 'yes' }, { type: 'answer', id: 'd', act: 'yes' }]);
    expect($('.nin')?.classList.contains('answered')).toBe(false);
    surface.key('esc');
    expect(sent.at(-1)).toEqual({ type: 'answer', id: 'd', act: 'no' });
  });

  test('a line that is answered by talking shows the pair that is held, with its word', () => {
    show({ id: 'd', kind: 'offer', say: ['Now tell me what you do. Out loud.'], yes: 'hold and talk', keys: 'talk' });
    const keys = all('.hint .key');
    expect(keys[0]!.querySelector('.duo.talk')).not.toBeNull();
    expect(keys[0]!.textContent).toContain('hold and talk');
  });

  const MAP = {
    kind: 'map' as const,
    nodes: [
      { id: 'you', label: 'You', x: 222, y: 104, kind: 'me' as const },
      { id: 'gmail', label: 'Gmail', x: 222, y: 28, kind: 'tool' as const },
      { id: 'sam', label: 'Sam', x: 128, y: 58, kind: 'person' as const },
    ],
    links: [['you', 'gmail'], ['gmail', 'sam'], ['you', 'nobody']] as [string, string][],
    sources: [{ name: 'Gmail', found: '12 people', state: 'done' as const }, { name: 'Calendar', state: 'on' as const }, { name: 'Memory' }],
  };

  test('the map draws a dot and a name for each thing, a line between two that are both there, and a chip for each place read', () => {
    show({ id: 'scan', kind: 'sheet', say: ['Looking around'], blocks: [MAP] });
    expect(all('.map g g text').map((t) => t.textContent)).toEqual(['You', 'Gmail', 'Sam']);
    expect(root.querySelectorAll('.map circle').length).toBe(3);
    // The link to something that is not on the map is not drawn.
    expect(root.querySelectorAll('.map line').length).toBe(2);
    expect(root.querySelector('.map .me circle')?.getAttribute('r')).toBe('5');
    expect(all('.srcs .src').map((chip) => `${chip.className}|${chip.textContent}`)).toEqual(['src on done|Gmail12 people', 'src on|Calendar', 'src|Memory']);
  });

  test('sent again with more in it, what was already drawn stays still and only the new comes in', () => {
    // Motion on: with it reduced nothing comes in at all.
    const stage = document.createElement('div');
    document.body.append(stage);
    const moving = createNotchSurface(stage, () => {}, { reducedMotion: false });
    moving.receive({ type: 'state', line: null, count: 0 });
    moving.receive({ type: 'show', line: { id: 'scan', kind: 'sheet', say: ['Looking around'], blocks: [{ ...MAP, nodes: MAP.nodes.slice(0, 2), links: [['you', 'gmail']] }] } });
    // The sheet that is up, not the one that is fading away under it.
    const was = (): string[] => [...stage.querySelectorAll('.sheet:not(.ghostly) .map g g')].map((g) => g.getAttribute('class') ?? '');
    expect(was()).toEqual(['me', 'tool']);
    moving.receive({ type: 'update', id: 'scan', blocks: [MAP] });
    expect(was()).toEqual(['me was', 'tool was', 'person']);
    expect([...stage.querySelectorAll('.sheet:not(.ghostly) .map line')].map((line) => line.getAttribute('class'))).toEqual(['was', null]);
    // Another line: its map starts from nothing.
    moving.receive({ type: 'show', line: { id: 'scan2', kind: 'sheet', say: ['Looking around'], blocks: [MAP] } });
    expect(was()).toEqual(['me', 'tool', 'person']);
    moving.destroy();
    stage.remove();
  });

  test('a map made of nonsense draws what it can and breaks nothing', () => {
    show({ id: 'bad', kind: 'sheet', say: ['Looking around'], blocks: [{
      kind: 'map', nodes: [{ id: 'a', label: '<img src=x onerror=alert(1)>', x: 9e9, y: Number.NaN, kind: 'spaceship' }, null, { id: 7 }], links: 'none', sources: [null, { name: 4 }],
    } as never] });
    expect(all('.map g g text').map((t) => t.textContent)).toEqual(['<img src=x onerror=alert(1)>']);
    expect(root.querySelector('.map img')).toBeNull();
    // A kind it does not know is a thing. (Motion is reduced in these tests: nothing comes in, so it "was" there.)
    expect(root.querySelector('.map g g')?.getAttribute('class')).toBe('thing was');
    expect(body()).toBe('sheet');
  });
});

// The hardening audit, 17 November 2026 (pass 13).
describe('what the hardening audit found on the page', () => {
  test('a click on the eyes is not a hand on the offer: the brain is not told one is there', async () => {
    show({ id: 'o', kind: 'offer', say: ['Reply to ', { em: 'Sam' }, '?'], yes: 'send', fold: 250 });
    // A click on the eyes leaves that button the focused element, in a window that is never the active one.
    $<HTMLButtonElement>('.eyes')!.focus();
    expect(document.activeElement).toBe($('.eyes'));
    await wait(60);
    // It used to count as a hand for good, and the offer never folded again.
    expect(surface.wire.filter((message) => message.type === 'hand')).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('a line that cannot be drawn leaves the one before it on the notch, answerable as itself', async () => {
    show({ id: 'a', kind: 'offer', say: ['Send the note to ', { em: 'Marco' }, '?'], yes: 'send' });
    const errors = console.error;
    console.error = () => {};
    try {
      // A sheet with a block that is not one.
      surface.receive({ type: 'show', line: { id: 'b', kind: 'sheet', say: ['Approve?'], yes: 'approve', blocks: [{ kind: 'paper' } as never] } });
    } finally { console.error = errors; }
    expect(said()).toContain('Send the note to Marco?');
    await wait(400);
    surface.key('yes');
    // The yes is for the line that is on the screen, not for the one that never was.
    expect(sent).toEqual([{ type: 'answer', id: 'a', act: 'yes' }]);
  });

  test('a line that came by itself does not take Esc from the app in front while it would not act on it', async () => {
    const wants: boolean[] = [];
    surface.onWantEsc((want) => wants.push(want));
    show({ id: 'u', kind: 'offer', say: ['A reply for ', { em: 'Sam' }, ' is ready.'], yes: 'show', unasked: true });
    expect(wants.at(-1) ?? false).toBe(false);
    await wait(800);
    expect(wants.at(-1)).toBe(true);
    // One that was asked for takes it at once, as before.
    const asked: boolean[] = [];
    surface.receive({ type: 'rest' });
    surface.onWantEsc((want) => asked.push(want));
    show({ id: 'v', kind: 'offer', say: ['Send it?'], yes: 'send' });
    expect(asked.at(-1)).toBe(true);
  });

  test('a double click on a sheet button is one press', () => {
    show({ id: 's', kind: 'sheet', say: ['Settings'], blocks: [{ kind: 'buttons', buttons: [{ id: 'moves', label: 'How I move' }, { id: 'cando', label: 'What I can do' }] }] });
    const [moves, cando] = all('.sheet button');
    moves!.click();
    moves!.click();
    expect(sent).toEqual([{ type: 'answer', id: 's', act: 'button', button: 'moves' }]);
    // Another button is another press.
    cando!.click();
    expect(sent.length).toBe(2);
  });

  test('an update for a line that is still coming in along the edge is not lost: it lands as it now is', async () => {
    const moving = createNotchSurface(root, (message) => sent.push(message), {});
    moving.receive({ type: 'state', line: null, count: 0 });
    moving.receive({ type: 'show', line: { id: 'w', kind: 'work', say: ['Working'], steps: 4, done: 0, arrive: 'left', unasked: true } });
    moving.receive({ type: 'update', id: 'w', done: 3, say: ['Almost there'] });
    await wait(1500);
    expect(root.textContent).toContain('Almost there');
    expect(root.textContent).toContain('3/4');
    moving.destroy();
  });

  test('a look that is asked for at rest is worn for a while, and the face the brain keeps comes back by itself', async () => {
    surface.receive({ type: 'face', mood: 'away' });
    expect($('.nin')?.dataset.mood).toBe('away');
    surface.receive({ type: 'act', mood: 'happy' });
    expect($('.nin')?.dataset.mood).toBe('happy');
    await wait(4200);
    expect($('.nin')?.dataset.mood).toBe('away');
  }, 8000);
});

describe('typing into a word of a line (the hardening audit)', () => {
  const draft = (): NotchLine => ({
    id: 'd', kind: 'sheet', say: ['Reply to ', { em: 'Sam' }], yes: 'send', stay: true,
    blocks: [{ kind: 'row', lead: 'Tell me', say: [{ word: { name: 'told', value: 'tell me', options: ['say no', 'say yes', 'ask for more time'], label: 'Tell Pillow', free: true, long: true } }] }],
  });

  test('a yes with something typed and not yet taken takes it, as Enter would: it does not send the reply as it stood', async () => {
    show(draft());
    await wait(400);
    $<HTMLElement>('.sheet .live')!.click();
    const field = $<HTMLInputElement>('.pick input')!;
    field.value = 'decline, we are full until January';
    surface.key('yes');
    // What was typed is what is told, and no yes was given for the old reply.
    expect(sent).toEqual([{ type: 'answer', id: 'd', act: 'word', word: 'told', value: 'decline, we are full until January' }]);
    // With nothing typed a yes is a yes.
    surface.key('yes');
    expect(sent.at(-1)).toEqual({ type: 'answer', id: 'd', act: 'yes' });
  });

  test('the ready-made sentences of such a word are one click away', async () => {
    show(draft());
    await wait(400);
    $<HTMLElement>('.sheet .live')!.click();
    const chips = all('.pick button').map((button) => button.textContent);
    expect(chips).toEqual(['say no', 'say yes', 'ask for more time']);
    all('.pick button')[2]!.click();
    expect(sent).toEqual([{ type: 'answer', id: 'd', act: 'word', word: 'told', value: 'ask for more time' }]);
  });

  test('the same key pairs pushed again draw nothing anew: an open field keeps what is typed in it', async () => {
    surface.setPairs({ talk: ['ctrl', 'meta'], yes: ['meta', 'alt'] });
    show(draft());
    await wait(400);
    $<HTMLElement>('.sheet .live')!.click();
    const field = $<HTMLInputElement>('.pick input')!;
    field.value = 'half a sent';
    surface.setPairs({ talk: ['ctrl', 'meta'], yes: ['meta', 'alt'] });
    expect($<HTMLInputElement>('.pick input')).toBe(field);
    expect(field.value).toBe('half a sent');
    // Other pairs do change the hints.
    surface.setPairs({ talk: ['ctrl', 'alt'], yes: ['meta', 'alt'] });
    expect($<HTMLInputElement>('.pick input')).not.toBe(field);
  });

  test('blocks that arrive while a field is being typed in wait until the typing is over', async () => {
    show(draft());
    await wait(400);
    $<HTMLElement>('.sheet .live')!.click();
    const field = $<HTMLInputElement>('.pick input')!;
    field.focus();
    field.value = 'make it shor';
    surface.receive({ type: 'update', id: 'd', blocks: [{ kind: 'note', say: ['A new draft.'] }] });
    // The field is still there, with what was typed.
    expect($<HTMLInputElement>('.pick input')).toBe(field);
    expect(root.textContent).not.toContain('A new draft.');
    // The typing ends (Esc closes the field): the sheet is drawn again with what came.
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(900);
    expect(root.textContent).toContain('A new draft.');
  });

  test('moving from one field of the notch straight into another does not give the keyboard back in between', async () => {
    show({ id: 'h', kind: 'ask', say: ['Ask'], placeholder: 'Type here', yes: 'ask', focus: true,
      blocks: [{ kind: 'row', lead: 'Quiet', say: [{ word: { name: 'q', value: '22:00', options: ['22:00', '23:00'], free: true } }] }] });
    await wait(50);
    const askField = $<HTMLInputElement>('.say input, input.ask, .nin input')!;
    $<HTMLElement>('.sheet .live')!.click();
    const wordField = $<HTMLInputElement>('.pick input')!;
    wordField.focus();
    focus.length = 0;
    // From the word's field into the ask field.
    wordField.dispatchEvent(new FocusEvent('blur', { relatedTarget: askField }));
    expect(focus).toEqual([]);
    // Out of the notch altogether: given back.
    wordField.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }));
    expect(focus).toEqual([false]);
  });
});

// The prototype's beads on an agent's card: how each of its last runs ended.
test('a row can carry a few dots for how the last runs ended, the oldest first, with words for a reader that cannot see them', () => {
  show({ id: 's', kind: 'sheet', say: ['Tony'], blocks: [
    { kind: 'row', say: ['Last runs'], beads: ['ok', 'ask', 'bad', 'ok'] },
    { kind: 'row', say: ['No runs yet'] },
    { kind: 'row', say: ['Next run'], small: 'Every Monday at 9:00' },
  ] });
  const dots = all('.sheet .row .beads i');
  expect(dots.map((dot) => dot.className)).toEqual(['on', 'ask', 'bad', 'on']);
  expect($('.sheet .row .beads')?.getAttribute('aria-label')).toBe('Last 4 runs: went well, stopped to ask, failed, went well');
  // Only the row that was given dots has them.
  expect(all('.sheet .row').map((row) => row.querySelectorAll('.beads').length)).toEqual([1, 0, 0]);
  // What is no way a run ends is no dot, and there are never more than a few.
  show({ id: 's2', kind: 'sheet', say: ['Tony'], blocks: [{ kind: 'row', say: ['Last runs'], beads: ['ok', 'burning' as never, ...Array<'bad'>(20).fill('bad')] }] });
  expect(all('.sheet .row .beads i').length).toBe(8);
  expect(all('.sheet .row .beads i').every((dot) => dot.className === 'bad')).toBe(true);
});


// The second run on a real Mac, 19 November 2026: the notch came up at the top centre, where a MacBook
// has its camera housing, and most of it lay behind that.
describe('a display with a camera housing', () => {
  const lowest = (): number => Math.max(...surface.outlines(0).flat().map(([, y]) => y));
  const highest = (): number => Math.min(...surface.outlines(0).flat().map(([, y]) => y));

  test('the notch starts below the housing, and its ink still starts at the screen\'s top edge', () => {
    const before = lowest();
    surface.setHousing(185, 32);
    expect(root.style.getPropertyValue('--cam-h')).toBe('32px');
    expect(root.classList.contains('housed')).toBe(true);
    expect(document.documentElement.classList.contains('notch-housed')).toBe(true);
    // The whole of it is the housing's height further down, and nothing of it starts below the top edge.
    expect(lowest() - before).toBeCloseTo(32, 5);
    expect(highest()).toBeLessThanOrEqual(0);
  });

  test('a click on the ink beside the housing is a click on the notch, and one below it is not', () => {
    surface.setHousing(185, 32);
    show({ id: 'h1', kind: 'sheet', say: ['Settings'], blocks: [{ kind: 'note', say: ['A note.'] }] });
    const body = surface.outlines(0)[0]!;
    const xs = body.map(([x]) => x), left = Math.min(...xs), right = Math.max(...xs);
    // Up in the strip the housing leaves free, inside the notch's own width: part of the notch.
    const hit = (x: number, y: number): boolean => { let on = false; for (let i = 0, j = body.length - 1; i < body.length; j = i++) { const a = body[i]!, b = body[j]!; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) on = !on; } return on; };
    expect(hit((left + right) / 2, 10)).toBe(true);
    expect(hit((left + right) / 2, lowest() + 20)).toBe(false);
  });

  test('when the housing goes (another display is the main one), everything is as it was', () => {
    const before = lowest();
    surface.setHousing(185, 32);
    surface.setHousing(0, 0);
    expect(root.style.getPropertyValue('--cam-h')).toBe('0px');
    expect(root.classList.contains('housed')).toBe(false);
    expect(document.documentElement.classList.contains('notch-housed')).toBe(false);
    expect(lowest()).toBeCloseTo(before, 5);
  });

  test('a size no housing has is no housing: the notch is not drawn round a wrong reading', () => {
    const before = lowest();
    for (const [w, h] of [['185', 32], [185, null], [Number.NaN, 32], [185, 0], [-185, 32], [5000, 32], [185, 500], [undefined, undefined]] as [unknown, unknown][]) {
      surface.setHousing(w, h);
      expect(root.classList.contains('housed')).toBe(false);
      expect(lowest()).toBeCloseTo(before, 5);
    }
  });

  test('a page that is gone does not leave the mark on the document', () => {
    surface.setHousing(185, 32);
    surface.destroy();
    expect(document.documentElement.classList.contains('notch-housed')).toBe(false);
  });
});
