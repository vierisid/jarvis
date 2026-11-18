/**
 * A file dragged to the notch, on the page's side.
 *
 * The page's window is where the file is let go, so the page is what hears
 * of it. It does three things:
 *
 *   - It says to the brain that a file is over the notch, and when it has
 *     gone again, so that the notch can open its mouth for it.
 *   - It sends a file that is let go to the brain, as the body of one
 *     request (the first three, when several are dropped together). The
 *     bytes never pass through the desktop app: its messages are for a few
 *     words, not for a file.
 *   - It never lets a drop do what a browser does with one by itself, which
 *     is to leave this page and show the file instead. That holds for
 *     anything dragged here, a file or not.
 *
 * A file too large to be read at all is not sent: the brain is told its
 * name, kind and size, and says so.
 */
import type { NotchFromPage } from '../../../src/notch/protocol.ts';

/** Where a dropped file goes, and the most that is sent (src/notch/drop.ts). */
export const NOTCH_DROP_PATH = '/api/notch/drop';
export const NOTCH_DROP_MAX_BYTES = 16 * 1024 * 1024;
/** The most files taken from one drop (src/notch/drop.ts). */
export const NOTCH_DROP_MOST = 3;

export interface NotchDropPort {
  send(message: NotchFromPage): void;
  /** Hands a file to the brain. False, or a failure, when it did not arrive. */
  upload(file: File, count: number): Promise<boolean>;
}

/**
 * A file's name as a header carries it: percent-encoded, at most 900 signs.
 * A long name is cut before it is encoded, in whole letters, and keeps its
 * ending: the kind of file is told from the ending. (It was cut after
 * encoding, which could cut inside one letter, and always cut the ending off:
 * a Word file with a long Japanese name was refused as an unreadable kind.)
 */
export function notchDropName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ending = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  let stem = [...(ending ? name.slice(0, dot) : name)];
  let out = encodeURIComponent(stem.join('') + ending);
  while (out.length > 900 && stem.length > 1) {
    stem = stem.slice(0, Math.max(1, Math.floor(stem.length * 0.8)));
    try { out = encodeURIComponent(stem.join('') + ending); } catch { /* half a pair at the cut: one more letter goes */ stem = stem.slice(0, -1); out = encodeURIComponent(stem.join('') + ending); }
  }
  return out.slice(0, 900);
}

/** The headers that go with a dropped file: its name, its size and how many were dropped with it. */
export function notchDropHeaders(file: Pick<File, 'name' | 'type' | 'size'>, count: number): Record<string, string> {
  return {
    'content-type': file.type || 'application/octet-stream',
    // A name may hold any letters; a header may not.
    'x-notch-file': notchDropName(file.name),
    'x-notch-size': String(file.size),
    'x-notch-count': String(count),
  };
}

/** Sends a file to the brain the page came from. */
export async function notchUpload(file: File, count: number, request: typeof fetch = fetch, signedOut?: () => void): Promise<boolean> {
  const reply = await request(NOTCH_DROP_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: notchDropHeaders(file, count),
    // Too large to be read: only what it is goes, and the brain says so.
    body: file.size > NOTCH_DROP_MAX_BYTES ? '' : file,
  });
  // Refused because this page is no longer signed in: said, so that the brain opens it again signed in.
  if (reply.status === 401) signedOut?.();
  return reply.ok;
}

/** How often the page shows the brain it is still there, which also tells it when its sign-in has ended. */
export const NOTCH_ALIVE_EVERY_MS = 20 * 60_000;

/**
 * Asks the brain for the page's own address now and then. A page that asks
 * nothing looks idle to the brain, which ends an idle sign-in after four
 * hours; and no sign-in lasts longer than twelve. Either way the next file
 * dropped was refused, and every one after it. Asking keeps it from going
 * idle, and the day the answer is "not signed in" the page says so once.
 * Comes back with what ends it.
 */
export function watchNotchSignIn(signedOut: () => void, options: { request?: typeof fetch; every?: number; path?: string } = {}): () => void {
  const request = options.request ?? fetch;
  let over = false;
  const ask = async (): Promise<void> => {
    if (over) return;
    try {
      const reply = await request(options.path ?? window.location.pathname, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' });
      if (reply.status === 401 && !over) { over = true; clearInterval(timer); signedOut(); }
    } catch { /* the brain is away for a moment: asked again next time */ }
  };
  const timer = setInterval(() => { void ask(); }, options.every ?? NOTCH_ALIVE_EVERY_MS);
  return () => { over = true; clearInterval(timer); };
}

const holdsFiles = (event: DragEvent): boolean => [...(event.dataTransfer?.types ?? [])].includes('Files');

/** Watches for files dragged over the page. Comes back with what ends the watch. */
export function watchNotchDrops(target: Pick<Document, 'addEventListener' | 'removeEventListener'>, port: NotchDropPort): () => void {
  // Entering a child fires an enter before the leave of its parent: counted, so that "over" is said once.
  let depth = 0;
  let over = false;
  const leave = (): void => {
    depth = 0;
    if (!over) return;
    over = false;
    port.send({ type: 'drag', state: 'left' });
  };
  const onEnter = (event: Event): void => {
    const drag = event as DragEvent;
    drag.preventDefault();
    if (!holdsFiles(drag)) return;
    depth++;
    if (over) return;
    over = true;
    port.send({ type: 'drag', state: 'over' });
  };
  const onOver = (event: Event): void => {
    const drag = event as DragEvent;
    // Always: without it the browser takes the drop for itself and leaves the page.
    drag.preventDefault();
    if (drag.dataTransfer) drag.dataTransfer.dropEffect = holdsFiles(drag) ? 'copy' : 'none';
  };
  const onLeave = (event: Event): void => {
    if (!over) return;
    (event as DragEvent).preventDefault();
    depth = Math.max(0, depth - 1);
    if (depth === 0) leave();
  };
  const onDrop = (event: Event): void => {
    const drag = event as DragEvent;
    drag.preventDefault();
    const files = [...(drag.dataTransfer?.files ?? [])];
    depth = 0;
    if (files.length === 0) { leave(); return; }
    over = false;
    // One after another, in the order they were dropped: the brain holds them in that order.
    void (async () => {
      for (const file of files.slice(0, NOTCH_DROP_MOST)) {
        let arrived = false;
        try { arrived = await port.upload(file, files.length); } catch { arrived = false; }
        if (!arrived) { port.send({ type: 'drag', state: 'lost' }); return; }
      }
    })();
  };
  target.addEventListener('dragenter', onEnter);
  target.addEventListener('dragover', onOver);
  target.addEventListener('dragleave', onLeave);
  target.addEventListener('drop', onDrop);
  return () => {
    target.removeEventListener('dragenter', onEnter);
    target.removeEventListener('dragover', onOver);
    target.removeEventListener('dragleave', onLeave);
    target.removeEventListener('drop', onDrop);
  };
}
