/**
 * The founder's own files: surveying a folder they chose, reading inside it,
 * and building a better-organised copy alongside it.
 *
 * This is D42 and D43, and it is the most invasive thing in the trial. Every
 * fence that matters is in this file, in code, because the two rules it has to
 * keep are the two that cannot be recovered from if a sentence in a prompt is
 * ignored:
 *
 *   1. NOTHING OUTSIDE THE FOLDER THEY NAMED IS EVER TOUCHED. `insideRoot` is
 *      the only path check, every read goes through `readInside`, and the
 *      background reader's tools are built from those rather than from the
 *      general-purpose `read_file` / `list_directory`, which resolve against
 *      the home directory and happily take an absolute path anywhere on disk.
 *
 *   2. THE ORIGINALS ARE NEVER MOVED, OVERWRITTEN OR DELETED. This module
 *      imports `mkdirSync`, `copyFileSync` and `writeFileSync` and nothing
 *      else: there is no `rename`, no `rm`, no `unlink` anywhere in it, so the
 *      destructive version cannot be written by accident. Every write goes to
 *      a NEW path, and a destination that already has anything in it is
 *      refused rather than merged into.
 *
 * A trial that reorganises a founder's real files and gets it wrong is
 * unrecoverable and unforgivable, so the design is: copy, never move; create,
 * never replace; and refuse rather than guess.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/* ─────────────────────────── the fence ─────────────────────────── */

/** Directories that are never worth reading and are usually most of the disk. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.svn', '.hg', '.venv', 'venv', 'env', '__pycache__',
  'dist', 'build', 'out', '.next', '.nuxt', 'target', '.cache', 'vendor',
  '.idea', '.vscode', '.gradle', 'Pods', 'DerivedData', '.terraform',
]);

/** What the reader can actually open and understand. */
export const READABLE_EXTS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.rst', '.org', '.tex',
  '.csv', '.tsv', '.json', '.yaml', '.yml', '.toml',
  '.html', '.htm', '.xml',
]);

/** Seen and counted and named out loud, but not opened. Saying "and 14 PDFs I
 *  cannot read" is part of naming what will be read honestly. */
export const OPAQUE_EXTS: ReadonlySet<string> = new Set([
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
  '.key', '.pages', '.numbers', '.odt', '.ods', '.odp',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.heic',
  '.mp4', '.mov', '.mp3', '.wav', '.zip', '.tar', '.gz', '.dmg',
]);

/** How deep the survey and the reader go. Four levels covers how a founder
 *  actually files things and stops before a checked-out repo eats the walk. */
export const MAX_DEPTH = 4;
/** Hard cap on entries visited by one survey, so a 200,000-file folder is a
 *  truncated answer in a second rather than a hung conversation. */
export const MAX_SURVEY_ENTRIES = 20_000;
/** How many readable files the reader is pointed at. Everything beyond this is
 *  reported as not read, never silently dropped. */
export const MAX_READ_FILES = 40;
/** How many files the organised copy will take. */
export const MAX_COPY_FILES = 200;
/** Per-file ceiling for a copy, so one 4GB video does not become two. */
export const MAX_COPY_BYTES = 25 * 1024 * 1024;

/**
 * Roots that are never a "folder about the startup", whatever anyone says out
 * loud. D42 is explicit: scoped to a folder the founder chooses, NOT the home
 * directory and not the whole disk.
 */
function isForbiddenRoot(path: string, home: string): string | null {
  const norm = path.replace(/[/\\]+$/, '') || sep;
  if (norm === sep || /^[A-Za-z]:\\?$/.test(norm)) return 'the whole disk';
  if (norm === home.replace(/[/\\]+$/, '')) return 'your home directory';
  for (const p of ['/etc', '/usr', '/var', '/bin', '/sbin', '/lib', '/opt', '/proc', '/sys', '/dev', '/boot', '/root']) {
    if (norm === p || norm.startsWith(p + sep)) return 'a system directory';
  }
  // The vault and the secrets live here. Reading them back to the founder as
  // "what I found out about your company" would be a party trick and a leak.
  if (norm === join(home, '.jarvis') || norm.startsWith(join(home, '.jarvis') + sep)) return "Jarvis's own data directory";
  if (/(^|[/\\])\.ssh([/\\]|$)/.test(norm)) return 'your keys';
  return null;
}

export type FolderVerdict =
  | { ok: true; path: string }
  | { ok: false; why: string };

/**
 * Turn what the founder said into a folder, or into a sentence explaining why
 * it is not one. Never throws: every rejection is something Jarvis can say.
 */
