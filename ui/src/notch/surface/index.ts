/**
 * The notch's surface: it draws what the brain says and reports what the
 * person did. It decides nothing. The brain's messages come in through
 * `receive`; the person's answers go out through `send`.
 *
 * It is the prototype's surface (notch-poc v15) with its scripted world cut
 * away: `show` below is the prototype's `show`, and each kind of line maps to
 * one of its `tell`, `propose`, `sheet`, `work` and `sending`.
 */
import { NOTCH_APPS, NOTCH_MOODS } from '../../../../src/notch/protocol.ts';
import type {
  NotchAnswerAct, NotchApp, NotchBlock, NotchFromPage, NotchLine, NotchMood, NotchPart, NotchToPage, NotchWord,
} from '../../../../src/notch/protocol.ts';
import { renderBlocks } from './blocks.ts';
import { SKELETON, btn, createFrames, createTimers, el, need } from './dom.ts';
import { createEdge } from './edge.ts';
import { createEyes } from './eyes.ts';
import { duo, mkHint, setKeyPairs, type Hint } from './hints.ts';
import { ICON } from './icons.ts';
import { flattenPath, hanging, inside, type Point } from './outline.ts';
import { createSentence } from './sentence.ts';
import { OX, WK, createShape } from './shape.ts';
import { createSounds } from './sounds.ts';

/** How long after a line is drawn a yes from the keyboard is ignored. */
const YES_DEAD_MS = 350;
/** And how long when the line came by itself. An Esc is ignored for as long on such a line. */
const YES_DEAD_UNASKED_MS = 700;

export interface NotchSurfaceOptions {
  /** Ask the desktop app for the keyboard (true) or give it back (false). */
  focus?: (take: boolean) => void;
  /** Force reduced motion on or off; default follows prefers-reduced-motion. */
  reducedMotion?: boolean;
}

export interface NotchSurface {
  /** Everything the brain says goes in here. */
  receive(message: NotchToPage): void;
  /**
   * The silhouette as closed polygons in CSS px of the window: the notch's
   * body, shoulders included, and every bump on the top edge. `inset` moves
   * every polygon that many px inwards. Nothing is on screen: no polygons.
   */
  outlines(inset: number): [number, number][][];
  /** Called every animation frame in which the silhouette changed, and once when it settled. */
  onOutline(listener: (settled: boolean) => void): void;
  /** The pointer, anywhere on the screen, in this page's px; `down` is the main button. */
  pointer(x: number, y: number, down: boolean): void;
  /**
   * What the keys said, from anywhere on the desktop: the talk pair held and
   * let go, the yes pair tapped, Esc, Esc twice. Anything else is ignored.
   */
  key(name: string): void;
  /** Which keys the hints show (they are set per machine). */
  setPairs(pairs: unknown): void;
  /** Told whenever the notch starts or stops having something Esc would close. */
  onWantEsc(listener: (want: boolean) => void): void;
  destroy(): void;
}

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

/** The line on the notch and what the person can do with it. */
interface Current {
  id: string;
  onYes?: () => void;
  onEsc?: () => void;
  /** Answered: nothing more can be done with it until the brain says what next. */
  done?: boolean;
}

const DEFAULT_MOOD: Record<Exclude<Body, 'rest'>, NotchMood> = { line: 'look', choices: 'look', sheet: 'read', ask: 'listen', work: 'work' };

