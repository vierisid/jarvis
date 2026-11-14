/**
 * The owner's files, looked for in Jarvis's own browser.
 *
 * A mail asks for "the deck" or "the signed contract". Before a reply says
 * that it does not have the file, Jarvis looks where the owner keeps files.
 * Google Drive is one address away in the browser where they are signed in:
 * its search, read by ./page/drive-search.js. No connection is waited for.
 *
 * This finds and names. It opens no file, shares none and attaches none.
 */
import type { GmailPage } from './gmail.ts';

export interface DriveFile {
  /** Drive's id of the file. */
  id: string;
  name: string;
  /** What kind of file Drive says it is: "Google Slides", "PDF". Empty when it did not say. */
  kind: string;
}

/** The most words a search is: what a person would type, not a sentence. */
export const DRIVE_QUERY_MAX = 80;
const DRIVE_TRIES = 4;

/** Words only: nothing that Drive's search would read as an instruction ("owner:", "-", quotes). */
export function driveQuery(words: string): string {
  return words.replace(/[^\p{L}\p{N} ._]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, DRIVE_QUERY_MAX).trim();
}

/** The address, inside Google Drive, of a search. In English: the kind of a file is read from words. */
export function driveSearchPath(query: string): string {
  return `/drive/search?q=${encodeURIComponent(query)}&hl=en`;
}

/** Where a file is, for the owner to open it. */
export const driveFileAddress = (file: Pick<DriveFile, 'id'>): string => `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`;

function driveFile(raw: unknown): DriveFile | null {
  const file = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!file || typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(file.id)) return null;
  if (typeof file.name !== 'string' || !file.name.trim()) return null;
  return { id: file.id, name: file.name.replace(/\s+/g, ' ').trim().slice(0, 200), kind: typeof file.kind === 'string' ? file.kind.replace(/\s+/g, ' ').trim().slice(0, 60) : '' };
}

/**
 * The files Drive finds for some words, the closest first. An empty list is
 * an answer: nothing is called that. Null when the browser is not signed in to
 * Google, or the words are no search: that way is not there. A throw is a
 * Drive that is there and could not be read.
 */
export async function browserDriveSearch(page: GmailPage, words: string, options: {
  most?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<DriveFile[] | null> {
  const query = driveQuery(words);
  if (!query) return null;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await page.run('site', { site: 'drive', path: driveSearchPath(query) });
  let state = 'not-up';
  for (let attempt = 0; attempt < DRIVE_TRIES; attempt++) {
    // The page is on its way: an answer given while the address changes is thrown away by the desktop app.
    await sleep(attempt === 0 ? 1200 : 1500);
    const answer = await page.run<{ state?: unknown; files?: unknown }>('drive-search', { query, most: options.most ?? 8 }).catch(() => null);
    state = typeof answer?.state === 'string' ? answer.state : 'no-answer';
    if (state === 'signed-out') return null;
    if (state === 'read') {
      const files = (Array.isArray(answer?.files) ? answer.files : []).flatMap((raw) => { const file = driveFile(raw); return file ? [file] : []; });
      return files.slice(0, options.most ?? 8);
    }
  }
  throw new Error(`Google Drive did not show the search (${state})`);
}
