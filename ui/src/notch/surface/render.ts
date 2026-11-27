/**
 * The drawing of the notch: what the model (./core.ts) says is up, put on the
 * screen with the prototype's shape, eyes, edge and sentence. It decides
 * nothing. What the person does with what it drew (a click on a hint, a
 * choice, a button of a sheet, Enter in a field, a word changed) is handed to
 * `hooks.input` as it is, and ./core.ts says what that comes to.
 *
 * Each kind of line maps to one of the prototype's `tell`, `propose`, `sheet`,
 * `work` and `sending`; `show` below is the prototype's `show`.
 */
import { NOTCH_NAME } from '../../../../src/notch/name.ts';
import { NOTCH_APPS, NOTCH_MOODS } from '../../../../src/notch/protocol.ts';
import type { NotchApp, NotchBlock, NotchEdit, NotchEffect, NotchKept, NotchLine, NotchMood, NotchMouth, NotchPart, NotchWord } from '../../../../src/notch/protocol.ts';
import { renderBlocks } from './blocks.ts';
import type { NotchLineTiming, NotchPageInput, NotchPageModel } from './core.ts';
import { SKELETON, btn, el, need, type Frames, type NotchPageClock, type Timers } from './dom.ts';
import { createEdge } from './edge.ts';
import { createEyes } from './eyes.ts';
import { duo, mkHint, type Hint } from './hints.ts';
import { ICON } from './icons.ts';
import { createSentence } from './sentence.ts';
import { WK, createShape } from './shape.ts';
import { createSounds } from './sounds.ts';

type Body = 'rest' | 'line' | 'choices' | 'sheet' | 'ask' | 'work';

/** What `show` draws: the prototype's argument, unchanged. */
interface View {
  body: Body;
  say?: readonly NotchPart[] | Node;
  hint?: Hint | Hint[] | null;
  opts?: { label: string; pick: () => void }[] | null;
  sheet?: Node | null;
  mood?: NotchMood;
  mark?: 'check' | 'fail' | '';
  who?: string;
  src?: NotchApp | '';
  /** The sheet's rows come in one after another. */
  stag?: boolean;
  /**
   * Yes is the pair of keys, as on a line, though this is a sheet: it asks for
   * a decision and has no text field, so the notch does not have the keyboard
   * and Enter would go to the app in front.
   */
  pairYes?: boolean;
}

const DEFAULT_MOOD: Record<Exclude<Body, 'rest'>, NotchMood> = { line: 'look', choices: 'look', sheet: 'read', ask: 'listen', work: 'work' };

/** How long a look that was asked for at rest is worn before the notch goes back to the face it rests with. */
export const NOTCH_PASSING_MOOD_MS = 4000;

/** What the drawing tells and asks of whoever joins it to the model. */
export interface NotchRenderHooks {
  model(): NotchPageModel;
  /** A drawing starts (what was scheduled before is void), and is finished. */
  painting(): void;
  painted(): void;
  /** A result, or a fuse that was lit, runs out `left` ms from now. */
  timed(id: string, left: number): void;
  /** The fuse of the send drawn as `drawn` is up: Esc takes it back from now on. */
  fuseUp(drawn: number): void;
  /** What the person did with what was drawn. */
  input(input: NotchPageInput): void;
  /** Whether Esc is wanted, whether a question is up, whether a hand is on it: to be worked out again. */
  sync(): void;
  /** Ask the desktop app for the keyboard, or give it back. */
  focus(take: boolean): void;
}

export interface NotchRenderOptions {
  reduce: boolean;
  clock: NotchPageClock;
  timers: Timers;
  frames: Frames;
  width(): number;
  changed(): void;
  /** The display's camera housing, when it has one. */
  housing(): { w: number; h: number } | null;
  /** Whether the page is still there. */
  alive(): boolean;
  hooks: NotchRenderHooks;
}

/** The drawing, as ./index.ts joins it to the model. */
export type NotchRender = ReturnType<typeof createNotchRender>;

