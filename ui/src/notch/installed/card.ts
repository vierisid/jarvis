/**
 * The card a new person sees before the notch has said a word: that it is
 * installed, and where it lives.
 *
 * The prototype put it in the middle of the desktop on the first run
 * ("Jarvis is installed. It lives at the top of your screen. Look up."). The
 * owner, 17 November 2026: "when you start Jarvis for the first time, you
 * get like that little thing ... that's something that you should add as
 * well", and then: "Don't say look up. Don't use Jarvis as the name. Use
 * Pillow with the new brand name."
 *
 * So it is the brand book's own card for this moment (brand system v3, "the
 * installer's last screen"): the app tile, the name, one line. On black, as
 * the notch is. It is a window of its own, in the middle of the screen, that
 * takes no click and no key; the brain opens it and takes it away.
 */
import { NOTCH_NAME } from '../../../../src/notch/name.ts';
import { PILLOW_DROP_PNG } from './mark.ts';

export function drawInstalledCard(root: HTMLElement): void {
  root.classList.add('pillow-card');
  root.setAttribute('role', 'status');
  const tile = document.createElement('div');
  tile.className = 'tile';
  const mark = document.createElement('img');
  mark.alt = '';
  mark.draggable = false;
  mark.src = PILLOW_DROP_PNG;
  tile.append(mark);
  const words = document.createElement('div');
  const title = document.createElement('b');
  title.textContent = `${NOTCH_NAME} is installed.`;
  const line = document.createElement('span');
  line.textContent = 'It lives at the top of your screen.';
  words.append(title, line);
  root.replaceChildren(tile, words);
}

/** Whether this page was opened to be that card, and not the notch. */
export function isInstalledCard(search: string): boolean {
  return new URLSearchParams(search).get('card') === 'installed';
}
