/**
 * Day one's look at the files of the person's own computer: what the
 * desktop app answered is checked, and what is said of it is counts, kinds
 * and names, never anything from inside a file.
 */
import { describe, expect, test } from 'bun:test';
import type { NotchPart } from '../notch/protocol.ts';
import { notchFilePlaces, notchFilesFound, notchFilesSay } from './notch-dayone.ts';

const text = (parts: NotchPart[] | undefined): string => (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');

const ANSWER = {
  places: [
    {
      place: 'desktop', reached: true, files: 14, folders: 3, shortcuts: 6, more: false,
      kinds: { sheet: 8, pdf: 3, picture: 2, other: 1 },
      recent: [{ name: 'Clients', kind: 'folder', changed: 5 }, { name: 'Budget Q4.xlsx', kind: 'sheet', changed: 4 }, { name: 'Pitch.pdf', kind: 'pdf', changed: 3 }],
    },
    { place: 'documents', reached: true, files: 1, folders: 0, shortcuts: 0, more: false, kinds: { document: 1 }, recent: [{ name: 'Contract.docx', kind: 'document', changed: 1 }] },
    { place: 'downloads', reached: false, files: 0, folders: 0, shortcuts: 0, more: false, kinds: {}, recent: [] },
  ],
};

describe('what the desktop app answered about the files', () => {
  test('is taken as it is when it is that answer', () => {
    const places = notchFilePlaces(ANSWER)!;
    expect(places.map((place) => `${place.place}:${place.reached}:${place.files}:${place.folders}`)).toEqual(['desktop:true:14:3', 'documents:true:1:0', 'downloads:false:0:0']);
    expect(places[0]!.recent).toEqual([{ name: 'Clients', kind: 'folder' }, { name: 'Budget Q4.xlsx', kind: 'sheet' }, { name: 'Pitch.pdf', kind: 'pdf' }]);
    expect(places[0]!.kinds).toEqual({ sheet: 8, pdf: 3, picture: 2, other: 1 });
  });

  test('anything else is not an answer, and nonsense inside one is dropped, not shown', () => {
    for (const bad of [null, 'files', {}, { places: 'many' }]) expect(notchFilePlaces(bad)).toBeNull();
    const odd = notchFilePlaces({ places: [
      null, { place: 'registry', reached: true, files: 9 },
      { place: 'desktop', reached: 'yes', files: -4, folders: 'three', kinds: { 'DROP TABLE': 4, sheet: Number.NaN }, recent: [{ name: 'a\nb\tc' }, { name: 7 }, null, { name: 'x'.repeat(400) }], more: 1 },
    ] })!;
    expect(odd.length).toBe(1);
    expect(odd[0]).toMatchObject({ place: 'desktop', reached: false, files: 0, folders: 0, kinds: { sheet: 0 }, more: false });
    expect(odd[0]!.recent.map((seen) => seen.name.length)).toEqual([5, 120]);
    expect(odd[0]!.recent[0]!.name).toBe('a b c');
  });
});

describe('what is said of a place', () => {
  const places = notchFilePlaces(ANSWER)!;
  test('the chip says how many files', () => {
    expect(places.map(notchFilesFound)).toEqual(['14 files', '1 file', 'not reached']);
    expect(notchFilesFound(undefined)).toBe('not reached');
    expect(notchFilesFound({ ...places[0]!, files: 0, folders: 0 })).toBe('empty');
    expect(notchFilesFound({ ...places[0]!, files: 2000, more: true })).toBe('over 2,000 files');
  });

  test('the sentence says how much is there, what most of it is, and the newest file by name', () => {
    expect(text(notchFilesSay(places[0]))).toBe('14 files and 3 folders. Mostly spreadsheets. The newest is Budget Q4.xlsx.');
    // One file is not "mostly" anything.
    expect(text(notchFilesSay(places[1]))).toBe('1 file. The newest is Contract.docx.');
    // A place that was not reached says nothing: its chip already did.
    expect(notchFilesSay(places[2])).toBeUndefined();
    expect(text(notchFilesSay({ ...places[0]!, files: 0, folders: 0 }))).toBe('Nothing is on it.');
  });

  test('no kind is named unless it is at least two files and four in ten of them', () => {
    expect(text(notchFilesSay({ ...places[0]!, files: 10, folders: 0, kinds: { sheet: 3, pdf: 3, picture: 4 }, recent: [] }))).toBe('10 files. Mostly pictures.');
    expect(text(notchFilesSay({ ...places[0]!, files: 10, folders: 0, kinds: { sheet: 3, pdf: 3, picture: 3, other: 1 }, recent: [] }))).toBe('10 files.');
    // What it has no word for is never called "mostly other".
    expect(text(notchFilesSay({ ...places[0]!, files: 4, folders: 0, kinds: { other: 4 }, recent: [] }))).toBe('4 files.');
  });
});
