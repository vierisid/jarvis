/**
 * A sentence: plain words that fade in one by one, the word or two it is
 * about, keycaps, and lit words. A lit word is one the person can change: a
 * click moves it to its next option, a drag or the wheel scrubs through them,
 * and a strip under the line shows them all with a field to type another.
 * What was typed is read by the readers; what is not understood is refused.
 */
import type { NotchPart, NotchWord } from '../../../../src/notch/protocol.ts';
import { btn, el } from './dom.ts';
import { KEYN, duo } from './hints.ts';
import { readLive } from './readers.ts';

/** The sentence as plain text, as it would be read out. */
export function partsText(parts: readonly NotchPart[]): string {
  return parts.map((p) => {
    if (typeof p === 'string') return p;
    if ('em' in p) return p.em;
    if ('key' in p) return p.key === 'talk' ? KEYN.talk : p.key === 'yes' ? KEYN.yes : p.key;
    return p.word.value;
  }).join('');
}

export interface SentenceDeps {
  nin: HTMLElement;
  pick: HTMLElement;
  opts: HTMLElement;
  sheet: HTMLElement;
  /** Lay the notch out again, quickly: a word changed its width. */
  refit(): void;
  /** A lit word was changed by the person. */
  changed(word: NotchWord, value: string, button: HTMLElement): void;
  /** A typed value was refused. */
  refused(): void;
  /** Ask for the keyboard (true) or give it back (false). */
  focus(take: boolean): void;
  after(ms: number, fn: () => void): number;
  cancel(id: number): void;
}

export interface Sentence {
  /** The sentence as it stands in the line: every word fades in after the one before. */
  nodes(parts: readonly NotchPart[]): DocumentFragment;
  /** The same sentence with no animation, for a row or a sheet of paper. */
  plain(parts: readonly NotchPart[]): DocumentFragment;
  wordOf(button: Element | null): NotchWord | undefined;
  cycle(button: HTMLElement, dir: number): void;
  closePick(): void;
  /** True while the strip of options is open. */
  picking(): boolean;
  /** Forget an open strip without laying anything out: the line is being replaced. */
  reset(): void;
}

/** A word up to this long is one block and never breaks. */
const WORD_WHOLE = 28;
/** A longer one is cut into pieces of at most this many characters. */
const WORD_PIECE = 24;

/**
 * A sentence as the blocks it is drawn in: one per word, each with the space
 * that follows it. A block does not break inside, so a word longer than a
 * line (a path, a URL, a command with no spaces in it) is cut into pieces a
 * line can break between: after a separator where there is one, and at
 * WORD_PIECE characters where there is none. Without that its end ran on
 * under the hint, out of sight, and a line that asks for a yes must show all
 * of what it asks.
 */
export function wordBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const token of text.match(/\S+\s*|\s+/g) ?? []) {
    const chars = [...token];
    if (chars.length <= WORD_WHOLE) { blocks.push(token); continue; }
    let piece = '';
    let n = 0;
    for (const ch of chars) {
      piece += ch;
      n++;
      // After a separator, once the piece is long enough to be worth a line
      // break; or at the limit, whatever the character.
      if (n >= WORD_PIECE || (n >= 8 && /[/\\._\-=&?:,;|@+]/.test(ch))) { blocks.push(piece); piece = ''; n = 0; }
    }
    if (piece) blocks.push(piece);
  }
  return blocks;
}

