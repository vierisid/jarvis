import { describe, expect, test } from 'bun:test';
import { browserDriveSearch, driveFileAddress, driveQuery, driveSearchPath } from './drive.ts';
import type { GmailPage } from './gmail.ts';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const sleep = async () => {};

function drive(answers: (asked: number, args: { query: string; most: number }) => unknown) {
  const calls: { name: string; args: unknown }[] = [];
  let asked = 0;
  const page: GmailPage = {
    run: async <T>(name: string, args?: unknown) => {
      calls.push({ name, args });
      if (name === 'site') return { there: false } as T;
      const answer = answers(++asked, args as { query: string; most: number });
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
  return { page, calls };
}

describe('what is searched for', () => {
  // The words come from a model that read a stranger's mail: they are words for a search box and nothing else.
  test('words only: nothing Drive would read as an instruction', () => {
    expect(driveQuery('  Northwind   pricing deck ')).toBe('Northwind pricing deck');
    expect(driveQuery('deck owner:eve@evil.example -"secret" type:pdf')).toBe('deck owner eve evil.example secret type pdf');
    expect(driveQuery('contratto firmato 2026 v2.1')).toBe('contratto firmato 2026 v2.1');
    expect(driveQuery('"" :: --')).toBe('');
    expect(driveQuery('x'.repeat(200)).length).toBe(80);
  });

  test('the search, in English, and where a found file is', () => {
    expect(driveSearchPath('Northwind pricing deck')).toBe('/drive/search?q=Northwind%20pricing%20deck&hl=en');
    expect(driveFileAddress({ id: ID })).toBe(`https://drive.google.com/open?id=${ID}`);
  });
});

describe('looking in Drive through the browser', () => {
  test('goes to the search and gives the files, the closest first', async () => {
    const { page, calls } = drive((_asked, args) => ({ state: 'read', files: [{ id: ID, name: ' Northwind  pricing deck v3 ', kind: 'Google Slides' }, { id: `${ID}x`, name: 'Pricing notes', kind: '' }], query: args.query }));
    expect(await browserDriveSearch(page, 'Northwind pricing deck', { sleep })).toEqual([
      { id: ID, name: 'Northwind pricing deck v3', kind: 'Google Slides' },
      { id: `${ID}x`, name: 'Pricing notes', kind: '' },
    ]);
    expect(calls[0]).toEqual({ name: 'site', args: { site: 'drive', path: '/drive/search?q=Northwind%20pricing%20deck&hl=en' } });
    expect(calls[1]).toEqual({ name: 'drive-search', args: { query: 'Northwind pricing deck', most: 8 } });
  });

  test('nothing found is an answer, not a failure', async () => {
    const { page } = drive(() => ({ state: 'read', files: [] }));
    expect(await browserDriveSearch(page, 'no such file', { sleep })).toEqual([]);
  });

  test('a browser that is not signed in, or words that are no search, give null: that way is not there', async () => {
    const out = drive(() => ({ state: 'signed-out' }));
    expect(await browserDriveSearch(out.page, 'deck', { sleep })).toBeNull();
    const none = drive(() => ({ state: 'read', files: [] }));
    expect(await browserDriveSearch(none.page, ' "" ', { sleep })).toBeNull();
    expect(none.calls).toEqual([]);
  });

  test('asks again while the page is on its way, and says so when the search never shows', async () => {
    const coming = drive((asked) => (asked === 1 ? new Error('the page changed') : asked === 2 ? { state: 'another-search' } : { state: 'read', files: [{ id: ID, name: 'Deck', kind: 'PDF' }] }));
    expect(await browserDriveSearch(coming.page, 'deck', { sleep })).toEqual([{ id: ID, name: 'Deck', kind: 'PDF' }]);
    const never = drive(() => ({ state: 'not-up' }));
    await expect(browserDriveSearch(never.page, 'deck', { sleep })).rejects.toThrow('did not show the search (not-up)');
  });

  test('a file the page gave badly is left out, and no more are kept than asked for', async () => {
    const { page } = drive(() => ({ state: 'read', files: [{ id: 'short', name: 'x' }, { id: ID, name: '' }, { id: ID, name: 'One', kind: 7 }, { id: `${ID}2`, name: 'Two', kind: 'PDF' }] }));
    expect(await browserDriveSearch(page, 'deck', { sleep, most: 1 })).toEqual([{ id: ID, name: 'One', kind: '' }]);
  });
});
