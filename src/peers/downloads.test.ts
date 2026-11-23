import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { APP_SAVE_PART, appFound, saveDownload, saveThroughApp } from './downloads.ts';
import type { AppRpc } from './downloads.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'peers-downloads-'));
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('a file that arrived is saved', () => {
  test('under its name, into a folder that may not be there yet', () => {
    const root = join(dir(), 'Downloads');
    expect(saveDownload(root, 'deck.pdf', bytes('one'))).toEqual({ name: 'deck.pdf' });
    expect(readFileSync(join(root, 'deck.pdf'), 'utf8')).toBe('one');
  });

  test('never over something that is there', () => {
    const root = dir();
    writeFileSync(join(root, 'deck.pdf'), 'mine');
    expect(saveDownload(root, 'deck.pdf', bytes('theirs'))).toEqual({ name: 'deck (2).pdf' });
    expect(saveDownload(root, 'deck.pdf', bytes('again'))).toEqual({ name: 'deck (3).pdf' });
    expect(readFileSync(join(root, 'deck.pdf'), 'utf8')).toBe('mine');
    expect(readFileSync(join(root, 'deck (2).pdf'), 'utf8')).toBe('theirs');
    expect(saveDownload(root, 'notes', bytes('x'))).toEqual({ name: 'notes' });
    expect(saveDownload(root, 'notes', bytes('y'))).toEqual({ name: 'notes (2)' });
  });

  test('inside the folder, whatever the name says', () => {
    const root = join(dir(), 'Downloads');
    expect(saveDownload(root, '../../outside.txt', bytes('x'))).toEqual({ name: 'outside.txt' });
    expect(saveDownload(root, 'C:\\Windows\\System32\\drivers\\etc\\hosts', bytes('x'))).toEqual({ name: 'hosts' });
    expect(saveDownload(root, '/etc/passwd', bytes('x'))).toEqual({ name: 'passwd' });
    expect(saveDownload(root, '...', bytes('x'))).toEqual({ name: 'file' });
    expect(saveDownload(root, '.bashrc', bytes('x'))).toEqual({ name: 'bashrc' });
    expect(readdirSync(root).sort()).toEqual(['bashrc', 'file', 'hosts', 'outside.txt', 'passwd']);
    expect(readdirSync(join(root, '..'))).toEqual(['Downloads']);
  });

  test('not under a name a Windows folder keeps for itself', () => {
    const root = dir();
    expect(saveDownload(root, 'CON.txt', bytes('x'))).toEqual({ name: 'file CON.txt' });
    expect(saveDownload(root, 'nul', bytes('x'))).toEqual({ name: 'file nul' });
    expect(saveDownload(root, 'console.txt', bytes('x'))).toEqual({ name: 'console.txt' });
  });

  test('says so when it cannot be', () => {
    const root = dir();
    writeFileSync(join(root, 'not-a-folder'), '');
    expect(saveDownload(join(root, 'not-a-folder'), 'deck.pdf', bytes('x'))).toBeNull();
  });
});

