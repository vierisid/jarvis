/**
 * The fences on the founder's own files.
 *
 * Two of these tests are the only thing standing between the trial and an
 * unrecoverable mistake on a real founder's machine, so they are written as
 * "prove it cannot" rather than "check it does": nothing outside the chosen
 * folder is ever touched, and nothing that was already there is ever replaced.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_READ_FILES,
  checkWorkspacePlan,
  createWorkspace,
  defaultWorkspacePath,
  describeSurvey,
  freshPath,
  insideRoot,
  listInside,
  readInside,
  resolveFounderFolder,
  surveyFolder,
  writeRevision,
} from './founder-files.ts';
import { UNIX_HOST } from './host-paths.ts';

let home: string;
let root: string;

function put(rel: string, body = 'x', ageDays = 0): string {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf-8');
  if (ageDays > 0) {
    const t = new Date(Date.now() - ageDays * 86_400_000);
    utimesSync(full, t, t);
  }
  return full;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trial-home-'));
  root = join(home, 'Acme');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/* ─────────────────── which folder, and which are refused ─────────────────── */

describe('resolveFounderFolder', () => {
  test('takes a real folder and resolves ~ against home', () => {
    expect(resolveFounderFolder(root, home)).toEqual({ ok: true, path: root });
    expect(resolveFounderFolder('~/Acme', home)).toEqual({ ok: true, path: root });
    expect(resolveFounderFolder('Acme', home)).toEqual({ ok: true, path: root });
  });

  test('refuses the home directory itself (D42: not the home directory)', () => {
    const v = resolveFounderFolder(home, home);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.why).toContain('home directory');
  });

  test('refuses the whole disk (D42: not the whole disk)', () => {
    const v = resolveFounderFolder('/', home);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.why).toContain('whole disk');
  });

  test('refuses system directories and keys', () => {
    expect(resolveFounderFolder('/etc', home).ok).toBe(false);
    expect(resolveFounderFolder('/usr/share', home).ok).toBe(false);
    expect(resolveFounderFolder(join(home, '.ssh'), home).ok).toBe(false);
  });

  test("refuses Jarvis's own vault, which is not something they told it", () => {
    const v = resolveFounderFolder(join(home, '.jarvis'), home);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.why).toContain('data directory');
  });

  test('a folder that does not exist, or a file, comes back as a sentence not a throw', () => {
    const missing = resolveFounderFolder(join(home, 'nope'), home);
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.why).toContain('no folder at');
    put('deck.md');
    const file = resolveFounderFolder(join(root, 'deck.md'), home);
    expect(file.ok).toBe(false);
    expect(file.ok === false && file.why).toContain('is a file');
  });

  test('an empty name is refused rather than resolving to the cwd', () => {
    expect(resolveFounderFolder('', home).ok).toBe(false);
    expect(resolveFounderFolder('   ', home).ok).toBe(false);
  });
});

/* ───────── the same question asked on three different machines ───────── */

describe('resolveFounderFolder knows which machine it is on', () => {
  let drive: string;
  let winDocs: string;

  beforeEach(() => {
    drive = mkdtempSync(join(tmpdir(), 'ff-drive-'));
    winDocs = join(drive, 'c', 'Users', 'vieri', 'Documents', 'Kestrel');
    mkdirSync(winDocs, { recursive: true });
  });

  afterEach(() => {
    rmSync(drive, { recursive: true, force: true });
  });

  test('UNDER WSL a Windows path finds the real folder', () => {
    const wsl = { kind: 'wsl' as const, driveRoot: drive };
    expect(resolveFounderFolder('C:\\Users\\vieri\\Documents\\Kestrel', home, wsl))
      .toEqual({ ok: true, path: winDocs });
    expect(resolveFounderFolder('C:/Users/vieri/Documents/Kestrel', home, wsl))
      .toEqual({ ok: true, path: winDocs });
  });

  test('ON LINUX it does not, and says where it looked', () => {
    const v = resolveFounderFolder('C:\\Users\\vieri\\Documents\\Kestrel', home, UNIX_HOST);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.tried).toEqual([join(home, 'C:\\Users\\vieri\\Documents\\Kestrel')]);
  });

  test('a folder that is not there says every place it looked', () => {
    const wsl = { kind: 'wsl' as const, driveRoot: drive };
    const v = resolveFounderFolder('Nowhere', home, wsl);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.tried).toContain(join(home, 'Nowhere'));
    expect(v.ok === false && v.tried).toContain(join(drive, 'c', 'Users', 'vieri', 'Nowhere'));
  });

  test('the fence still holds on the Windows side', () => {
    const wsl = { kind: 'wsl' as const, driveRoot: drive };
    for (const [said, why] of [
      ['C:\\', 'whole of that drive'],
      ['C:\\Users', 'every account'],
      ['C:\\Users\\vieri', 'Windows home directory'],
    ] as const) {
      const v = resolveFounderFolder(said, home, wsl);
      expect(v.ok).toBe(false);
      expect(v.ok === false && v.why).toContain(why);
    }
  });
});

