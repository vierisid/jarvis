/**
 * The notch's page: one surface, wired to the desktop app that hosts it.
 * Nothing is drawn until the brain answers the hello this sends.
 */
import { connectNotch, notchFocus, notchSend } from './bridge.ts';
import { notchUpload, watchNotchDrops, watchNotchSignIn } from './drop.ts';
import { drawInstalledCard, isInstalledCard } from './installed/card.ts';
import { createNotchSurface } from './surface/index.ts';

const root = document.getElementById('notch-root');
if (root && isInstalledCard(window.location.search)) {
  // Not the notch: the small card in the middle of the screen that says it is installed.
  drawInstalledCard(root);
} else if (root) {
  const host = window as unknown as Parameters<typeof notchSend>[0];
  const send = notchSend(host);
  connectNotch(createNotchSurface(root, send, { focus: notchFocus(host) }), host);
  // A file dragged to the notch: said to the brain while it is held over it, and sent when it is let go.
  // Said once: the brain then opens this page again, signed in anew.
  let said = false;
  const signedOut = (): void => { if (!said) { said = true; send({ type: 'signed-out' }); } };
  watchNotchDrops(document, { send, upload: (file, count) => notchUpload(file, count, fetch, signedOut) });
  watchNotchSignIn(signedOut);
}
