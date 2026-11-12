/**
 * One hint grammar: a key and what it does. Citron means yes. Every hint is a
 * button, so everything a key can do, a click can do too.
 */
import { el } from './dom.ts';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

/** A modifier key, as the desktop app names it. */
export type KeyName = 'ctrl' | 'alt' | 'meta' | 'shift';
export type KeyPairs = Record<'talk' | 'yes', [KeyName, KeyName]>;

/** How each key is written on a keycap, and how it is read out. */
const CAP: Record<KeyName, string> = MAC ? { ctrl: '⌃', alt: '⌥', meta: '⌘', shift: '⇧' } : { ctrl: 'ctrl', alt: 'alt', meta: 'win', shift: 'shift' };
const SPOKEN: Record<KeyName, string> = MAC ? { ctrl: 'Ctrl', alt: 'Option', meta: 'Cmd', shift: 'Shift' } : { ctrl: 'Ctrl', alt: 'Alt', meta: 'Win', shift: 'Shift' };
const NAMES: readonly string[] = ['ctrl', 'alt', 'meta', 'shift'];

/** The pairs a machine has until it says otherwise. */
export const DEFAULT_PAIRS: KeyPairs = MAC ? { talk: ['ctrl', 'alt'], yes: ['alt', 'meta'] } : { talk: ['ctrl', 'meta'], yes: ['meta', 'alt'] };

/** The two pairs of keys, never more than two at once: one to talk, the next pair along for yes. */
export const KEYS: Record<'talk' | 'yes', [string, string]> = { talk: ['', ''], yes: ['', ''] };
/** The same pairs, as they are read out. */
export const KEYN: Record<'talk' | 'yes', string> = { talk: '', yes: '' };

const isPair = (value: unknown): value is [KeyName, KeyName] =>
  Array.isArray(value) && value.length === 2 && value.every((k) => typeof k === 'string' && NAMES.includes(k)) && value[0] !== value[1];

/**
 * Sets which keys the hints show. The pairs are per machine and the desktop
 * app tells the page which they are. Anything that is not two pairs of two
 * different modifiers is ignored, and the hints keep what they had.
 */
export function setKeyPairs(pairs: unknown): boolean {
  const p = pairs as { talk?: unknown; yes?: unknown } | null;
  if (!p) return false;
  const { talk, yes } = p;
  // The same two keys cannot both talk and say yes.
  if (!isPair(talk) || !isPair(yes) || (talk.includes(yes[0]) && talk.includes(yes[1]))) return false;
  const set = (kind: 'talk' | 'yes', [a, b]: [KeyName, KeyName]): void => {
    KEYS[kind] = [CAP[a], CAP[b]];
    KEYN[kind] = `${SPOKEN[a]} + ${SPOKEN[b]}`;
  };
  set('talk', talk);
  set('yes', yes);
  return true;
}
setKeyPairs(DEFAULT_PAIRS);

/** A pair of keys drawn as one keycap. */
export function duo(kind: 'talk' | 'yes', tag: 'span' | 'kbd' = 'span', cls = 'cap'): HTMLElement {
  const c = el(tag, `${cls} duo ${kind}`);
  for (const k of KEYS[kind]) c.append(el('b', '', k));
  c.setAttribute('aria-label', KEYN[kind]);
  return c;
}

/**
 * A hint is either the beads of a job in progress, or a key with its action.
 * `cap` is the key ('enter' when left out, which is yes). `act` is the word
 * shown beside it; `label` names a hint that shows no word. `touch` marks the
 * "not now" that only a screen without a keyboard shows, as in the prototype.
 * `mute` is a hint with nothing to press: it only tells you something.
 */
export type Hint =
  | { beads: number }
  | { cap?: 'enter' | 'esc' | 'jk' | 'space'; act?: string; label?: string; touch?: boolean; mute?: boolean; onClick?: () => void };

export interface HintContext {
  /** What the notch is showing: inside a sheet, yes is the plain enter key. */
  body: string;
  onYes(): void;
  onEsc(): void;
}

export function mkHint(h: Hint, ctx: HintContext): Node {
  if ('beads' in h) {
    const w = el('span', 'beads');
    for (let i = 0; i < h.beads; i++) w.append(el('i'));
    const f = document.createDocumentFragment();
    f.append(w, el('span', 'count', `0/${h.beads}`));
    return f;
  }
  const k = h.cap ?? 'enter', held = k === 'space' || k === 'jk', glob = !['sheet', 'ask'].includes(ctx.body);
  const b = el('button', k === 'enter' ? 'key' : 'key quiet');
  b.type = 'button';
  // outside a sheet, yes is its own pair of keys
  b.append(held ? duo('talk') : glob && k === 'enter' ? duo('yes') : el('span', 'cap', k));
  if (h.touch) b.classList.add('nn');
  const word = h.act ?? h.label ?? '';
  if (h.act || h.touch) b.append(el('span', 'act', word));
  b.setAttribute('aria-label', `${word} (${held ? 'hold ' + KEYN.talk : glob && k === 'enter' ? KEYN.yes : k + ' key'})`);
  if (h.label) b.title = h.label;
  if (h.mute) { b.classList.add('mute'); b.tabIndex = -1; return b; }
  const click = h.onClick;
  b.onclick = () => (click ? click() : k === 'esc' ? ctx.onEsc() : k === 'enter' ? ctx.onYes() : undefined);
  return b;
}