describe('insideRoot is the only path check the reader makes', () => {
  test('the root itself and anything under it are inside', () => {
    expect(insideRoot(root, root)).toBe(true);
    expect(insideRoot(root, join(root, 'a/b/c.md'))).toBe(true);
    expect(insideRoot(root, 'sub/thing.md')).toBe(true);
  });

  test('traversal out of the root is not inside', () => {
    expect(insideRoot(root, '../secrets.txt')).toBe(false);
    expect(insideRoot(root, join(home, 'other'))).toBe(false);
    expect(insideRoot(root, '/etc/passwd')).toBe(false);
  });

  test('a sibling whose name merely starts with the root is not inside', () => {
    expect(insideRoot(root, `${root}-backup/x.md`)).toBe(false);
  });
});

/* ─────────────────────────── the survey ─────────────────────────── */

describe('surveyFolder', () => {
  test('counts everything and shortlists only what it can open', () => {
    put('pitch.md');
    put('numbers.csv');
    put('deck.pdf');
    put('logo.png');
    put('notes/standup.md');
    const s = surveyFolder(root);
    expect(s.files.length).toBe(5);
    expect(s.readableCount).toBe(3);
    expect(s.opaqueCount).toBe(2);
    expect(s.folders).toContain('notes');
    expect(s.shortlist.every((f) => f.readable)).toBe(true);
  });

  test('the shortlist is newest first, because this month is the company', () => {
    put('old.md', 'x', 400);
    put('recent.md', 'x', 1);
    const s = surveyFolder(root);
    expect(s.shortlist[0]!.rel).toBe('recent.md');
  });

  test('skips node_modules and dotfiles rather than reading a checked-out repo', () => {
    put('node_modules/left-pad/index.md');
    put('.env', 'SECRET=1');
    put('real.md');
    const s = surveyFolder(root);
    expect(s.files.map((f) => f.rel)).toEqual(['real.md']);
    expect(s.folders).not.toContain('node_modules');
  });

  test('5,000 files: all of them counted, only MAX_READ_FILES shortlisted', () => {
    for (let i = 0; i < 120; i++) put(`bulk/f${i}.md`, 'x');
    const s = surveyFolder(root);
    expect(s.files.length).toBe(120);
    expect(s.readableCount).toBe(120);
    expect(s.shortlist.length).toBe(MAX_READ_FILES);
    expect(describeSurvey(s)).toContain(`the ${MAX_READ_FILES} most recent of 120`);
  });

  test('an empty folder says so, and has nothing to read', () => {
    const s = surveyFolder(root);
    expect(s.files.length).toBe(0);
    expect(s.shortlist.length).toBe(0);
    expect(describeSurvey(s)).toBe('it is empty');
  });

  test('a folder of nothing but PDFs is honest about not being able to open them', () => {
    put('a.pdf');
    put('b.pdf');
    const s = surveyFolder(root);
    expect(s.shortlist.length).toBe(0);
    expect(describeSurvey(s)).toContain('none of them in a format that can be opened');
    expect(describeSurvey(s)).toContain('2 PDF or document files can be seen but not opened');
  });

  test('depth is bounded and the truncation is reported, not hidden', () => {
    put('a/b/c/d/e/f/deep.md');
    const s = surveyFolder(root);
    expect(s.truncated).toBe(true);
    expect(s.files.some((f) => f.rel.endsWith('deep.md'))).toBe(false);
    expect(describeSurvey(s)).toContain('stopped early');
    expect(describeSurvey(s)).not.toBe('it is empty');
  });
});

