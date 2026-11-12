/**
 * One hint grammar: a key and what it does. Citron means yes. Every hint is a
 * button, so everything a key can do, a click can do too.
 */
import { el } from './dom.ts';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

/** The two pairs of keys, never more than two at once: one to talk, the next pair along for yes. */
export const KEYS: Record<'talk' | 'yes', [string, string]> = {
  talk: MAC ? ['⌃', '⌥'] : ['ctrl', 'win'],
  yes: MAC ? ['⌥', '⌘'] : ['win', 'alt'],
};
/** The same pairs, as they are read out. */
export const KEYN: Record<'talk' | 'yes', string> = {
  talk: MAC ? 'Ctrl + Option' : 'Ctrl + Win',
  yes: MAC ? 'Option + Cmd' : 'Win + Alt',
};

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
