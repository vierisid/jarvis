/**
 * The notch's page: one surface, wired to the desktop app that hosts it.
 * Nothing is drawn until the brain answers the hello this sends.
 */
import { connectNotch, notchFocus, notchSend } from './bridge.ts';
import { createNotchSurface } from './surface/index.ts';

const root = document.getElementById('notch-root');
if (root) {
  const host = window as unknown as Parameters<typeof notchSend>[0];
  connectNotch(createNotchSurface(root, notchSend(host), { focus: notchFocus(host) }), host);
}