export function resolveFounderFolder(raw: string, home = homedir()): FolderVerdict {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, why: 'they did not name a folder' };
  const expanded = trimmed === '~' ? home : trimmed.startsWith('~/') ? join(home, trimmed.slice(2)) : trimmed;
  const path = resolve(home, expanded);

  const forbidden = isForbiddenRoot(path, home);
  if (forbidden) return { ok: false, why: `that is ${forbidden}, which is too broad to hand over` };

  if (!existsSync(path)) return { ok: false, why: `there is no folder at ${path}` };
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { ok: false, why: `${path} could not be opened` };
  }
  if (!stat.isDirectory()) return { ok: false, why: `${path} is a file, not a folder` };
  return { ok: true, path };
}

/** Is `candidate` inside `root`? The only path check the reader ever makes. */
export function insideRoot(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(root, candidate);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/* ─────────────────────────── the survey ─────────────────────────── */

export type SurveyFile = {
  /** Relative to the root, which is the only form the founder should ever see. */
  rel: string;
  bytes: number;
  readable: boolean;
  modified: number;
};

export type FolderSurvey = {
  root: string;
  files: SurveyFile[];
  folders: string[];
  /** Readable files, newest first, capped at MAX_READ_FILES. */
  shortlist: SurveyFile[];
  readableCount: number;
  opaqueCount: number;
  otherCount: number;
  /** Extensions present, commonest first, as ".pdf" style strings. */
  kinds: { ext: string; n: number }[];
  /** True when the walk hit MAX_SURVEY_ENTRIES or MAX_DEPTH and stopped early. */
  truncated: boolean;
};

/**
 * Walk the folder once and describe it, so the approval can NAME what will be
 * read rather than asking for a blank cheque.
 *
 * Bounded on purpose in three directions: depth, total entries, and the
 * shortlist. A founder who points at a folder with 5,000 files gets a truthful
 * count of all 5,000 and a shortlist of the 40 the reader will actually open.
 */
export function surveyFolder(root: string, now = Date.now()): FolderSurvey {
  const files: SurveyFile[] = [];
  const folders: string[] = [];
  const kinds = new Map<string, number>();
  let visited = 0;
  let truncated = false;
  /** The entry cap aborts the whole walk; depth only prunes that branch, so a
   *  single deeply-nested subfolder cannot hide the files sitting at the top. */
  let capped = false;

  const walk = (dir: string, depth: number): void => {
    if (capped) return;
    if (depth > MAX_DEPTH) { truncated = true; return; }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable subtree: not an error, just not ours
    }
    for (const name of entries) {
      if (visited >= MAX_SURVEY_ENTRIES) { truncated = true; capped = true; return; }
      visited++;
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      const rel = full.slice(root.length + 1);
      if (stat.isDirectory()) {
        if (SKIPPED_DIRS.has(name)) continue;
        folders.push(rel);
        walk(full, depth + 1);
        if (capped) return;
        continue;
      }
      if (!stat.isFile()) continue;
      const ext = extname(name).toLowerCase();
      kinds.set(ext || '(none)', (kinds.get(ext || '(none)') ?? 0) + 1);
      files.push({ rel, bytes: stat.size, readable: READABLE_EXTS.has(ext), modified: stat.mtimeMs });
    }
  };
  walk(root, 1);

  const readable = files.filter((f) => f.readable);
  const opaqueCount = files.filter((f) => OPAQUE_EXTS.has(extname(f.rel).toLowerCase())).length;
  return {
    root,
    files,
    folders,
    // Newest first: the things a founder touched this month are what their
    // company is, and the 2019 invoice is not.
    shortlist: [...readable].sort((a, b) => b.modified - a.modified).slice(0, MAX_READ_FILES),
    readableCount: readable.length,
    opaqueCount,
    otherCount: files.length - readable.length - opaqueCount,
    kinds: [...kinds.entries()].map(([ext, n]) => ({ ext, n })).sort((a, b) => b.n - a.n),
    truncated,
  };
}

/** One sentence naming what will be read, for the approval and the card. */
export function describeSurvey(s: FolderSurvey): string {
  if (s.files.length === 0) {
    // "It is empty" would be a lie when the walk stopped before it got to
    // anything, and the founder is about to be told what their folder holds.
    return s.truncated
      ? 'nothing at the top of it, and it is nested deep enough that the survey stopped early'
      : 'it is empty';
  }
  const parts: string[] = [`${s.files.length} file${s.files.length === 1 ? '' : 's'}`];
  if (s.folders.length > 0) parts.push(`${s.folders.length} folder${s.folders.length === 1 ? '' : 's'}`);
  const willRead = s.shortlist.length;
  let out = parts.join(' in ');
  out += willRead === 0
    ? ', none of them in a format that can be opened'
    : `, of which ${willRead === s.readableCount ? `${willRead}` : `the ${willRead} most recent of ${s.readableCount}`} would be read`;
  if (s.opaqueCount > 0) out += `; ${s.opaqueCount} PDF or document file${s.opaqueCount === 1 ? '' : 's'} can be seen but not opened`;
  if (s.truncated) out += '; the folder is deep enough that the survey stopped early';
  return out;
}