export function createSentence(deps: SentenceDeps): Sentence {
  const { nin, pick, opts, sheet } = deps;
  const words = new WeakMap<Element, NotchWord>();
  let pickTimer = 0;

  const label = (L: NotchWord, value: string): string => `${L.label ?? 'Change'}: ${value}. Press to change.`;

  function liveBtn(L: NotchWord, plain: boolean): HTMLButtonElement {
    const b = el('button', plain ? 'live' : 'w live', L.value);
    b.type = 'button';
    words.set(b, L);
    b.setAttribute('aria-label', label(L, L.value));
    return b;
  }

  function nodes(parts: readonly NotchPart[]): DocumentFragment {
    const f = document.createDocumentFragment();
    let i = 0, afterLive = false;
    const put = (n: HTMLElement): void => { n.style.setProperty('--i', String(i++)); f.append(n); };
    for (const p of parts) {
      if (typeof p === 'string') {
        // Punctuation right after a lit word sits tight against it.
        wordBlocks(p).forEach((t, k) => put(el('span', k === 0 && afterLive && /^[.,?!;:]/.test(t) ? 'w tight' : 'w', t)));
        afterLive = false;
        continue;
      }
      afterLive = 'word' in p;
      // One block per word here too: an emphasised phrase can be a whole
      // sentence (what an approval will do), and must wrap like one.
      if ('em' in p) wordBlocks(p.em).forEach((t) => put(el('b', 'w em', t)));
      else if ('key' in p) put(p.key === 'talk' ? duo('talk', 'kbd', 'w kbd') : p.key === 'yes' ? duo('yes', 'kbd', 'w kbd') : el('kbd', 'w kbd', p.key));
      else put(liveBtn(p.word, false));
    }
    return f;
  }

  function plain(parts: readonly NotchPart[]): DocumentFragment {
    const f = document.createDocumentFragment();
    for (const p of parts) {
      if (typeof p === 'string') f.append(p);
      else if ('em' in p) f.append(el('b', '', p.em));
      else if ('key' in p) f.append(p.key === 'talk' ? duo('talk', 'kbd', 'kbd') : p.key === 'yes' ? duo('yes', 'kbd', 'kbd') : el('kbd', 'kbd', p.key));
      else f.append(liveBtn(p.word, true));
    }
    return f;
  }

  function setLive(b: HTMLElement, v: string, dir = 1): void {
    const L = words.get(b);
    if (!L) return;
    const was = L.value;
    L.value = v;
    b.textContent = v;
    b.setAttribute('aria-label', label(L, v));
    b.classList.remove('roll', 'up');
    void b.offsetWidth;
    b.classList.add('roll');
    if (dir < 0) b.classList.add('up');
    if (b.isConnected) deps.refit();
    if (v !== was) deps.changed(L, v, b);
  }

  const pickHome = (): void => {
    if (pick.nextElementSibling !== opts) opts.before(pick);
    pick.classList.remove('inrow');
  };

  function closePick(): void {
    deps.cancel(pickTimer);
    const had = pick.firstChild;
    const typing = pick.contains(document.activeElement);
    pick.replaceChildren();
    pickHome();
    if (typing) deps.focus(false);
    if (had) deps.refit();
  }

  // The strip closes by itself when it is left alone.
  function armPick(): void {
    deps.cancel(pickTimer);
    const check = (): void => {
      if (pick.matches(':hover') || pick.contains(document.activeElement)) { pickTimer = deps.after(1500, check); return; }
      closePick();
    };
    pickTimer = deps.after(5200, check);
  }

  function openPick(b: HTMLElement): void {
    const L = words.get(b);
    if (!L) return;
    const f = document.createDocumentFragment();
    f.append(el('span', 'lab', L.label ?? 'Change'));
    for (const o of L.options) {
      const c = btn('o', o, () => { setLive(b, o); openPick(b); });
      c.setAttribute('aria-pressed', String(o === L.value));
      f.append(c);
    }
    // Only a word that can take something new gets a field.
    if (L.free || L.read || L.syn) {
      const inp = el('input');
      inp.type = 'text';
      inp.maxLength = 28;
      inp.placeholder = 'or type your own';
      inp.autocomplete = 'off';
      inp.spellcheck = false;
      inp.setAttribute('aria-label', `Type your own: ${L.label ?? 'value'}`);
      // The window has no keyboard until it asks: a press on the field asks.
      inp.addEventListener('pointerdown', () => { deps.focus(true); });
      inp.addEventListener('blur', () => { if (inp.isConnected) deps.focus(false); });
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        armPick();
        if (e.key === 'Enter') {
          e.preventDefault();
          if (!inp.value.trim()) { closePick(); return; }
          const got = readLive(L, inp.value);
          if (got == null) {
            inp.value = '';
            inp.placeholder = 'I did not get that';
            inp.classList.add('no');
            deps.refused();
            return;
          }
          if (!L.options.includes(got)) L.options = [...L.options, got];
          setLive(b, got);
          closePick();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closePick();
        }
      });
      f.append(inp);
    }
    // In a sheet the options open under their own row.
    const rowEl = b.closest('.row');
    if (rowEl && sheet.contains(rowEl)) { rowEl.after(pick); pick.classList.add('inrow'); } else pickHome();
    pick.replaceChildren(f);
    deps.refit();
    armPick();
  }

  // A click moves to the next option, for when you do not want to think; the
  // strip shows them all, for when you do.
  function cycle(b: HTMLElement, dir: number): void {
    const L = words.get(b);
    if (!L || !L.options.length) return;
    const i = L.options.indexOf(L.value);
    setLive(b, L.options[(i + dir + L.options.length) % L.options.length] ?? L.value, dir);
    openPick(b);
  }

  return {
    nodes, plain, cycle, closePick,
    wordOf: (button) => (button ? words.get(button) : undefined),
    picking: () => !!pick.firstChild,
    reset() { deps.cancel(pickTimer); pick.replaceChildren(); pickHome(); },
  };
}
