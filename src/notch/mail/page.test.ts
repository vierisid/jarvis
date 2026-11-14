import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * The page scripts run inside Gmail, where no test of ours can follow. What
 * can be held here is that each one is a function body that parses, and that
 * the ones whose answers are printed are written to answer with shapes.
 */
const folder = new URL('./page/', import.meta.url);
const scripts = readdirSync(folder).filter((name) => name.endsWith('.js'));
const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => unknown;

describe('the page scripts', () => {
  test('each is the body of an async function that takes args', () => {
    expect(scripts.length).toBeGreaterThan(0);
    for (const name of scripts) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,40}\.js$/);
      expect(() => new AsyncFunction('args', readFileSync(new URL(name, folder), 'utf8'))).not.toThrow();
    }
  });

  // The study's browser is signed in as the owner. Where it may be taken is written in one script, and held here.
  test('one script takes the browser to another site, and only to Gmail, Google Calendar and Google Drive', () => {
    const moves = /location\.href\s*=[^=]|location\.(?:assign|replace)\(|window\.open\(|\blocation\s*=[^=]/;
    const moving = scripts.filter((name) => readFileSync(new URL(name, folder), 'utf8').split('\n').some((line) => !line.trim().startsWith('//') && moves.test(line)));
    expect(moving).toEqual(['site.js']);
    const site = readFileSync(new URL('site.js', folder), 'utf8');
    const hosts = [...site.matchAll(/'([a-z.]+\.[a-z]+)'/g)].map((found) => found[1]);
    expect(hosts.sort()).toEqual(['calendar.google.com', 'drive.google.com', 'mail.google.com']);
    // It goes to the host it named and to no other, whatever path it was handed.
    expect(site).toContain('if (to.hostname !== host) throw');
  });

  // What a shape script answers is printed on a developer's screen: it may count and describe, never quote.
  test('a shape script never answers with text, an address or an attribute value from the page', () => {
    for (const name of scripts.filter((entry) => entry.startsWith('shape-'))) {
      const source = readFileSync(new URL(name, folder), 'utf8');
      const answer = source.slice(source.lastIndexOf('\nreturn '));
      for (const quoted of [/\.textContent(?!\.trim\(\)\)|\))/, /\.innerText/, /\.innerHTML/, /\.href\b/, /getAttribute\('(?:email|name|title|href)'\)(?! \|\| ''\)\.toLowerCase\(\) === me)/]) {
        const bare = answer.split('\n').filter((line) => quoted.test(line) && !/letters\(|\.length|=== me|Date\.parse|\/[a-z]*\.test\(/.test(line));
        expect({ name, bare }).toEqual({ name, bare: [] });
      }
    }
  });
});