export function createNotchSurface(
  root: HTMLElement,
  send: (message: NotchFromPage) => void,
  options: NotchSurfaceOptions = {},
): NotchSurface {
  const reduce = options.reducedMotion ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const askFocus = options.focus ?? (() => {});
  root.classList.add('jarvis-notch');
  root.classList.toggle('notch-still', reduce);
  root.innerHTML = SKELETON;

  const wrap = need<HTMLElement>(root, '.wrap'), blob = need<SVGSVGElement>(root, '.blob'), notch = need<HTMLElement>(root, '.notch');
  const nin = need<HTMLElement>(root, '.nin'), lead = need<HTMLElement>(root, '.lead'), eyesEl = need<HTMLElement>(root, '.eyes');
  const iconEl = need<HTMLElement>(root, '.appicon'), badgeEl = need<HTMLElement>(root, '.badge');
  const sayEl = need<HTMLElement>(root, '.say'), hintEl = need<HTMLElement>(root, '.hint');
  const pickEl = need<HTMLElement>(root, '.pick'), optsEl = need<HTMLElement>(root, '.opts'), sheetEl = need<HTMLElement>(root, '.sheet');
  const measure = need<HTMLElement>(root, '.measure'), lineSvg = need<SVGSVGElement>(root, '.line');

  const width = (): number => root.clientWidth || window.innerWidth;
  const listeners = new Set<(settled: boolean) => void>();
  let dirty = false, flushing = false, alive = true;
  const settled = (): boolean => !shape.running() && !edge.moving();
  const flush = (): void => {
    if (!dirty || !alive) return;
    dirty = false;
    const now = settled();
    for (const listener of listeners) listener(now);
  };
  // The silhouette changed. Inside a frame the report waits for the frame's
  // end, so everything that moved in it is in one report.
  const changed = (): void => {
    dirty = true;
    if (frames.inFrame() || flushing) return;
    flushing = true;
    queueMicrotask(() => { flushing = false; flush(); });
  };

  const timers = createTimers();
  const frames = createFrames(flush);
  const sounds = createSounds();
  const shape = createShape({ wrap, notch, nin, measure, blob, frames, reduce, width, changed });
  const eyes = createEyes({ nin, eyes: eyesEl, shape, timers, reduce, busy: () => cur !== null });
  const edge = createEdge({ line: lineSvg, blob, nin, frames, timers, shape, eyes, reduce, width, changed });

  let line: NotchLine | null = null;
  let cur: Current | null = null;
  let count = 0, shownCount = 0;
  /** Every `show` makes whatever was scheduled for the line before it void. */
  let tok = 0, shownAt = 0;
  let foldTimer = 0, folding = false;
  let restMood: NotchMood = 'idle';
  let born = false;

  // Esc is taken from the app in front only while it would do something here.
  const escListeners = new Set<(want: boolean) => void>();
  let wantedEsc = false;
  /** Whether the pointer is on the notch itself: on its body or on a sheet. */
  let pointerOnNotch = false;
  const syncEsc = (): void => {
    // A piece of work is on the notch for as long as it takes, which can be
    // minutes, and the person goes back to their own app meanwhile. Esc there
    // is theirs: it is taken for the work (it stops it) only while they point
    // at the notch. The stop hint can also be clicked.
    const up = cur !== null && !cur.done && (nin.dataset.body !== 'work' || pointerOnNotch);
    const want = alive && born && (up || sentence.picking());
    if (want === wantedEsc) return;
    wantedEsc = want;
    for (const listener of escListeners) listener(want);
  };

  const later = (ms: number, fn: () => void): number => { const mine = tok; return timers.after(ms, () => { if (mine === tok) fn(); }); };
  const answer = (act: NotchAnswerAct, more: Partial<Extract<NotchFromPage, { type: 'answer' }>> = {}): void => {
    if (cur) send({ type: 'answer', id: cur.id, act, ...more });
  };
  /** Answered: it stays as it is, dimmed, until the brain says what comes next. */
  const settle = (): void => {
    if (cur) cur.done = true;
    stopFold();
    nin.classList.add('answered');
    syncEsc();
  };

  const sentence = createSentence({
    nin, pick: pickEl, opts: optsEl, sheet: sheetEl,
    refit: () => { shape.fit(false, true); more(); syncEsc(); },
    changed: (word: NotchWord, value: string, button: HTMLElement) => {
      // The eyes go to the word that changed.
      const r = button.getBoundingClientRect();
      eyes.gaze(r.left + r.width / 2, r.top + 8);
      if (folding) startFold(9000);
      if (cur && !cur.done) answer('word', { word: word.name, value });
    },
    refused: () => { eyes.gesture('shake'); sounds.sfx('no'); },
    focus: askFocus,
    after: (ms, fn) => timers.after(ms, fn),
    cancel: (id) => timers.cancel(id),
  });

  function stopFold(): void {
    timers.cancel(foldTimer);
    folding = false;
  }

  /** Left alone, an offer leaves by itself. Not while a hand is on it. */
  function startFold(ms: number): void {
    stopFold();
    if (ms <= 0) return;
    folding = true;
    const mine = tok;
    const check = (): void => {
      if (mine !== tok || !cur || cur.done) return;
      if (wrap.matches(':hover') || nin.contains(document.activeElement) || sentence.picking()) {
        foldTimer = timers.after(2000, check);
        return;
      }
      answer('fold');
      rest();
    };
    foldTimer = timers.after(ms, check);
  }

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

  /** A sheet with more below fades at its lower edge. */
  function more(): void {
    requestAnimationFrame(() => {
      if (alive) sheetEl.classList.toggle('more', sheetEl.scrollTop + sheetEl.clientHeight < sheetEl.scrollHeight - 6);
    });
  }

  /**
   * Whether a yes would land too soon after the line was drawn. 0.35 s for
   * any line: the key may already have been on its way down. 0.7 s for a line
   * that came by itself: the person may be in the middle of a yes to something
   * else, or of a shortcut that ends like one.
   */
  const tooSoon = (): boolean => performance.now() - shownAt < (line?.unasked ? YES_DEAD_UNASKED_MS : YES_DEAD_MS);

  function paintCount(body: Body): void {
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
    tok++;
    shownAt = performance.now();
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
    const ctx = { body: v.pairYes ? 'line' : v.body, onYes: () => { if (cur && !cur.done) cur.onYes?.(); }, onEsc: () => { if (cur && !cur.done) cur.onEsc?.(); } };
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
      iconEl.replaceChildren(el('span', 'who', v.who.charAt(0)));
      nin.dataset.icon = '1';
    } else if (v.src && (NOTCH_APPS as readonly string[]).includes(v.src)) {
      iconEl.innerHTML = ICON[v.src];
      nin.dataset.icon = '1';
      iconEl.classList.add('from');
    } else {
      iconEl.replaceChildren();
      nin.dataset.icon = '0';
    }
    eyesEl.setAttribute('aria-label', v.body === 'rest' ? 'Open Jarvis' : 'Jarvis');
    eyes.setMood(v.mood ?? (v.body === 'rest' ? restMood : DEFAULT_MOOD[v.body]));
    // Where the text starts: options and choices line up under it.
    nin.style.setProperty('--tx', lead.offsetLeft + lead.offsetWidth + 10 + 'px');
    shape.fit(instant);
    more();
    syncEsc();
  }

  function rest(instant = false): void {
    dropKeyboard();
    stopFold();
    cur = null;
    line = null;
    show({ body: 'rest' }, instant);
  }

  const blocksOf = (blocks: readonly NotchBlock[]): HTMLElement => renderBlocks(blocks, {
    plain: (parts) => sentence.plain(parts),
    button: (id, row) => { if (cur && !cur.done) answer('button', row === undefined ? { button: id } : { button: id, row }); },
    go: (row) => { if (cur && !cur.done) answer('go', { row }); },
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

  /** No: the eyes shake, and it goes. */
  const refuse = (): void => {
    answer('no');
    eyes.gesture('shake');
    sounds.sfx('no');
    rest();
  };

  function showLine(l: NotchLine, instant = false): void {
    dropKeyboard();
    line = l;
    cur = { id: l.id };
    stopFold();
    const common = { mood: l.mood, mark: l.mark, who: l.who, src: l.src } satisfies Partial<View>;
    const me = cur;
    const yes = (): void => { sounds.sfx('yes'); answer('yes'); settle(); };

    if (l.kind === 'say') {
      me.onYes = () => { answer('yes'); rest(); };
      // Esc on a result is "seen": it goes, like yes.
      me.onEsc = () => { answer('done'); rest(); };
      show({ body: 'line', say: l.say, ...common }, instant);
      later(Math.max(0, l.ms), () => { answer('done'); rest(); });
      return;
    }
    if (l.kind === 'offer') {
      me.onEsc = refuse;
      if (l.options?.length) {
        const options = l.options;
        show({
          body: 'choices', say: l.say, hint: { cap: 'esc', act: 'not now', touch: true }, ...common,
          opts: options.map((label, index) => ({ label, pick: () => { if (me.done) return; sounds.sfx('yes'); answer('pick', { option: label, index }); settle(); } })),
        }, instant);
        startFold(l.fold ?? 14000);
      } else {
        me.onYes = yes;
        show({ body: 'line', say: l.say, hint: [{ act: l.yes ?? 'yes' }, { cap: 'esc', label: 'not now', touch: true }], ...common }, instant);
        startFold(l.fold ?? 9000);
      }
      return;
    }
    if (l.kind === 'sheet') {
      if (l.yes) me.onYes = yes;
      me.onEsc = () => { answer('no'); rest(); };
      show({
        body: 'sheet', say: l.say, sheet: blocksOf(l.blocks), stag: true, ...common,
        // A sheet that asks for a decision says what each key means: the pair is yes, Esc is no.
        ...(l.stay ? { pairYes: true } : {}),
        hint: l.yes ? [{ act: l.yes }, l.stay ? { cap: 'esc', act: 'no' } : { cap: 'esc', label: 'close' }] : { cap: 'esc', act: 'close' },
      }, instant);
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
      const submit = (): void => {
        const text = input.value.trim();
        if (!text || me.done) return;
        sounds.sfx('yes');
        answer('ask', { text });
        settle();
        input.blur();
      };
      // The window has no keyboard until it asks: a press on the field asks.
      input.addEventListener('pointerdown', () => { askFocus(true); });
      input.addEventListener('blur', () => { if (input.isConnected) askFocus(false); });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); input.blur(); me.onEsc?.(); }
      });
      me.onYes = submit;
      me.onEsc = () => { answer('no'); rest(); };
      show({ body: 'ask', say: input, hint: { act: l.yes }, sheet: blocksOf(l.blocks), stag: true, ...common }, instant);
      // Opened to type in: the keyboard comes with it. Not for a line that is
      // only being drawn again (a page that came back): that would take the
      // keyboard from whatever the person is doing now.
      if (l.focus && !instant) {
        askFocus(true);
        input.focus({ preventScroll: true });
      }
      return;
    }
    if (l.kind === 'work') {
      me.onEsc = () => { eyes.gesture('shake'); sounds.sfx('no'); answer('stop'); settle(); };
      show({
        body: 'work', say: l.say, ...common,
        // How many steps there will be is not always known: then there are no beads to light.
        hint: [...(l.steps > 0 ? [{ beads: l.steps } satisfies Hint] : []), ...(l.canTalk ? [{ cap: 'space', act: 'talk', mute: true } satisfies Hint] : []), { cap: 'esc', act: 'stop' }],
      }, instant);
      if (l.steps > 0) beads(l.done, l.steps);
      return;
    }
    if (l.kind === 'send') {
      const go = (): void => {
        if (cur !== me) return;
        me.onEsc = () => {
          wrap.classList.remove('fusing');
          eyes.gesture('shake');
          sounds.sfx('no');
          answer('undo');
          settle();
        };
        show({ body: 'line', say: l.say, hint: { cap: 'esc', act: 'undo' }, ...common, mood: l.mood ?? 'write' }, instant);
        shape.burn(Math.max(0, l.ms));
        later(Math.max(0, l.ms), () => {
          if (me.done) return;
          wrap.classList.remove('fusing');
          // It leaves along the edge, the way it would have come.
          edge.depart(false);
          answer('done');
          settle();
        });
      };
      // A sheet of paper folds away before it goes.
      const paper = sheetEl.querySelector('.paper');
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
    // Esc turns away what is being said, or what was just heard: it will not be acted on.
    me.onEsc = refuse;
    show({ body: 'line', say: voice, hint: l.over ? HEARD_HINT : { cap: 'jk', act: 'let go when done', mute: true }, ...common, mood: l.mood ?? 'listen' }, instant);
    if (l.over) return;
    wrap.classList.add('talk');
    shape.morphPlay('talk');
  }

  /** The keys came up on a line that was listening: the lip is still, and Esc is what is left to press. */
  function heardOver(): void {
    wrap.classList.remove('talk');
    if (shape.N.mode === 'talk') { shape.N.tgt = null; shape.morphStop(); }
    const ctx = { body: 'line', onYes: () => {}, onEsc: () => { if (cur && !cur.done) cur.onEsc?.(); } };
    hintEl.replaceChildren(mkHint(HEARD_HINT, ctx));
    shape.fit(false, true);
  }

  function update(m: Extract<NotchToPage, { type: 'update' }>): void {
    const l = line;
    if (!l || l.id !== m.id) return;
    if (m.say) {
      l.say = m.say;
      if (l.kind !== 'ask' && l.kind !== 'listen') {
        sayEl.replaceChildren(sentence.nodes(m.say));
        shape.fit(false, true);
      }
    }
    if (m.done !== undefined && l.kind === 'work') {
      l.done = m.done;
      beads(l.done, l.steps);
      sounds.sfx('tick');
    }
    if (m.over !== undefined && l.kind === 'listen' && m.over && !l.over) {
      l.over = true;
      heardOver();
    }
    if (m.heard !== undefined && l.kind === 'listen') {
      l.heard = m.heard;
      const heard = sayEl.querySelector('.heard');
      if (heard) heard.textContent = m.heard;
      // The lip jumps with each word, while there is a voice to follow.
      if (!reduce && !l.over) shape.N.tgt = Array.from({ length: WK }, () => Math.random() * 6);
      shape.fit(false, true);
      shape.wake();
    }
    if (m.blocks && (l.kind === 'sheet' || l.kind === 'ask')) {
      l.blocks = m.blocks;
      const top = sheetEl.scrollTop;
      sentence.reset();
      sheetEl.classList.remove('stag');
      sheetEl.replaceChildren(blocksOf(m.blocks));
      sheetEl.scrollTop = top;
      shape.fit(false, true);
      more();
    }
  }

  function mouth(state: 'open' | 'over' | 'shut' | 'gulp'): void {
    const shut = (): void => {
      shape.N.wide = false;
      wrap.classList.remove('over', 'feed');
      shape.setFeeding(false);
      if (shape.N.mode === 'mouth') shape.morphStop();
      shape.fit();
      shape.shapeFor(eyes.mood());
    };
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
    } else if (state === 'shut') {
      shut();
    } else {
      shut();
      shape.kick(330);
      shape.morphPlay('ripple');
      eyes.gesture('nodg');
      sounds.sfx('yes');
    }
  }

  function act(m: Extract<NotchToPage, { type: 'act' }>): void {
    if (m.sound !== undefined) sounds.set(m.sound);
    if (m.eye !== undefined) {
      if (m.eye) { nin.dataset.eye = 'eye'; shape.kick(-140); } else delete nin.dataset.eye;
    }
    if (m.mood) {
      if (!cur) restMood = m.mood;
      eyes.setMood(m.mood);
    }
    if (m.gesture) {
      if (m.gesture === 'wake' && !m.mood) restMood = 'idle';
      // The eye that was kept on something opens wide when that thing changes.
      if (m.gesture === 'pop' && nin.dataset.eye) {
        nin.classList.add('eyefire');
        timers.after(650, () => nin.classList.remove('eyefire'));
        shape.kick(210);
      }
      eyes.gesture(m.gesture);
    }
    if (m.lip) shape.morphPlay(m.lip);
    if (m.mouth) mouth(m.mouth);
    if (m.park !== undefined) edge.park(m.park);
    // A birth only when there is nothing on the notch: it starts from the eyes.
    if (m.birth && !cur) {
      tok++;
      edge.birth(m.birth, () => {});
    }
  }

  function receive(message: NotchToPage): void {
    if (!alive || typeof message !== 'object' || message === null) return;
    try {
      switch (message.type) {
        case 'state': {
          count = Math.max(0, Math.floor(Number(message.count) || 0));
          shownCount = count;
          restMood = message.face && (NOTCH_MOODS as readonly string[]).includes(message.face) ? message.face : 'idle';
          if (message.line) {
            edge.appear();
            showLine(structuredClone(message.line), true);
          } else if (message.born && !born) {
            rest(true);
            edge.birth(message.born, () => {});
          } else {
            edge.appear();
            rest(true);
          }
          born = true;
          syncEsc();
          return;
        }
        case 'show':
          if (!born) return;
          if (message.line.arrive && !reduce) {
            const next = structuredClone(message.line), mine = ++tok;
            edge.arrive(message.line.arrive, () => { if (mine === tok) showLine(next); });
          } else showLine(structuredClone(message.line));
          return;
        case 'rest':
          if (born) rest();
          return;
        case 'face':
          if (!(NOTCH_MOODS as readonly string[]).includes(message.mood)) return;
          restMood = message.mood;
          // At rest it shows at once; under a line it waits for the rest.
          if (born && !cur) eyes.setMood(restMood);
          return;
        case 'count':
          count = Math.max(0, Math.floor(Number(message.count) || 0));
          if (born && !cur) paintCount('rest');
          if (born && !cur) shape.fit();
          return;
        case 'update':
          if (born) update(message);
          return;
        case 'act':
          if (born) act(message);
          return;
        default:
          return;
      }
    } catch (error) {
      // A message that cannot be drawn must not take the notch down with it.
      console.error('[notch] a message could not be shown', error);
    }
  }

  // Lit words: a click moves to the next option, a drag or the wheel scrubs.
  let scrub: { word: HTMLElement; x: number; moved: boolean } | null = null, scrubbed = 0;
  const liveOf = (target: EventTarget | null): HTMLElement | null =>
    (target instanceof Element ? target.closest<HTMLElement>('.live') : null);
  const onPointerDown = (e: PointerEvent): void => {
    const word = liveOf(e.target);
    if (word && sentence.wordOf(word)) scrub = { word, x: e.clientX, moved: false };
  };
  const onPointerMove = (e: PointerEvent): void => {
    eyes.pointer(e.clientX, e.clientY);
    if (!scrub) return;
    const d = e.clientX - scrub.x;
    if (Math.abs(d) < 18) return;
    scrub.moved = true;
    scrub.x = e.clientX;
    sentence.cycle(scrub.word, d > 0 ? 1 : -1);
    sounds.sfx('tick');
  };
  const onPointerUp = (): void => {
    if (scrub?.moved) scrubbed = performance.now();
    scrub = null;
  };
  const onClick = (e: MouseEvent): void => {
    const word = liveOf(e.target);
    if (word) {
      if (performance.now() - scrubbed > 250 && !(cur?.done)) sentence.cycle(word, 1);
      return;
    }
    // A press on "close" puts the notch to rest before this handler hears of
    // it. What was pressed is gone from the page by then, and that is how the
    // two are told apart: only a click on the resting notch itself opens it.
    if (!(e.target instanceof Node) || !e.target.isConnected) return;
    if (nin.dataset.body === 'rest' && born && edge.shown()) send({ type: 'open' });
  };
  let lastWheel = 0;
  const onWheel = (e: WheelEvent): void => {
    const word = liveOf(e.target);
    if (!word || cur?.done) return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheel < 140) return;
    lastWheel = now;
    sentence.cycle(word, e.deltaY > 0 ? 1 : -1);
  };
  // Keys work whenever the page has the keyboard. Nothing depends on them.
  const onKey = (e: KeyboardEvent): void => {
    if (!cur || cur.done || e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (sentence.picking()) sentence.closePick();
      else if (!(line?.unasked && tooSoon())) cur.onEsc?.();
      return;
    }
    // A line that only just appeared cannot be answered by a key already on its way down.
    if (tooSoon()) return;
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      cur.onYes?.();
    } else if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key);
      const target = optsEl.children[n - 1] ?? sheetEl.querySelector(`.btn[data-k="${n}"]`);
      if (target instanceof HTMLElement) { e.preventDefault(); target.click(); }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const word = liveOf(document.activeElement) ?? nin.querySelector<HTMLElement>('.live');
      if (word) { e.preventDefault(); sentence.cycle(word, e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1); }
    }
  };
  const onScroll = (): void => more();
  const onResize = (): void => { shape.fit(true); };

  notch.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove, { passive: true });
  root.addEventListener('pointerup', onPointerUp);
  notch.addEventListener('click', onClick);
  notch.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('keydown', onKey);
  sheetEl.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  // A font is only fetched when text first uses it, which is after that text
  // was measured: the first sentence would be sized for the fallback font and
  // left too wide. So the faces the notch writes in are asked for at once,
  // and whenever one arrives late the notch is measured again.
  const onFonts = (): void => { if (alive && born) shape.fit(true); };
  if (document.fonts) {
    for (const face of ['500 15px "Familjen Grotesk"', '600 15px "Familjen Grotesk"', '400 13.5px "Familjen Grotesk"', '500 12px "Spline Sans Mono"', '600 12px "Spline Sans Mono"']) {
      void document.fonts.load(face).catch(() => {});
    }
    void document.fonts.ready.then(onFonts);
    document.fonts.addEventListener?.('loadingdone', onFonts);
  }

  /** The body's outline as points in the window's px, top left to top right. */
  function bodyEdge(): Point[] {
    const c = shape.current();
    if (!c.d) return [];
    const scale = window.devicePixelRatio || 1;
    const points = flattenPath(c.d, scale).map(([x, y]): Point => [x + c.x, y]);
    if (!settled()) return points;
    // At rest the straight sides and the bottom sit on whole screen pixels,
    // or they are drawn as a grey line half as dark. The whole outline is
    // stretched by the fraction of a pixel that takes.
    const left = c.x + OX, right = left + c.w, bottom = c.h;
    const snap = (v: number): number => Math.round(v * scale) / scale;
    const l2 = snap(left), r2 = snap(right), b2 = snap(bottom);
    if (right - left < 1 || bottom < 1) return points;
    const kx = (r2 - l2) / (right - left), ky = b2 / bottom;
    return points.map(([x, y]): Point => [l2 + (x - left) * kx, y > 0 ? y * ky : y]);
  }

  function outlines(inset: number): Point[][] {
    const polygons: Point[][] = [];
    if (edge.shown()) {
      const body = hanging(bodyEdge(), inset);
      if (body.length >= 3) polygons.push(body);
    }
    polygons.push(...edge.polygons(inset));
    return polygons;
  }

  let wasDown = false;
  function pointer(x: number, y: number, down: boolean): void {
    if (!alive) return;
    eyes.pointer(x, y);
    const pressed = down && !wasDown;
    wasDown = down;
    const on = born && outlines(0).some((polygon) => inside(polygon, x, y));
    if (on !== pointerOnNotch) { pointerOnNotch = on; syncEsc(); }
    if (!pressed || !born) return;
    // A press outside everything the notch is made of is a click away from it.
    if (on) return;
    if (sentence.picking()) sentence.closePick();
    const body = nin.dataset.body;
    // A sheet that asks for a decision is not answered by a click meant for another app.
    if (line?.kind === 'sheet' && line.stay) return;
    if (cur && !cur.done && (body === 'sheet' || body === 'ask')) cur.onEsc?.();
  }

  /** Yes from the keyboard: to what is offered; with nothing offered, open up. */
  function yesKey(): void {
    if (!born || !edge.shown()) return;
    // A line that only just appeared cannot be answered by keys already on their way down.
    if (tooSoon()) return;
    if (!cur) { send({ type: 'open' }); return; }
    if (cur.done) return;
    if (cur.onYes) { cur.onYes(); return; }
    // Choices have no yes: the row of them nods, to say "pick one".
    if (optsEl.firstChild) {
      optsEl.classList.remove('nudge');
      void optsEl.offsetWidth;
      optsEl.classList.add('nudge');
      timers.after(420, () => optsEl.classList.remove('nudge'));
    }
  }

  function key(name: string): void {
    if (!alive || !born) return;
    if (name === 'talk-start') {
      // It perks up the moment its keys are held.
      wrap.classList.add('att');
      shape.kick(90);
      shape.fit(false, true);
    } else if (name === 'talk-end' || name === 'talk-cancel') {
      // Let go, or ended by a slip: either way the keys are no longer held.
      wrap.classList.remove('att');
      shape.fit(false, true);
    } else if (name === 'yes') {
      yesKey();
    } else if (name === 'esc') {
      if (sentence.picking()) sentence.closePick();
      // Esc on a line is a no. One that came by itself takes none for its
      // first moment, like a yes: the key may have been on its way to the
      // app in front.
      else if (line?.unasked && tooSoon()) return;
      else if (cur && !cur.done) cur.onEsc?.();
    } else if (name === 'esc-twice') {
      eyes.gesture('shake');
      sounds.sfx('no');
      send({ type: 'stop' });
    }
  }

  // The pair that is held shows beside the eyes while it is held.
  const held = (): void => {
    lead.querySelector('.cap.held')?.remove();
    lead.append(duo('talk', 'span', 'cap held'));
  };
  held();

  // Nothing is on screen until the brain has said what the notch shows.
  edge.hide();

  return {
    receive, outlines, pointer, key,
    onOutline(listener) { listeners.add(listener); },
    onWantEsc(listener) { escListeners.add(listener); },
    setPairs(pairs) {
      if (!setKeyPairs(pairs)) return;
      held();
      // The hints on screen were drawn with the old keys: draw the line again.
      if (line && cur && !cur.done) showLine(structuredClone(line), true);
    },
    destroy() {
      alive = false;
      syncEsc();
      escListeners.clear();
      frames.stop();
      timers.clear();
      sounds.stop();
      listeners.clear();
      notch.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', onPointerUp);
      notch.removeEventListener('click', onClick);
      notch.removeEventListener('wheel', onWheel);
      root.removeEventListener('keydown', onKey);
      sheetEl.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      document.fonts?.removeEventListener?.('loadingdone', onFonts);
      root.replaceChildren();
    },
  };
}
