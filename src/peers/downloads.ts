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
import { createHash } from 'node:crypto';
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

/** One command of the desktop app, asked of it. */
export type AppRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** The size of one piece that is handed to the desktop app: a message to it is at most 10 MB. */
export const APP_SAVE_PART = 1_500_000;

/**
 * Has the desktop app put a file into the downloads (sidecar/notch_files_peers.go).
 *
 * It is the program the person gave leave to touch their folders, on every
 * system. The brain is not always: on a Mac its own writing into Downloads
 * was turned down by macOS, on the first files that crossed (22 November
 * 2026). The app checks the whole against the size and the sum given here
 * before it puts it in place, and chooses a name that is free.
 *
 * Null when the app did not save it: it is an older app, it may not touch
 * files, or the system said no.
 */
export async function saveThroughApp(rpc: AppRpc, name: string, bytes: Uint8Array): Promise<{ name: string } | null> {
  const begun = await rpc('notch.save', { step: 'begin', name: peerFileName(name), size: bytes.length }) as { id?: unknown } | null;
  const id = typeof begun?.id === 'string' && /^[0-9a-f]{8,64}$/.test(begun.id) ? begun.id : null;
  if (!id) return null;
  try {
    for (let at = 0; at < bytes.length; at += APP_SAVE_PART) {
      const taken = await rpc('notch.save', { step: 'part', id, data: Buffer.from(bytes.subarray(at, at + APP_SAVE_PART)).toString('base64') }) as { taken?: unknown } | null;
      if (taken?.taken !== true) return null;
    }
    const ended = await rpc('notch.save', { step: 'end', id, sha: createHash('sha256').update(bytes).digest('hex') }) as { saved?: unknown; name?: unknown } | null;
    // The name is the app's word for where it put it: made readable like any name from outside this program.
    return ended?.saved === true && typeof ended.name === 'string' && ended.name ? { name: peerFileName(ended.name) } : null;
  } catch {
    void rpc('notch.save', { step: 'drop', id }).catch(() => { /* it lets go of it by itself in ten minutes */ });
    return null;
  }
}

const PLACES: ReadonlySet<string> = new Set(['desktop', 'documents', 'downloads']);

/** One file the desktop app named (`notch.find`). */
export interface AppFound {
  place: 'desktop' | 'documents' | 'downloads';
  /** The folder below the place: '' at its top, or one or two folder names with a stroke between. */
  dir: string;
  name: string;
  kind: string;
  size: number;
  changed: number;
  score: number;
}

/** The most files that are taken from one answer of the app. */
export const APP_FOUND_MOST = 60;

/** A folder below a place, as the app names it: nothing, or one or two plain folder names. */
function appDir(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string' || raw.length > 400) return null;
  const parts = raw.split('/');
  if (parts.length > 2) return null;
  for (const part of parts) if (!part || part.startsWith('.') || /[\\\u0000-\u001f\u007f]/.test(part) || peerFileName(part) !== part.trim()) return null;
  return parts.join('/');
}

/** The files the desktop app found for some words (`notch.find`), checked field by field. Null when it did not answer as that. */
export function appFound(answer: unknown): AppFound[] | null {
  const found = (answer as { found?: unknown } | null)?.found;
  if (!Array.isArray(found)) return null;
  const out: AppFound[] = [];
  for (const raw of found.slice(0, APP_FOUND_MOST)) {
    const one = (raw ?? {}) as { place?: unknown; dir?: unknown; name?: unknown; kind?: unknown; size?: unknown; changed?: unknown; score?: unknown };
    if (typeof one.place !== 'string' || !PLACES.has(one.place) || typeof one.name !== 'string' || typeof one.size !== 'number' || !Number.isFinite(one.size) || one.size <= 0) continue;
    // A name the app would hand over: one name, no path, readable. Anything else is not shown and not asked for.
    if (!one.name || one.name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(one.name) || peerFileName(one.name) !== one.name.trim()) continue;
    const dir = appDir(one.dir);
    if (dir === null) continue;
    const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
    out.push({ place: one.place as AppFound['place'], dir, name: one.name, kind: String(one.kind ?? '').replace(/[^a-z]/g, '').slice(0, 12), size: Math.floor(one.size), changed: number(one.changed), score: Math.min(number(one.score), 1000) });
  }
  return out;
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
