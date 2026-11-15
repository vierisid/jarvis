/**
 * The page scripts in ./page, run in Jarvis's own browser.
 *
 * A page script is the body of an async function. It is given `args` as data,
 * never as code, and what it returns is the answer. The scripts are read from
 * the source folder at the moment they are run, so that one can be corrected
 * against the real page without restarting the brain.
 */
import { readFileSync } from 'node:fs';
import { evaluateLong, type MailBrowser } from './browser.ts';

const PAGE_SCRIPT = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** A page script by name, or null when there is none of that name. */
export function pageScript(name: string): string | null {
  if (!PAGE_SCRIPT.test(name)) return null;
  try {
    return readFileSync(new URL(`./page/${name}.js`, import.meta.url), 'utf8');
  } catch {
    return null;
  }
}

/** The three of Google's sites the mail layer reads, and where each is. */
export const GOOGLE_SITES = { mail: 'mail.google.com', calendar: 'calendar.google.com', drive: 'drive.google.com' } as const;
export type GoogleSite = keyof typeof GOOGLE_SITES;

/** The address of a place inside one of the three sites. Throws for anything that would lead elsewhere. */
export function googleAddress(site: GoogleSite, path: string): string {
  const host = GOOGLE_SITES[site];
  if (!host || !path.startsWith('/') || path.startsWith('//')) throw new Error('not a place on a site that is read');
  const url = new URL(`https://${host}${path}`);
  if (url.hostname !== host || url.username || url.password || url.port) throw new Error('not a place on a site that is read');
  return url.href;
}

/** What the readers in this folder need of a browser: run a page script, and go to a place on one of the three sites. */
export interface GooglePage {
  run<T>(name: string, args?: unknown): Promise<T>;
  /**
   * Goes to a place on one of the three sites and comes back when the page is
   * there. A page without this is moved by ./page/site.js, which answers
   * before the page has changed: the caller then has to wait for it.
   */
  go?(site: GoogleSite, path: string): Promise<void>;
}

/** Takes a page to a place on one of the three sites, by whichever way it has. True when the page is already there on return. */
export async function goToSite(page: GooglePage, site: GoogleSite, path: string): Promise<boolean> {
  if (page.go) { await page.go(site, path); return true; }
  await page.run('site', { site, path });
  return false;
}

/** Runs a page script in a browser and gives back what it answered, parsed. */
export async function runPageScript<T>(browser: MailBrowser, name: string, args?: unknown, script: (name: string) => string | null = pageScript): Promise<T> {
  const body = script(name);
  if (body === null) throw new Error('there is no page script of that name');
  const answer = await evaluateLong(browser, `const args = ${JSON.stringify(args ?? null)};\n${body}`);
  return JSON.parse(answer) as T;
}

/** A browser as the readers use it: page scripts by name, and places on the three sites. */
export function googlePage(browser: MailBrowser, script?: (name: string) => string | null): Required<GooglePage> {
  return {
    run: <T>(name: string, args?: unknown) => runPageScript<T>(browser, name, args, script),
    go: (site, path) => browser.navigate(googleAddress(site, path)),
  };
}
