/**
 * Where a file that arrived is put: the person's Downloads.
 *
 * It is saved and nothing else. It is never written over something that is
 * there: a second "deck.pdf" is "deck (2).pdf". Its name was made readable
 * and harmless before it got here (./notes.ts, peerFileName), and is checked
 * once more for the names a Windows folder will not take.
 *
 * A brain that runs under WSL saves into the Windows Downloads, when that
 * can be found: it is the one the person looks in.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { extname, join } from 'node:path';
import { WSLBridge } from '../actions/terminal/wsl-bridge.ts';
import { peerFileName } from './notes.ts';

/** How many names are tried before it is given up: "deck (2).pdf" to "deck (200).pdf". */
export const DOWNLOAD_NAMES = 200;

/** Names a Windows folder keeps for itself, whatever comes after the dot. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Saves under `name`, or under the next name that is free. Null when it could not be saved. */
export function saveDownload(dir: string, name: string, bytes: Uint8Array): { name: string } | null {
  const safe = peerFileName(name);
  const ext = extname(safe);
  let base = ext ? safe.slice(0, -ext.length) : safe;
  if (!base || RESERVED.test(base)) base = `file ${base}`.trim();
  try { mkdirSync(dir, { recursive: true }); } catch { return null; }
  for (let n = 1; n <= DOWNLOAD_NAMES; n++) {
    const one = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`;
    try {
      // Fails when the name is taken, by a file or by anything else: nothing is ever written over.
      writeFileSync(join(dir, one), bytes, { flag: 'wx' });
      return { name: one };
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') return null;
    }
  }
  return null;
}

let bridge: WSLBridge | null = null;

/** The person's Downloads folder. Under WSL the Windows one, when it is there. */
export async function downloadsFolder(): Promise<string> {
  // The person's own home, also when the brain was given another.
  const own = join(userInfo().homedir, 'Downloads');
  if (!WSLBridge.isWSL()) return own;
  bridge ??= new WSLBridge();
  // It finds the Windows home by asking Windows, which takes a moment the first time.
  for (let tries = 0; tries < 20 && !bridge.getWindowsHome(); tries++) await new Promise((resolve) => setTimeout(resolve, 100));
  const home = bridge.getWindowsHome();
  const windows = home ? join(home, 'Downloads') : null;
  return windows && existsSync(windows) ? windows : own;
}