/* ─────────────────────── reading, inside the fence ─────────────────────── */

describe('readInside / listInside', () => {
  test('reads a file inside the folder', () => {
    put('pitch.md', '# Acme\nWe sell things.');
    const r = readInside(root, 'pitch.md');
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.text).toContain('We sell things');
  });

  test('refuses to escape the folder, however the path is written', () => {
    writeFileSync(join(home, 'secrets.txt'), 'do not read me');
    for (const attempt of ['../secrets.txt', '../../etc/passwd', join(home, 'secrets.txt'), '/etc/hosts']) {
      const r = readInside(root, attempt);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.why).toContain('outside the folder you were given');
    }
  });

  test('refuses a binary file rather than handing back mojibake', () => {
    put('deck.pdf', '%PDF-1.4 binary');
    const r = readInside(root, 'deck.pdf');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain('cannot be read as text');
  });

  test('truncates a huge file at the cap and says so', () => {
    put('big.md', 'a'.repeat(5000));
    const r = readInside(root, 'big.md', 100);
    expect(r.ok === true && r.text.length).toBeLessThan(200);
    expect(r.ok === true && r.text).toContain('truncated');
  });

  test('listing is fenced the same way, and hides the noise directories', () => {
    put('notes/one.md');
    put('node_modules/x/y.md');
    const inside = listInside(root, '.');
    expect(inside.ok === true && inside.text).toContain('notes');
    expect(inside.ok === true && inside.text).not.toContain('node_modules');
    expect(listInside(root, '..').ok).toBe(false);
  });
});

/* ─────────────── D43 · the organised copy, and what it refuses ─────────────── */

describe('checkWorkspacePlan refuses before anything is created', () => {
  const plan = (destination: string, source = root) => ({
    destination,
    source,
    title: 'Acme',
    sections: [{ name: 'company', about: 'what it is', files: [] }],
  });

  test('refuses a destination that already has anything in it', () => {
    const dest = join(home, 'Acme organised');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'mine.md'), 'my work');
    const v = checkWorkspacePlan(plan(dest));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.why).toContain('already exists and has things in it');
    expect(readFileSync(join(dest, 'mine.md'), 'utf-8')).toBe('my work');
  });

  test('accepts a destination that exists but is empty', () => {
    const dest = join(home, 'empty-dest');
    mkdirSync(dest, { recursive: true });
    expect(checkWorkspacePlan(plan(dest)).ok).toBe(true);
  });

  test('refuses a copy of a folder into itself, in either direction', () => {
    expect(checkWorkspacePlan(plan(root)).ok).toBe(false);
    expect(checkWorkspacePlan(plan(join(root, 'organised'))).ok).toBe(false);
    const v = checkWorkspacePlan(plan(home));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.why).toContain('it is a move');
  });

  test('refuses a plan with no sections', () => {
    const v = checkWorkspacePlan({ destination: join(home, 'x'), source: root, title: 'Acme', sections: [] });
    expect(v.ok).toBe(false);
  });

  test('the default destination sits beside the source, never inside it', () => {
    const d = defaultWorkspacePath(root, 'Acme');
    expect(insideRoot(root, d)).toBe(false);
    expect(d.startsWith(home)).toBe(true);
    expect(checkWorkspacePlan(plan(d)).ok).toBe(true);
  });
});