/* ─────────────────────── reading, inside the fence ─────────────────────── */

export type ReadOutcome = { ok: true; text: string } | { ok: false; why: string };

/** List one directory, refusing anything outside the root. */
export function listInside(root: string, rel: string): ReadOutcome {
  const target = resolve(root, rel || '.');
  if (!insideRoot(root, target)) return { ok: false, why: `${rel} is outside the folder you were given.` };
  if (!existsSync(target)) return { ok: false, why: `${rel} does not exist.` };
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return { ok: false, why: `${rel} could not be opened.` };
  }
  if (!stat.isDirectory()) return { ok: false, why: `${rel} is a file, not a folder.` };
  let entries: string[];
  try {
    entries = readdirSync(target);
  } catch {
    return { ok: false, why: `${rel} could not be listed.` };
  }
  const lines: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (SKIPPED_DIRS.has(name)) continue;
    try {
      const st = statSync(join(target, name));
      lines.push(st.isDirectory() ? `dir   ${name}` : `file  ${name} (${st.size} bytes)`);
    } catch {
      /* skip */
    }
  }
  return { ok: true, text: lines.length > 0 ? lines.join('\n') : '(empty)' };
}

/** Read one file, refusing anything outside the root or anything binary. */
export function readInside(root: string, rel: string, maxBytes = 100 * 1024): ReadOutcome {
  const target = resolve(root, rel);
  if (!insideRoot(root, target)) return { ok: false, why: `${rel} is outside the folder you were given.` };
  if (!existsSync(target)) return { ok: false, why: `${rel} does not exist.` };
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return { ok: false, why: `${rel} could not be opened.` };
  }
  if (stat.isDirectory()) return { ok: false, why: `${rel} is a folder, not a file.` };
  const ext = extname(target).toLowerCase();
  if (!READABLE_EXTS.has(ext)) {
    return { ok: false, why: `${rel} is a ${ext || 'binary'} file and cannot be read as text. Say so rather than guessing at what is in it.` };
  }
  try {
    const raw = readFileSync(target, 'utf-8');
    return { ok: true, text: raw.length > maxBytes ? `${raw.slice(0, maxBytes)}\n... [truncated at ${maxBytes} bytes]` : raw };
  } catch (err) {
    return { ok: false, why: `${rel} could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/* ────────────────── D43 · the organised copy, alongside ────────────────── */

export type WorkspaceSection = {
  /** Folder name inside the new workspace, in the founder's language. */
  name: string;
  /** One line on what belongs in it. */
  about: string;
  /** Paths relative to the source root that get COPIED into it. */
  files: string[];
};

export type WorkspacePlan = {
  /** Where the new folder goes. Never inside the source root's parent chain
   *  in a way that would shadow it; always a new, empty path. */
  destination: string;
  /** The folder the material came from. Untouched, always. */
  source: string;
  title: string;
  sections: WorkspaceSection[];
};

export type WorkspaceResult = {
  destination: string;
  copied: number;
  skipped: { rel: string; why: string }[];
  sections: number;
};

/**
 * Where the organised folder goes, when the founder has not named a place.
 * Beside the source, never inside it: a folder that contains a reorganised
 * copy of itself is how the next survey ends up reading its own output.
 */
export function defaultWorkspacePath(source: string, company: string): string {
  const clean = (company || basename(source) || 'Company').replace(/[/\\:*?"<>|]/g, '').trim() || 'Company';
  return join(dirname(resolve(source)), `${clean} (organised by Jarvis)`);
}

export type PlanVerdict = { ok: true; plan: WorkspacePlan } | { ok: false; why: string };

/**
 * Check a plan before anything is created. Every refusal here is a sentence
 * Jarvis can say, and every one of them exists because the alternative is
 * damage: writing into a folder that already has the founder's work in it,
 * or nesting the copy inside the thing being copied.
 */
export function checkWorkspacePlan(plan: WorkspacePlan): PlanVerdict {
  const destination = resolve(plan.destination);
  const source = resolve(plan.source);
  if (destination === source) return { ok: false, why: 'the new folder cannot be the folder it is copying from' };
  if (insideRoot(source, destination)) {
    return { ok: false, why: 'the new folder would sit inside the folder it is copying from, which would make it copy itself next time' };
  }
  if (insideRoot(destination, source)) {
    return { ok: false, why: 'the new folder would contain the original folder, which is not a copy, it is a move' };
  }
  if (existsSync(destination)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(destination);
    } catch {
      return { ok: false, why: `${destination} exists and cannot be opened` };
    }
    if (entries.length > 0) {
      return { ok: false, why: `${destination} already exists and has things in it, and nothing of theirs gets written over` };
    }
  }
  if (plan.sections.length === 0) return { ok: false, why: 'a folder with no sections in it is not an improvement' };
  return { ok: true, plan: { ...plan, destination, source } };
}

/**
 * Build the folder. Creates directories, copies files, writes one new README.
 *
 * There is no code path in here that can remove or replace anything the
 * founder already had: every destination is a path that did not exist when
 * `checkWorkspacePlan` ran, and a collision inside the copy is renamed rather
 * than overwritten.
 */
export function createWorkspace(plan: WorkspacePlan, now = Date.now()): WorkspaceResult {
  const skipped: { rel: string; why: string }[] = [];
  let copied = 0;
  mkdirSync(plan.destination, { recursive: true });

  const index: string[] = [
    `# ${plan.title}`,
    '',
    `Put together on ${new Date(now).toDateString()} from \`${plan.source}\`.`,
    '',
    '**Nothing was moved and nothing was deleted.** Every file below is a copy;',
    `the originals are exactly where they were, in \`${plan.source}\`.`,
    '',
  ];

  for (const section of plan.sections) {
    const safeName = section.name.replace(/[/\\:*?"<>|]/g, '').trim() || 'section';
    const dir = join(plan.destination, safeName);
    mkdirSync(dir, { recursive: true });
    index.push(`## ${safeName}`, '', section.about, '');

    for (const rel of section.files) {
      if (copied >= MAX_COPY_FILES) {
        skipped.push({ rel, why: `more than ${MAX_COPY_FILES} files` });
        continue;
      }
      const from = resolve(plan.source, rel);
      if (!insideRoot(plan.source, from)) {
        skipped.push({ rel, why: 'outside the folder you were given' });
        continue;
      }
      if (!existsSync(from)) {
        skipped.push({ rel, why: 'no longer there' });
        continue;
      }
      let stat;
      try {
        stat = statSync(from);
      } catch {
        skipped.push({ rel, why: 'could not be opened' });
        continue;
      }
      if (!stat.isFile()) {
        skipped.push({ rel, why: 'not a file' });
        continue;
      }
      if (stat.size > MAX_COPY_BYTES) {
        skipped.push({ rel, why: 'too big to copy' });
        continue;
      }
      const to = freshPath(dir, basename(from));
      try {
        copyFileSync(from, to);
        copied++;
        index.push(`- \`${safeName}/${basename(to)}\` (from \`${rel}\`)`);
      } catch (err) {
        skipped.push({ rel, why: err instanceof Error ? err.message : String(err) });
      }
    }
    index.push('');
  }

  if (skipped.length > 0) {
    index.push('## Not copied', '');
    for (const s of skipped) index.push(`- \`${s.rel}\`: ${s.why}`);
    index.push('');
  }

  writeFileSync(freshPath(plan.destination, 'README.md'), index.join('\n'), 'utf-8');
  return { destination: plan.destination, copied, skipped, sections: plan.sections.length };
}

/**
 * A path in `dir` named `name` that does not exist yet. Never returns an
 * existing path, so no `copyFileSync` in this module can land on top of
 * something: two files called `deck.html` from different subfolders become
 * `deck.html` and `deck (2).html`.
 */
export function freshPath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = join(dir, name);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem} (${n})${ext}`);
    n++;
    if (n > 999) return join(dir, `${stem} (${Date.now()})${ext}`);
  }
  return candidate;
}

/* ───────── D43 · one real piece of work, written beside the original ───────── */

export type RevisionResult = { path: string; bytes: number; original: string };

/**
 * Write a revised version of one of their files as a NEW file, next to it.
 *
 * The original is opened read-only and never written to, which is the whole
 * point: the founder can open both and compare, and if the revision is wrong
 * they lose nothing. `freshPath` guarantees the destination did not exist.
 */
export function writeRevision(opts: {
  /** Folder the revision goes in. Must exist. */
  intoDir: string;
  /** What the original was called, for naming. */
  originalName: string;
  /** Suffix that says what this is: "rewritten", "tightened". */
  label: string;
  body: string;
}): RevisionResult {
  const ext = extname(opts.originalName);
  const stem = ext ? opts.originalName.slice(0, -ext.length) : opts.originalName;
  const safeLabel = opts.label.replace(/[/\\:*?"<>|]/g, '').trim() || 'revised';
  mkdirSync(opts.intoDir, { recursive: true });
  const path = freshPath(opts.intoDir, `${stem} - ${safeLabel}${ext || '.md'}`);
  writeFileSync(path, opts.body, 'utf-8');
  return { path, bytes: opts.body.length, original: opts.originalName };
}
