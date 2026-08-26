/**
 * The three hands the background reader gets.
 *
 * The point of this file is the negative space: what it CANNOT do. A
 * background agent running on a founder's machine while they are talking about
 * something else is the most dangerous thing in the trial, and the reason it is
 * acceptable is that its whole tool surface is three verbs, two of them fenced
 * to one folder and none of them able to touch the filesystem.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildReaderTools, readerContext, readerTask, type FoundEntities } from './reader-tools.ts';

let home: string;
let root: string;
let found: FoundEntities[];

function tools() {
  return buildReaderTools({
    folder: root,
    onFound: (f) => {
      found.push(f);
      const names = (f.entities ?? []).map((e) => e.name ?? '').filter(Boolean);
      return { landed: names.length, names };
    },
  });
}

function tool(name: string) {
  const t = tools().find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reader-'));
  root = join(home, 'Acme');
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'pitch.md'), '# Acme\nWe charge 40 a seat.', 'utf-8');
  writeFileSync(join(root, 'notes', 'standup.md'), 'Ana is on the front end.', 'utf-8');
  writeFileSync(join(home, 'secrets.txt'), 'do not read me', 'utf-8');
  found = [];
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('what the reader can do', () => {
  test('it has exactly three tools, and none of them writes to disk', () => {
    const names = tools().map((t) => t.name).sort();
    expect(names).toEqual(['list_folder', 'note_company', 'read_document']);
    // The names that would be dangerous are absent, not merely discouraged.
    for (const forbidden of ['write_file', 'run_command', 'read_file', 'list_directory', 'browser_navigate']) {
      expect(names).not.toContain(forbidden);
    }
  });

  test('it reads a file inside the folder', async () => {
    const out = await tool('read_document').execute({ path: 'pitch.md' });
    expect(String(out)).toContain('We charge 40 a seat');
  });

  test('it lists the folder without the noise directories', async () => {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    const out = String(await tool('list_folder').execute({ path: '.' }));
    expect(out).toContain('notes');
    expect(out).toContain('pitch.md');
    expect(out).not.toContain('node_modules');
  });

  test('the top of the folder is the default, so a missing path is not a missing fence', async () => {
    const out = String(await tool('list_folder').execute({}));
    expect(out).toContain('pitch.md');
  });
});

describe('what the reader cannot do', () => {
  test('every way out of the folder is refused, as an error the model can read', async () => {
    for (const escape of ['../secrets.txt', '../../etc/passwd', join(home, 'secrets.txt'), '/etc/hosts']) {
      const out = String(await tool('read_document').execute({ path: escape }));
      expect(out).toStartWith('Error:');
      expect(out).toContain('outside the folder you were given');
      expect(out).not.toContain('do not read me');
    }
  });

  test('listing outside the folder is refused too', async () => {
    const out = String(await tool('list_folder').execute({ path: '..' }));
    expect(out).toStartWith('Error:');
    expect(out).toContain('outside the folder you were given');
  });

  test('a binary file comes back as "cannot", never as guessed-at text', async () => {
    writeFileSync(join(root, 'deck.pdf'), '%PDF-1.7 binary', 'utf-8');
    const out = String(await tool('read_document').execute({ path: 'deck.pdf' }));
    expect(out).toContain('cannot be read as text');
    expect(out).toContain('rather than guessing');
  });
});

describe('note_company, which is how what it reads reaches the founder', () => {
  test('it hands findings straight out in `remember` shape', async () => {
    await tool('note_company').execute({
      entities: [{ name: 'Bowman & Co', type: 'project', role: 'client' }],
      facts: [{ about: 'Bowman & Co', detail: 'Renews in October.' }],
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.entities![0]!.name).toBe('Bowman & Co');
    expect(found[0]!.facts![0]!.detail).toBe('Renews in October.');
  });

  test('the result tells it to keep going, either way', async () => {
    const landed = String(await tool('note_company').execute({ entities: [{ name: 'Ana', type: 'person' }] }));
    expect(landed).toContain('Ana');
    expect(landed).toContain('Carry on reading');
    const nothing = String(await tool('note_company').execute({ entities: [] }));
    expect(nothing).toContain('already known');
    expect(nothing).toContain('Carry on reading');
  });
});

describe('what it is told to do', () => {
  test('the context names the fence, the files and the one rule', () => {
    const ctx = readerContext({ folder: root, shortlist: ['pitch.md', 'notes/standup.md'], about: 'A design studio.' });
    expect(ctx).toContain(root);
    expect(ctx).toContain('the only place you can read');
    expect(ctx).toContain('You cannot write anything');
    expect(ctx).toContain('- pitch.md');
    expect(ctx).toContain('- notes/standup.md');
    expect(ctx).toContain('A design studio.');
    // D22: as it goes, not in a batch at the end, because the founder is
    // watching the ticker while it works.
    expect(ctx).toContain('AS YOU GO');
    expect(ctx).toContain('never in one batch at the end');
    // And the rule that stops a finding being read back to a founder as
    // something from their own documents when it is not.
    expect(ctx).toContain('An invented finding is worse than an empty one');
  });

  test('a folder with nothing about the company has an answer that is not a guess', () => {
    const ctx = readerContext({ folder: root, shortlist: [], about: '' });
    expect(ctx).toContain('say exactly that and note nothing');
  });

  test('the task counts the files rather than saying "some"', () => {
    expect(readerTask(12)).toContain('12 files');
    expect(readerTask(1)).toContain('1 file to look at');
  });
});