describe('createWorkspace never moves and never replaces', () => {
  test('copies, leaves every original exactly where it was', () => {
    put('pitch.md', '# pitch');
    put('numbers/q3.csv', 'a,b');
    const dest = join(home, 'Acme organised');
    const v = checkWorkspacePlan({
      destination: dest,
      source: root,
      title: 'Acme',
      sections: [
        { name: 'story', about: 'the pitch', files: ['pitch.md'] },
        { name: 'numbers', about: 'the money', files: ['numbers/q3.csv'] },
      ],
    });
    expect(v.ok).toBe(true);
    const r = createWorkspace(v.ok === true ? v.plan : ({} as never));

    expect(r.copied).toBe(2);
    // Originals untouched.
    expect(readFileSync(join(root, 'pitch.md'), 'utf-8')).toBe('# pitch');
    expect(readFileSync(join(root, 'numbers/q3.csv'), 'utf-8')).toBe('a,b');
    expect(statSync(join(root, 'pitch.md')).isFile()).toBe(true);
    // Copies present.
    expect(readFileSync(join(dest, 'story/pitch.md'), 'utf-8')).toBe('# pitch');
    expect(readFileSync(join(dest, 'numbers/q3.csv'), 'utf-8')).toBe('a,b');
    // And an index that says the originals are untouched.
    const readme = readFileSync(join(dest, 'README.md'), 'utf-8');
    expect(readme).toContain('Nothing was moved and nothing was deleted');
    expect(readme).toContain(root);
  });

  test('a file it was told to copy from outside the folder is skipped, not copied', () => {
    writeFileSync(join(home, 'secrets.txt'), 'nope');
    put('pitch.md', '# pitch');
    const dest = join(home, 'Acme organised');
    const r = createWorkspace({
      destination: dest,
      source: root,
      title: 'Acme',
      sections: [{ name: 'story', about: 'x', files: ['pitch.md', '../secrets.txt'] }],
    });
    expect(r.copied).toBe(1);
    expect(r.skipped).toEqual([{ rel: '../secrets.txt', why: 'outside the folder you were given' }]);
    expect(readdirSync(join(dest, 'story'))).toEqual(['pitch.md']);
  });

  test('two originals with the same name both survive, neither is overwritten', () => {
    put('a/deck.md', 'first');
    put('b/deck.md', 'second');
    const dest = join(home, 'Acme organised');
    const r = createWorkspace({
      destination: dest,
      source: root,
      title: 'Acme',
      sections: [{ name: 'decks', about: 'x', files: ['a/deck.md', 'b/deck.md'] }],
    });
    expect(r.copied).toBe(2);
    const names = readdirSync(join(dest, 'decks')).sort();
    expect(names).toEqual(['deck (2).md', 'deck.md']);
    const bodies = names.map((n) => readFileSync(join(dest, 'decks', n), 'utf-8')).sort();
    expect(bodies).toEqual(['first', 'second']);
  });

  test('what it could not copy is written down, not swallowed', () => {
    put('there.md', 'x');
    const dest = join(home, 'Acme organised');
    const r = createWorkspace({
      destination: dest,
      source: root,
      title: 'Acme',
      sections: [{ name: 'all', about: 'x', files: ['there.md', 'gone.md'] }],
    });
    expect(r.skipped).toEqual([{ rel: 'gone.md', why: 'no longer there' }]);
    expect(readFileSync(join(dest, 'README.md'), 'utf-8')).toContain('Not copied');
  });
});

describe('writeRevision writes beside, never over', () => {
  test('the revision is a new file and the original is byte-identical afterwards', () => {
    const dir = join(home, 'Acme organised', 'story');
    mkdirSync(dir, { recursive: true });
    const original = put('deck.html', '<h1>old</h1>');
    const r = writeRevision({ intoDir: dir, originalName: 'deck.html', label: 'rewritten', body: '<h1>new</h1>' });
    expect(r.path).toBe(join(dir, 'deck - rewritten.html'));
    expect(readFileSync(r.path, 'utf-8')).toBe('<h1>new</h1>');
    expect(readFileSync(original, 'utf-8')).toBe('<h1>old</h1>');
  });

  test('a second revision of the same page does not clobber the first', () => {
    const dir = join(home, 'rev');
    writeRevision({ intoDir: dir, originalName: 'deck.html', label: 'rewritten', body: 'one' });
    const second = writeRevision({ intoDir: dir, originalName: 'deck.html', label: 'rewritten', body: 'two' });
    expect(second.path).toContain('(2)');
    expect(readFileSync(join(dir, 'deck - rewritten.html'), 'utf-8')).toBe('one');
  });
});

describe('freshPath', () => {
  test('never returns a path that exists', () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.md'), '1');
    writeFileSync(join(root, 'a (2).md'), '2');
    expect(freshPath(root, 'a.md')).toBe(join(root, 'a (3).md'));
  });
});
