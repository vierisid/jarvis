/**
 * The notch's page: one surface, wired to the desktop app that hosts it.
 * Nothing is drawn until the brain answers the hello this sends.
 */
import { connectNotch, notchFocus, notchSend } from './bridge.ts';
import { notchUpload, watchNotchDrops } from './drop.ts';
import { createNotchSurface } from './surface/index.ts';

const root = document.getElementById('notch-root');
if (root) {
  const host = window as unknown as Parameters<typeof notchSend>[0];
  const send = notchSend(host);
  connectNotch(createNotchSurface(root, send, { focus: notchFocus(host) }), host);
  // A file dragged to the notch: said to the brain while it is held over it, and sent when it is let go.
  watchNotchDrops(document, { send, upload: (file, count) => notchUpload(file, count) });
}
