/**
 * The notch without a brain or a desktop app, for looking at it in a browser.
 *
 * It is not a mock of the product: the page's surface is the real one, the
 * demo moments are the brain's own scripts (src/notch/demo.ts), and what the
 * notch shows is held by the brain's own NotchSurface. Only the pipe between
 * them, which on a desktop runs through the desktop app, is a function call.
 * It can be made slow and made to lose messages (./pipe.ts), to see an answer
 * being sent again and a page that missed something ask for the whole.
 *
 * Run it with: bun ui/src/notch/preview/serve.ts
 */
import { createNotchDemo } from '../../../../src/notch/demo.ts';
import { NOTCH_PROTOCOL_VERSION } from '../../../../src/notch/protocol.ts';
import type { NotchFromPage, NotchToPage } from '../../../../src/notch/protocol.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface as NotchState, realNotchTimers } from '../../../../src/notch/surface.ts';
import type { NotchSurfacePort } from '../../../../src/notch/surface.ts';
import { NOTCH_HELLO_AGAIN_MS, notchPageName } from '../bridge.ts';
import { createNotchSurface } from '../surface/index.ts';
import { createNotchPipe } from './pipe.ts';

const need = <T extends Element>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`preview: missing ${selector}`);
  return found;
};
const root = need<HTMLElement>('#notch-root'), overlay = need<SVGSVGElement>('#overlay'), log = need<HTMLElement>('#log');
const showOutline = need<HTMLInputElement>('#outline'), sound = need<HTMLInputElement>('#sound');
const delay = need<HTMLInputElement>('#delay'), loss = need<HTMLInputElement>('#loss');

const note = (direction: 'in' | 'out', message: unknown, lost: boolean): void => {
  const li = document.createElement('li');
  li.className = lost ? `${direction} lost` : direction;
  li.textContent = `${direction === 'in' ? 'brain' : 'page'}  ${lost ? '(lost) ' : ''}${JSON.stringify(message)}`;
  log.prepend(li);
  while (log.childElementCount > 80) log.lastElementChild?.remove();
};

// The pipe: where the desktop app would carry a message, this calls, after a while or never.
const pipe = { delayMs: () => Number(delay.value), lossPercent: () => Number(loss.value), after: (ms: number, fn: () => void) => { setTimeout(fn, ms); } };
const toPage = createNotchPipe(pipe), fromPage = createNotchPipe(pipe);

let toBrain: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
const say = (message: NotchFromPage): void => {
  const carried = fromPage(() => toBrain('preview', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } }));
  note('out', message, !carried);
};

const surface = createNotchSurface(root, say);

const port: NotchSurfacePort = {
  dispatchRPC(_sidecarId, _method, params) {
    const message = structuredClone((params as { message: NotchToPage }).message);
    const carried = toPage(() => surface.receive(message));
    note('in', message, !carried);
    return Promise.resolve({ pushed: true });
  },
  onEvent(listener) { toBrain = listener; },
  onSidecarDisconnected() {},
};
// With the real timers, as the brain has them: an offer that is left alone is folded by the brain.
const state = new NotchState(port, undefined, undefined, realNotchTimers);
const demo = createNotchDemo(state);

const moments = need<HTMLElement>('#moments');
for (const name of [...demo.names(), 'stop']) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = name;
  b.onclick = () => (name === 'stop' ? demo.stop() : demo.play(name));
  moments.append(b);
}
sound.onchange = () => state.setSound(sound.checked);

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

// The hello, as the page's own wiring says it (../bridge.ts), without that wiring's limits: said again
// until the brain has told the whole, and whenever the page finds itself out of step, never closer
// together than the page says it.
const page = notchPageName();
let stated = false, helloAt = -Infinity;
const hello = (): void => {
  helloAt = performance.now();
  say({ type: 'hello', v: NOTCH_PROTOCOL_VERSION, page });
};
const receive = surface.receive;
surface.receive = (message) => {
  receive(message);
  if (message.type === 'state') stated = true;
};
surface.onDropped(() => { stated = false; });
setInterval(() => { if (!stated && performance.now() - helloAt >= NOTCH_HELLO_AGAIN_MS) hello(); }, 500);
hello();
