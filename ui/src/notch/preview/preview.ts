/**
 * The notch without a brain or a desktop app, for looking at it in a browser.
 *
 * It is not a mock of the product: the page's surface is the real one, the
 * demo moments are the brain's own scripts (src/notch/demo.ts), and what the
 * notch shows is held by the brain's own NotchSurface. Only the pipe between
 * them, which on a desktop runs through the desktop app, is a function call.
 *
 * Run it with: bun ui/src/notch/preview/serve.ts
 */
import { createNotchDemo } from '../../../../src/notch/demo.ts';
import { NOTCH_PROTOCOL_VERSION } from '../../../../src/notch/protocol.ts';
import type { NotchFromPage, NotchToPage } from '../../../../src/notch/protocol.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface as NotchState } from '../../../../src/notch/surface.ts';
import type { NotchSurfacePort } from '../../../../src/notch/surface.ts';
import { createNotchSurface } from '../surface/index.ts';

const need = <T extends Element>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`preview: missing ${selector}`);
  return found;
};
const root = need<HTMLElement>('#notch-root'), overlay = need<SVGSVGElement>('#overlay'), log = need<HTMLElement>('#log');
const showOutline = need<HTMLInputElement>('#outline'), sound = need<HTMLInputElement>('#sound');

const note = (direction: 'in' | 'out', message: unknown): void => {
  const li = document.createElement('li');
  li.className = direction;
  li.textContent = `${direction === 'in' ? 'brain' : 'page'}  ${JSON.stringify(message)}`;
  log.prepend(li);
  while (log.childElementCount > 80) log.lastElementChild?.remove();
};

let toBrain: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
const say = (message: NotchFromPage): void => {
  note('out', message);
  toBrain('preview', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
};

const surface = createNotchSurface(root, say);

// The pipe: where the desktop app would carry a message, this calls.
const port: NotchSurfacePort = {
  dispatchRPC(_sidecarId, _method, params) {
    const message = structuredClone((params as { message: NotchToPage }).message);
    note('in', message);
    surface.receive(message);
    return Promise.resolve({ pushed: true });
  },
  onEvent(listener) { toBrain = listener; },
  onSidecarDisconnected() {},
};
const state = new NotchState(port);
const demo = createNotchDemo(state);

const moments = need<HTMLElement>('#moments');
for (const name of [...demo.names(), 'stop']) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = name;
  b.onclick = () => (name === 'stop' ? demo.stop() : demo.play(name));
  moments.append(b);
}
sound.onchange = () => state.act({ sound: sound.checked });

// The outline the desktop app would be given, drawn over what the page paints.
const drawOutline = (): void => {
  overlay.replaceChildren();
  if (!showOutline.checked) return;
  for (const polygon of surface.outlines(0)) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    p.setAttribute('points', polygon.map(([x, y]) => `${x},${y}`).join(' '));
    overlay.append(p);
  }
};
surface.onOutline(drawOutline);
showOutline.onchange = drawOutline;

// On a desktop the pointer is fed from the whole screen. Here, from the whole page.
let down = false;
const feed = (e: PointerEvent): void => {
  const r = root.getBoundingClientRect();
  surface.pointer(e.clientX - r.left, e.clientY - r.top, down);
};
document.addEventListener('pointermove', feed, { passive: true });
document.addEventListener('pointerdown', (e) => { down = true; feed(e); });
document.addEventListener('pointerup', (e) => { down = false; feed(e); });

say({ type: 'hello', v: NOTCH_PROTOCOL_VERSION });