describe('saving through the desktop app', () => {
  /** A stand-in for the app's command: it notes what it was asked and puts the pieces together. */
  function app(more: { refuseAt?: 'begin' | 'part' | 'end'; throwAt?: 'part'; savedAs?: string } = {}) {
    const steps: string[] = [];
    const pieces: Buffer[] = [];
    let size = 0;
    let name = '';
    let endSha = '';
    const rpc: AppRpc = async (method, params) => {
      const step = String(params.step);
      steps.push(`${method} ${step}`);
      if (more.refuseAt === step) return { saved: false, why: 'no' };
      if (more.throwAt === step) throw new Error('the line broke');
      if (step === 'begin') { name = String(params.name); size = Number(params.size); return { id: 'abcdef0123456789abcdef01' }; }
      if (step === 'part') { pieces.push(Buffer.from(String(params.data), 'base64')); return { taken: true }; }
      if (step === 'end') { endSha = String(params.sha); return { saved: true, name: more.savedAs ?? name, place: 'downloads' }; }
      return { dropped: true };
    };
    return { rpc, steps, pieces, get: () => ({ size, name, endSha, whole: Buffer.concat(pieces) }) };
  }
  const data = (size: number): Uint8Array => { const out = new Uint8Array(size); for (let n = 0; n < size; n++) out[n] = (n * 13) % 251; return out; };

  test('hands it over in pieces, with its size first and what it adds up to last', async () => {
    const it = app({ savedAs: 'deck (2).pdf' });
    const whole = data(APP_SAVE_PART * 2 + 700);
    // The name the app chose is the one that is told: something of that name was there already.
    expect(await saveThroughApp(it.rpc, '../deck.pdf', whole)).toEqual({ name: 'deck (2).pdf' });
    expect(it.steps).toEqual(['notch.save begin', 'notch.save part', 'notch.save part', 'notch.save part', 'notch.save end']);
    expect(it.get().name).toBe('deck.pdf');
    expect(it.get().size).toBe(whole.length);
    expect(it.pieces.map((one) => one.length)).toEqual([APP_SAVE_PART, APP_SAVE_PART, 700]);
    expect(it.get().whole.equals(Buffer.from(whole))).toBe(true);
    expect(it.get().endSha).toBe(createHash('sha256').update(whole).digest('hex'));
  });

  test('says so when the app does not save it', async () => {
    for (const refuseAt of ['begin', 'part', 'end'] as const) expect(await saveThroughApp(app({ refuseAt }).rpc, 'deck.pdf', data(1000))).toBeNull();
    // An app from before this does not know the command at all.
    await expect(saveThroughApp(async () => { throw new Error('unknown method'); }, 'deck.pdf', data(1000))).rejects.toThrow();
    // The line broke in the middle: the app is told to let go of what it has.
    const broke = app({ throwAt: 'part' });
    expect(await saveThroughApp(broke.rpc, 'deck.pdf', data(1000))).toBeNull();
    expect(broke.steps).toEqual(['notch.save begin', 'notch.save part', 'notch.save drop']);
    // A name that comes back odd is made readable like any other.
    expect(await saveThroughApp(app({ savedAs: '..\\..\\x<y>.pdf' }).rpc, 'deck.pdf', data(1000))).toEqual({ name: 'xy.pdf' });
  });
});

describe('what the desktop app found', () => {
  test('is taken field by field', () => {
    expect(appFound({ found: [
      { place: 'documents', dir: 'Pitch/Decks', name: 'Pillow v30.pdf', kind: 'pdf', size: 184320, changed: 1795000000000, score: 13 },
      { place: 'desktop', name: 'Deck, November.pdf', kind: 'pdf', size: 10 },
    ] })).toEqual([
      { place: 'documents', dir: 'Pitch/Decks', name: 'Pillow v30.pdf', kind: 'pdf', size: 184320, changed: 1795000000000, score: 13 },
      { place: 'desktop', dir: '', name: 'Deck, November.pdf', kind: 'pdf', size: 10, changed: 0, score: 0 },
    ]);
    expect(appFound({ found: [] })).toEqual([]);
    expect(appFound(null)).toBeNull();
    expect(appFound({ places: [] })).toBeNull();
  });

  test('nothing that is not a plain name in one of the three places', () => {
    expect(appFound({ found: [
      { place: 'system', name: 'hosts', kind: 'other', size: 10 },
      { place: 'desktop', name: '../secret.txt', kind: 'document', size: 10 },
      { place: 'desktop', name: 'a\\b.txt', kind: 'document', size: 10 },
      { place: 'desktop', name: 'line\nbreak.txt', kind: 'document', size: 10 },
      { place: 'desktop', name: '', kind: 'document', size: 10 },
      { place: 'desktop', name: 'empty.txt', kind: 'document', size: 0 },
      { place: 'desktop', name: 'no size.txt', kind: 'document' },
      { place: 'desktop', name: 7, kind: 'document', size: 10 },
      'not a file',
    ] })).toEqual([]);
  });

  test('a folder below the place is one or two plain folder names, or the file is not taken', () => {
    const one = (dir: unknown) => appFound({ found: [{ place: 'documents', dir, name: 'deck.pdf', kind: 'pdf', size: 10 }] });
    expect(one('Pitch')![0]!.dir).toBe('Pitch');
    expect(one('Pitch/Decks 2026')![0]!.dir).toBe('Pitch/Decks 2026');
    expect(one('')![0]!.dir).toBe('');
    for (const bad of ['..', 'Pitch/..', '../Pitch', '/etc', 'Pitch//Decks', 'a/b/c', '.hidden', 'Pitch/.git', 'Pi\\tch', 'Pitch\nDecks', 7, 'x'.repeat(500)]) expect(one(bad)).toEqual([]);
  });

  test('a score and a date that are no numbers are nought, and a kind is a plain word', () => {
    expect(appFound({ found: [{ place: 'desktop', name: 'deck.pdf', kind: 'pdf<script>', size: 10, changed: 'yesterday', score: -5 }] }))
      .toEqual([{ place: 'desktop', dir: '', name: 'deck.pdf', kind: 'pdfscript', size: 10, changed: 0, score: 0 }]);
  });
});