export function createNotchRender(root: HTMLElement, options: NotchRenderOptions) {
  const { reduce, clock, timers, frames, hooks } = options;
  root.classList.add('jarvis-notch');
  root.classList.toggle('notch-still', reduce);
  root.innerHTML = SKELETON;

  const wrap = need<HTMLElement>(root, '.wrap'), blob = need<SVGSVGElement>(root, '.blob'), notch = need<HTMLElement>(root, '.notch');
  const nin = need<HTMLElement>(root, '.nin'), lead = need<HTMLElement>(root, '.lead'), eyesEl = need<HTMLElement>(root, '.eyes');
  const iconEl = need<HTMLElement>(root, '.appicon'), badgeEl = need<HTMLElement>(root, '.badge');
  const sayEl = need<HTMLElement>(root, '.say'), hintEl = need<HTMLElement>(root, '.hint');
  // Hebrew and Arabic read from the right. Each word of a line is a box of its own, and boxes are laid out
  // left to right unless the line is told to find its own direction: the words stood in the wrong order.
  sayEl.dir = 'auto';
  const pickEl = need<HTMLElement>(root, '.pick'), optsEl = need<HTMLElement>(root, '.opts'), sheetEl = need<HTMLElement>(root, '.sheet');
  const measure = need<HTMLElement>(root, '.measure'), lineSvg = need<SVGSVGElement>(root, '.line');

  const sounds = createSounds();
  const m = (): NotchPageModel => hooks.model();
  const shape = createShape({ wrap, notch, nin, measure, blob, frames, reduce, width: options.width, changed: options.changed, housing: options.housing });
  const eyes = createEyes({ nin, eyes: eyesEl, shape, timers, reduce, busy: () => m().cur !== null, rest: () => m().face });
  const edge = createEdge({ line: lineSvg, blob, nin, frames, timers, shape, eyes, reduce, width: options.width, changed: options.changed });

  let shownCount = 0;
  /** A look given at rest goes back to the resting face after this long. */
  let moodBack = 0;

  const sentence = createSentence({
    nin, pick: pickEl, opts: optsEl, sheet: sheetEl,
    refit: () => { shape.fit(false, true); more(); hooks.sync(); },
    changed: (word: NotchWord, value: string, button: HTMLElement) => {
      // The eyes go to the word that changed.
      const r = button.getBoundingClientRect();
      eyes.gaze(r.left + r.width / 2, r.top + 8);
      hooks.input({ kind: 'word', name: word.name, value });
    },
    typed: (word: NotchWord, text: string) => { hooks.input({ kind: 'word', name: word.name, value: text, typed: true }); },
    refused: () => { eyes.gesture('shake'); sounds.sfx('no'); },
    focus: (take) => hooks.focus(take),
    after: (ms, fn) => timers.after(ms, fn),
    cancel: (id) => timers.cancel(id),
  });

  /** The old sentence fades where it stood, so the new one never jumps in over it. */
  function ghost(): void {
    if (reduce || !sayEl.firstChild || sayEl.querySelector('input, .voice')) return;
    const g = sayEl.cloneNode(true) as HTMLElement;
    g.className = 'say ghost';
    g.removeAttribute('aria-live');
    g.setAttribute('aria-hidden', 'true');
    const r = sayEl.getBoundingClientRect(), cs = getComputedStyle(sayEl);
    g.style.left = sayEl.offsetLeft + 'px';
    g.style.top = sayEl.offsetTop + 'px';
    g.style.width = Math.ceil(r.width) + 1 + 'px';
    g.style.fontWeight = cs.fontWeight;
    g.style.color = cs.color;
    if (r.height < 30) g.style.whiteSpace = 'nowrap';
    sayEl.parentNode?.append(g);
    timers.after(230, () => g.remove());
  }

  function fadeOut(elm: HTMLElement): void {
    if (reduce || !elm.firstChild || elm.querySelector('input')) return;
    const g = elm.cloneNode(true) as HTMLElement;
    g.classList.add('ghostly');
    g.classList.remove('stag', 'more');
    g.setAttribute('aria-hidden', 'true');
    g.style.top = elm.offsetTop + 'px';
    g.style.left = elm.offsetLeft + 'px';
    g.style.width = elm.offsetWidth + 'px';
    elm.parentNode?.append(g);
    timers.after(170, () => g.remove());
  }

  /** Whether the end of the sheet is on screen now. */
  const sheetAtEnd = (): boolean => sheetEl.scrollTop + sheetEl.clientHeight >= sheetEl.scrollHeight - 6;
  /** Whether the end of the sheet that is up has been on screen at some moment, and since when. */
  let sheetSeen = false;
  let sheetSeenAt = 0;
  const sawSheetEnd = (): void => { if (!sheetSeen) { sheetSeen = true; sheetSeenAt = clock.now(); } };

  /**
   * Whether this page says of itself that it is not shown. Not every window that is hidden tells its
   * page (on Windows a hidden notch still reads "visible"), so this can only ever take a yes away.
   */
  const outOfSight = (): boolean => { try { return document.visibilityState === 'hidden'; } catch { return false; } };
  /** The letter under a fuse that was out of sight at some moment while it burnt: this page does not vouch for it. */
  let unseenLetter = '';

  /** A sheet with more below fades at its lower edge. */
  function more(): void {
    requestAnimationFrame(() => {
      if (!options.alive()) return;
      const end = sheetAtEnd();
      if (end) sawSheetEnd();
      sheetEl.classList.toggle('more', !end);
    });
  }

  function paintCount(body: Body): void {
    const count = m().count;
    const n = body === 'rest' ? count : 0;
    nin.dataset.wait = n ? 'count' : '';
    badgeEl.textContent = n ? String(n) : '';
    badgeEl.setAttribute('aria-label', n ? `${n} waiting for you` : '');
    if (body !== 'rest') return;
    // Something more waits than a moment ago: a ripple runs along the lip.
    if (n > shownCount) shape.morphPlay('ripple');
    shownCount = n;
  }

  function show(v: View, instant = false): void {
    hooks.painting();
    wrap.classList.remove('fusing', 'talk');
    if (shape.N.mode === 'talk') { shape.N.tgt = null; shape.morphStop(); }
    sentence.reset();
    iconEl.classList.remove('from');
    nin.classList.remove('answered');
    nin.querySelectorAll('.ghost, .ghostly').forEach((g) => g.remove());
    if (!instant) {
      ghost();
      if (nin.dataset.body !== v.body || v.stag) { fadeOut(sheetEl); fadeOut(optsEl); }
      fadeOut(hintEl);
    }
    nin.dataset.body = v.body;
    wrap.dataset.body = v.body;
    nin.dataset.mark = v.mark ?? '';
    if (v.mark === 'check') sounds.sfx('done'); else if (v.mark === 'fail') sounds.sfx('fail');
    paintCount(v.body);

    const say = v.say ?? [];
    sayEl.replaceChildren(say instanceof Node ? say : sentence.nodes(say));
    const hints = v.hint ? (Array.isArray(v.hint) ? v.hint : [v.hint]) : [];
    // For a screen reader: what yes means, or what the choices are.
    if (!(say instanceof Node)) {
      const yes = hints.find((h) => !('beads' in h) && h.act && (h.cap ?? 'enter') === 'enter');
      const spoken = v.opts?.length ? 'Choices: ' + v.opts.map((o, i) => `${i + 1}, ${o.label}`).join('; ') + '.'
        : yes && !('beads' in yes) ? `Yes means ${yes.act}.` : '';
      if (spoken) sayEl.append(el('span', 'sr', ' ' + spoken));
    }
    // A click on the line's own yes or Esc is said as it is; whether it was too soon to be meant for this line
    // is the model's to say (./core.ts, `notchTooSoon`).
    const ctx = { body: v.pairYes ? 'line' : v.body, onYes: () => { hooks.input({ kind: 'yes' }); }, onEsc: () => { hooks.input({ kind: 'no' }); } };
    hintEl.replaceChildren(...hints.map((h) => mkHint(h, ctx)));
    optsEl.replaceChildren(...(v.opts ?? []).map((o, i) => {
      const b = btn('btn', null, o.pick);
      b.append(el('span', 'cap', String(i + 1)), o.label);
      return b;
    }));
    sheetEl.replaceChildren(...(v.sheet ? [v.sheet] : []));
    sheetEl.scrollTop = 0;
    sheetEl.classList.toggle('stag', !!v.stag);

    if (v.who) {
      // The first letter whole: a name that begins with an emoji is two halves to charAt, and one was drawn.
      iconEl.replaceChildren(el('span', 'who', [...v.who][0] ?? ''));
      nin.dataset.icon = '1';
    } else if (v.src && (NOTCH_APPS as readonly string[]).includes(v.src)) {
      iconEl.innerHTML = ICON[v.src];
      nin.dataset.icon = '1';
      iconEl.classList.add('from');
    } else if (v.body === 'rest' && restIcon()) {
      nin.dataset.icon = '1';
    } else {
      iconEl.replaceChildren();
      nin.dataset.icon = '0';
    }
    eyesEl.setAttribute('aria-label', v.body === 'rest' ? `Open ${NOTCH_NAME}` : NOTCH_NAME);
    eyes.setMood(v.mood ?? (v.body === 'rest' ? m().face : DEFAULT_MOOD[v.body]));
    // Where the text starts: options and choices line up under it.
    nin.style.setProperty('--tx', lead.offsetLeft + lead.offsetWidth + 10 + 'px');
    shape.fit(instant);
    more();
    hooks.sync();
    hooks.painted();
  }

  /**
   * At rest, the icon of the app in front sits beside the eyes: this is where
   * you are, and I am watching it. Not while the eyes are closed or turned
   * aside: then I am not watching, and say so by showing no app. The icon is
   * the app's own picture, drawn as a picture and never as markup. True when
   * one was drawn.
   */
  function restIcon(): boolean {
    const icon = m().where?.icon;
    const face = m().face;
    if (!icon || face === 'closed' || face === 'away') return false;
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'sync';
    img.draggable = false;
    img.src = icon;
    iconEl.replaceChildren(img);
    return true;
  }

  /** The app in front changed, or the face did, while the notch rests: the icon follows. */
  function repaintRestIcon(): void {
    if (!m().born || m().cur) return;
    const had = nin.dataset.icon === '1';
    iconEl.classList.remove('from');
    if (restIcon()) nin.dataset.icon = '1';
    else { iconEl.replaceChildren(); nin.dataset.icon = '0'; }
    if (had !== (nin.dataset.icon === '1')) {
      nin.style.setProperty('--tx', lead.offsetLeft + lead.offsetWidth + 10 + 'px');
      shape.fit();
    }
  }

  /** Back to the eyes. The model is at rest already. */
  function rest(instant = false): void {
    dropKeyboard();
    show({ body: 'rest' }, instant);
  }

  let pressedAt = -1000, pressed = '';
  /** What of a map is on the screen now, for the line that is up: it is drawn again with more in it, not from nothing. */
  const mapKnown = new Set<string>();
  let mapFor = '';
  const blocksOf = (blocks: readonly NotchBlock[]): HTMLElement => renderBlocks(blocks, {
    known: mapKnown,
    still: reduce,
    plain: (parts) => sentence.plain(parts),
    button: (id, row) => {
      // A double click is one press: the second answer was kept for the next thing that waited on this line.
      const now = clock.now();
      const which = `${id}\n${row ?? ''}`;
      if (which === pressed && now - pressedAt < 400) return;
      pressed = which;
      pressedAt = now;
      hooks.input(row === undefined ? { kind: 'button', button: id } : { kind: 'button', button: id, row });
    },
    go: (row) => { hooks.input({ kind: 'go', row }); },
  });

  const beads = (done: number, steps: number): void => {
    hintEl.querySelectorAll('.beads i').forEach((b, j) => {
      b.classList.toggle('on', j < done);
      b.classList.toggle('now', j === done && done < steps);
    });
    const counter = hintEl.querySelector('.count');
    if (counter) counter.textContent = `${Math.min(done, steps)}/${steps}`;
  };

  /**
   * A text field that is going away gives the keyboard back first. One that
   * is taken out of the page while it has the keyboard would keep it, and
   * whatever was typed next would go nowhere.
   */
  const dropKeyboard = (): void => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== nin && nin.contains(active)) active.blur();
  };

  /** What a line that has stopped listening offers: Esc, so that what was heard is not acted on. */
  const HEARD_HINT: Hint = { cap: 'esc', act: 'not this' };

  /** Where in a sequence a line is, in small words after its keys: "step 3/11". */
  function stepNote(l: NotchLine, instant: boolean): void {
    if (typeof l.step !== 'string' || !l.step) return;
    hintEl.append(el('span', 'count', [...l.step].slice(0, 24).join('')));
    shape.fit(instant, true);
  }

  /** The line's own text field, while an `ask` is up. */
  let askField: HTMLInputElement | null = null;

  /**
   * Draws a line the model has just put up. `timing` is what is left of its
   * time, as the model worked it out; `same` says it is the line that was
   * already up, drawn again. The line is drawn from a copy: what the sentence
   * changes in it (a word stepped through) is the model's to keep, and is told.
   */
  function line(given: NotchLine, timing: NotchLineTiming, instant = false, same = false): void {
    const l = structuredClone(given);
    const { left, total, seen } = timing;
    const drawn = m().drawn;
    dropKeyboard();
    askField = null;
    // Another line: whatever map the last one drew is gone with it.
    if (l.id !== mapFor) { mapFor = l.id; mapKnown.clear(); }
    const common = { mood: l.mood, mark: l.mark, who: l.who, src: l.src } satisfies Partial<View>;

    if (l.kind === 'say') {
      show({ body: 'line', say: l.say, ...common }, instant);
      hooks.timed(l.id, left);
      return;
    }
    if (l.kind === 'offer') {
      // When it folds is not the page's to say: the brain folds it, and is told when a hand is on it.
      if (l.options?.length) {
        show({
          body: 'choices', say: l.say, hint: { cap: 'esc', act: 'not now', touch: true }, ...common,
          opts: l.options.map((label, index) => ({ label, pick: () => { hooks.input({ kind: 'pick', option: label, index }); } })),
        }, instant);
      } else if (l.keys === 'esc') {
        // Only Esc is shown. A yes is told and nothing more: the brain says what it says to that, on this same line.
        show({ body: 'line', say: l.say, hint: { cap: 'esc', act: 'not now' }, ...common }, instant);
      } else if (l.keys === 'talk') {
        show({ body: 'line', say: l.say, hint: [{ cap: 'jk', act: l.yes ?? 'hold and talk', mute: true }, { cap: 'esc', label: 'not now', touch: true }], ...common }, instant);
      } else {
        show({ body: 'line', say: l.say, hint: [{ act: l.yes ?? 'yes' }, { cap: 'esc', label: 'not now', touch: true }], ...common }, instant);
      }
      stepNote(l, instant);
      return;
    }
    if (l.kind === 'sheet') {
      sheetSeen = false;
      show({
        body: 'sheet', say: l.say, sheet: blocksOf(l.blocks), stag: true, ...common,
        // A sheet that asks for a decision says what each key means: the pair is yes, Esc is no.
        ...(l.stay ? { pairYes: true } : {}),
        hint: l.yes ? [{ act: l.yes }, l.stay ? { cap: 'esc', act: l.no ?? 'no' } : { cap: 'esc', label: 'close' }] : { cap: 'esc', act: l.stay && l.no ? l.no : 'close' },
      }, instant);
      stepNote(l, instant);
      return;
    }
    if (l.kind === 'ask') {
      const input = el('input', 'ask');
      input.type = 'text';
      input.placeholder = l.placeholder;
      input.autocomplete = 'off';
      input.spellcheck = false;
      // What the brain reads at most (protocol.ts). More would be dropped unread.
      input.maxLength = 4000;
      input.setAttribute('aria-label', l.placeholder);
      // The window has no keyboard until it asks: a press on the field asks.
      input.addEventListener('pointerdown', () => { hooks.focus(true); });
      input.addEventListener('blur', (e) => {
        const to = e.relatedTarget;
        const stays = to instanceof HTMLElement && nin.contains(to) && (to.tagName === 'INPUT' || to.tagName === 'TEXTAREA');
        if (input.isConnected && !stays) hooks.focus(false);
      });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); hooks.input({ kind: 'submit' }); }
        else if (e.key === 'Escape') { e.preventDefault(); hooks.input({ kind: 'field-esc' }); }
      });
      show({ body: 'ask', say: input, hint: { act: l.yes }, sheet: blocksOf(l.blocks), stag: true, ...common }, instant);
      askField = input;
      // Opened to type in: the keyboard comes with it. Not for a line that is only being drawn again (a page
      // that came back): that would take the keyboard from whatever the person is doing now.
      if (l.focus && !instant) {
        hooks.focus(true);
        input.focus({ preventScroll: true });
      }
      return;
    }
    if (l.kind === 'work') {
      show({
        body: 'work', say: l.say, ...common,
        // How many steps there will be is not always known: then there are no beads to light.
        hint: [...(l.steps > 0 ? [{ beads: l.steps } satisfies Hint] : []), ...(l.canTalk ? [{ cap: 'space', act: 'talk', mute: true } satisfies Hint] : []), { cap: 'esc', act: 'stop' }],
      }, instant);
      if (l.steps > 0) beads(l.done, l.steps);
      return;
    }
    if (l.kind === 'send') {
      // What goes out, on paper under the sentence, for as long as the fuse burns.
      const going = l.blocks?.length ? l.blocks : null;
      const go = (): void => {
        if (m().drawn !== drawn) return;
        hooks.fuseUp(drawn);
        if (going) {
          sheetSeen = false;
          // Drawn anew, not again: whether it was out of sight is counted from here.
          if (!same) unseenLetter = outOfSight() ? l.id : '';
          const paper = blocksOf(going);
          paper.classList.add('going');
          show({ body: 'sheet', say: l.say, sheet: paper, stag: !same, ...(l.held ? {} : { hint: { cap: 'esc', act: 'undo' } }), ...common, mood: l.mood ?? 'write' }, instant);
        } else {
          show({ body: 'line', say: l.say, ...(l.held ? {} : { hint: { cap: 'esc', act: 'undo' } }), ...common, mood: l.mood ?? 'write' }, instant);
        }
        // Held by the brain: decided, so nothing burns and nothing can be taken back.
        if (!seen || m().cur?.undone || l.held) return;
        hooks.timed(l.id, left);
        shape.burn(total, left);
      };
      // A sheet of paper folds away before it goes. Not for a letter that stays up while its fuse burns.
      const paper = going ? null : sheetEl.querySelector('.paper');
      if (paper && !reduce && !instant) {
        paper.classList.add('fold');
        timers.after(190, go);
      } else go();
      return;
    }
    // listen: the words appear as they are made out, and the lip moves with the voice.
    const voice = el('span', 'voice'), wave = el('span', 'wave');
    for (let i = 0; i < 9; i++) wave.append(el('i'));
    voice.append(wave, el('span', 'heard', l.heard));
    show({ body: 'line', say: voice, hint: l.over ? HEARD_HINT : { cap: 'jk', act: 'let go when done', mute: true }, ...common, mood: l.mood ?? 'listen' }, instant);
    if (l.over) return;
    wrap.classList.add('talk');
    shape.morphPlay('talk');
  }

  /** The keys came up on a line that was listening: the lip is still, and Esc is what is left to press. */
  function heardOver(): void {
    wrap.classList.remove('talk');
    if (shape.N.mode === 'talk') { shape.N.tgt = null; shape.morphStop(); }
    const ctx = { body: 'line', onYes: () => {}, onEsc: () => { hooks.input({ kind: 'no' }); } };
    hintEl.replaceChildren(mkHint(HEARD_HINT, ctx));
    shape.fit(false, true);
  }

  /** Draws a sheet's blocks again once nothing is being typed in it, for as long as it is still that line. */
  let laterFor = '';
  function blocksLater(id: string): void {
    if (laterFor === id) return;
    laterFor = id;
    const check = (): void => {
      const l = m().line;
      if (!l || l.id !== id || (l.kind !== 'sheet' && l.kind !== 'ask')) { laterFor = ''; return; }
      if (sentence.typed() && sheetEl.contains(document.activeElement)) { timers.after(400, check); return; }
      laterFor = '';
      update({ id, blocks: l.blocks }, l);
    };
    timers.after(400, check);
  }

  /** Draws a change the brain made to the line that is up. `l` is the line as it was before the change. */
  function update(given: NotchEdit, l: NotchLine): void {
    const edit = structuredClone(given);
    if (edit.say && l.kind !== 'ask' && l.kind !== 'listen') {
      sayEl.replaceChildren(sentence.nodes(edit.say));
      shape.fit(false, true);
    }
    if (edit.done !== undefined && l.kind === 'work') {
      beads(edit.done, l.steps);
      sounds.sfx('tick');
    }
    const over = l.kind === 'listen' && (l.over || edit.over === true);
    if (edit.over !== undefined && l.kind === 'listen' && edit.over && !l.over) heardOver();
    if (edit.heard !== undefined && l.kind === 'listen') {
      const heard = sayEl.querySelector('.heard');
      if (heard) heard.textContent = edit.heard;
      // The lip jumps with each word, while there is a voice to follow.
      if (!reduce && !over) shape.N.tgt = Array.from({ length: WK }, () => Math.random() * 6);
      shape.fit(false, true);
      shape.wake();
    }
    if (edit.blocks && (l.kind === 'sheet' || l.kind === 'ask')) {
      // A field in the sheet is being typed in: drawing the sheet again would take the field away in the
      // middle of a word, and the rest of the sentence would be typed into the app in front. The sheet is
      // drawn again when the typing is over.
      if (sentence.typed() && sheetEl.contains(document.activeElement)) { blocksLater(l.id); return; }
      const top = sheetEl.scrollTop;
      sentence.reset();
      sheetEl.classList.remove('stag');
      sheetEl.replaceChildren(blocksOf(edit.blocks));
      sheetEl.scrollTop = top;
      // What it shows changed: its end has not been seen until it is on screen again.
      sheetSeen = false;
      shape.fit(false, true);
      more();
    }
  }

  /** The mouth that takes a file, as the brain keeps it. `whole`: told as part of everything at once, so a mouth that is open wide is opened first. */
  let mouthNow: NotchMouth = 'shut';
  function mouth(state: NotchMouth, whole = false): void {
    if (whole && state === mouthNow) return;
    if (whole && state === 'over') mouth('open');
    mouthNow = state;
    if (state === 'open') {
      wrap.classList.add('feed');
      shape.setFeeding(true);
      shape.fit();
      shape.morphPlay('mouth');
      eyes.gesture('pop', 360);
    } else if (state === 'over') {
      if (!wrap.classList.contains('feed')) return;
      shape.N.wide = true;
      wrap.classList.add('over');
      shape.kick(150);
      sounds.sfx('tick');
    } else {
      shape.N.wide = false;
      wrap.classList.remove('over', 'feed');
      shape.setFeeding(false);
      if (shape.N.mode === 'mouth') shape.morphStop();
      shape.fit();
      shape.shapeFor(eyes.mood());
    }
  }

  /** What the notch is, apart from its line, as a `patch` changed it: only what is named. The model has it already. */
  function kept(k: NotchKept): void {
    if (k.sound !== undefined) sounds.set(k.sound === true);
    if (k.eye !== undefined) {
      if (k.eye) { nin.dataset.eye = 'eye'; shape.kick(-140); } else delete nin.dataset.eye;
    }
    if (k.face !== undefined && (NOTCH_MOODS as readonly string[]).includes(k.face)) {
      // At rest it shows at once; under a line it waits for the rest.
      if (!m().cur) eyes.setMood(m().face);
      repaintRestIcon();
    }
    if (k.where !== undefined) repaintRestIcon();
    if (k.count !== undefined && !m().cur) { paintCount('rest'); shape.fit(); }
    if (k.mouth) mouth(k.mouth);
    if (k.park !== undefined) edge.park(k.park);
  }

  /** What a `state` says of the notch apart from its line. */
  function whole(eye: boolean, sound: boolean): void {
    shownCount = m().count;
    if (eye) nin.dataset.eye = 'eye'; else delete nin.dataset.eye;
    sounds.set(sound);
  }

  /** Something the notch does once. */
  function effect(e: NotchEffect): void {
    if (e.gulp) {
      // The gulp after a file was dropped in. The mouth itself was shut by the brain's patch.
      shape.kick(330);
      shape.morphPlay('ripple');
      eyes.gesture('nodg');
      sounds.sfx('yes');
    }
    if (e.mood) {
      // A look that is asked for in passing is shown, and is not the face the notch rests with: that one is
      // the brain's to keep (`face`), and at rest the notch goes back to it by itself.
      eyes.setMood(e.mood);
      timers.cancel(moodBack);
      if (!m().cur) { const mine = m().tok; moodBack = timers.after(NOTCH_PASSING_MOOD_MS, () => { if (mine === m().tok && !m().cur) eyes.setMood(m().face); }); }
    }
    if (e.gesture) {
      // The eye that was kept on something opens wide when that thing changes.
      if (e.gesture === 'pop' && nin.dataset.eye) {
        nin.classList.add('eyefire');
        timers.after(650, () => nin.classList.remove('eyefire'));
        shape.kick(210);
      }
      eyes.gesture(e.gesture);
    }
    if (e.lip) {
      const aim = typeof e.aim === 'number' && Number.isFinite(e.aim) ? Math.max(.14, Math.min(.86, e.aim)) : undefined;
      shape.morphPlay(e.lip, aim === undefined ? undefined : { aim });
    }
    if (typeof e.kick === 'number' && Number.isFinite(e.kick)) shape.kick(Math.max(-400, Math.min(400, e.kick)));
    if (e.body === 'nod') shape.kick(250);
    else if (e.body === 'hops') { shape.kick(-200); timers.after(270, () => shape.kick(-180)); }
    else if (e.body === 'duck' && !m().cur) edge.duck();
    if (e.edge === 'depart') edge.depart(e.side !== 'right');
    else if (e.edge === 'bud') edge.bud(e.side !== 'right');
    else if (e.edge === 'carry') edge.carry(e.side === 'right', e.side !== 'right');
    // A birth only when there is nothing on the notch: it starts from the eyes.
    if (e.birth && !m().cur) edge.birth(e.birth, () => {});
  }

  // The pair that is held shows beside the eyes while it is held.
  const held = (): void => {
    lead.querySelector('.cap.held')?.remove();
    lead.append(duo('talk', 'span', 'cap held'));
  };
  held();

  return {
    root, wrap, notch, nin, sheetEl, optsEl, shape, eyes, edge, sounds, sentence,
    line, rest, update, kept, whole, effect, mouth, held, more,
    /** Answered: dimmed, taking nothing more. */
    settle(): void { nin.classList.add('answered'); },
    /** An answer the brain never had: it can be answered again. */
    reopen(): void { nin.classList.remove('answered'); },
    /** A yes is seen: the eyes nod and the bottom edge gulps, as it is given. */
    nod(): void { sounds.sfx('yes'); if (!reduce) { shape.kick(240); eyes.gesture('nodg'); } },
    shake(): void { eyes.gesture('shake'); },
    sfx(name: 'yes' | 'no'): void { sounds.sfx(name); },
    unfuse(): void { wrap.classList.remove('fusing'); },
    depart(left: boolean): void { edge.depart(left); },
    clearHint(): void { hintEl.replaceChildren(); },
    scrollSheet(): void {
      sheetEl.scrollTop = Math.min(sheetEl.scrollHeight, sheetEl.scrollTop + Math.max(80, sheetEl.clientHeight - 64));
      more();
    },
    nudge(): void {
      optsEl.classList.remove('nudge');
      void optsEl.offsetWidth;
      optsEl.classList.add('nudge');
      timers.after(420, () => optsEl.classList.remove('nudge'));
    },
    blurAsk(): void { askField?.blur(); },
    talk(on: boolean): void {
      if (on) {
        // It perks up the moment its keys are held.
        wrap.classList.add('att');
        shape.kick(90);
      } else wrap.classList.remove('att');
      shape.fit(false, true);
    },
    /** Since when the end of the sheet that is up has been on screen (it is looked at now), or null. */
    sheetSeenAt(): number | null {
      if (sheetAtEnd()) sawSheetEnd();
      return sheetSeen ? sheetSeenAt : null;
    },
    /** What is typed in the line's own field, trimmed. */
    askText(): string { return askField?.value.trim() ?? ''; },
    /** The letter under the fuse of `id` was drawn here, its end on the screen, and this page in sight for all of it. */
    letterSeen(id: string): boolean { return (sheetSeen || sheetAtEnd()) && unseenLetter !== id && !outOfSight(); },
    /** The page went out of sight: a letter under its fuse now is not vouched for. */
    visibility(): void {
      const l = m().line;
      if (outOfSight() && l?.kind === 'send' && l.blocks?.length) unseenLetter = l.id;
    },
    /** A piece of work is up. */
    working(): boolean { return nin.dataset.body === 'work'; },
    resting(): boolean { return nin.dataset.body === 'rest'; },
    dropKeyboard,
    destroy(): void { sounds.stop(); },
  };
}
