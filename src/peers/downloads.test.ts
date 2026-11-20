import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDownload } from './downloads.ts';

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
