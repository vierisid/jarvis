/**
 * Where the founder's files actually are, on the three machines this daemon
 * runs on: WSL, native Windows, and Linux or macOS.
 *
 * ── The bug this exists for ──
 *
 * The daemon runs inside WSL. The founder's company lives on Windows. They say
 * the path they know, `C:\Users\vieri\Documents`, which is a real folder they
 * can open in Explorer; `resolve(home, 'C:\\Users\\vieri\\Documents')` on Linux
 * produces `/home/vieri/C:\Users\vieri\Documents`, which has never existed. So
 * Jarvis answered, truthfully, that there was no folder there, and the founder
 * concluded it was blind. It was not blind: the same files are readable at
 * `/mnt/c/Users/vieri/Documents`, one translation away.
 *
 * ── Why this is detected rather than assumed ──
 *
 * The same code ships on native Windows, where `C:\Users\...` is already
 * correct and translating it would break a working path, and on Linux and
 * macOS, where `/mnt/c` is meaningless and a folder called `C:` is a folder
 * called `C:`. So the translation is gated on actually being inside WSL, which
 * is a fact about the kernel and the environment, not a guess:
 *
 *   - `WSL_DISTRO_NAME` / `WSL_INTEROP`, which every WSL2 session sets, and
 *   - `/proc/version` and `/proc/sys/kernel/osrelease`, which say `microsoft`
 *     on a WSL kernel and cannot be spoofed by an ordinary Linux install.
 *
 * Anything else is `unix` or `windows` and gets no translation at all.
 *
 * ── The other half: naming what it can see ──
 *
 * A founder who says "Documents" and is told there is no such folder is being
 * told something useless. `folderCandidates` walks a short, fixed list of the
 * places a company's files actually live, on BOTH sides of the WSL boundary,
 * and returns only the ones that exist and have something in them. It is a
 * suggestion list, not a disk crawl: bounded in breadth, in depth and in the
 * number of entries it will look at, because `/mnt/c` is a 9p mount and a
 * founder waiting on a conversation is not waiting on a filesystem.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export type HostKind = 'wsl' | 'windows' | 'unix';

export type HostShape = {
  kind: HostKind;
  /**
   * Where Windows drives are mounted, when `kind` is `wsl`. Usually `/mnt`,
   * but `[automount] root` in `/etc/wsl.conf` can move it, and some setups put
   * it at `/`. Empty on every other host.
   */
  driveRoot: string;
};

export const UNIX_HOST: HostShape = { kind: 'unix', driveRoot: '' };
export const WINDOWS_HOST: HostShape = { kind: 'windows', driveRoot: '' };

/** Everything the detector reads, injected so the tests can be a WSL box, a
 *  Windows box and a Linux box without being any of them. */
export type HostProbe = {
  platform: string;
  env: Record<string, string | undefined>;
  /** Returns the file's contents, or null when it is not there. */
  readText: (path: string) => string | null;
  exists: (path: string) => boolean;
};

export function realProbe(): HostProbe {
  return {
    platform: process.platform,
    env: process.env as Record<string, string | undefined>,
    readText: (path) => {
      try {
        return readFileSync(path, 'utf-8');
      } catch {
        return null;
      }
    },
    exists: (path) => {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Which of the three machines is this.
 *
 * `win32` short-circuits first and deliberately: a Windows host must never
 * take the WSL branch, because on Windows the founder's path is already the
 * right one and translating it would break the case that works today.
 */
export function detectHostShape(probe: HostProbe = realProbe()): HostShape {
  if (probe.platform === 'win32') return WINDOWS_HOST;
  if (probe.platform !== 'linux') return UNIX_HOST;
  if (!isWsl(probe)) return UNIX_HOST;
  return { kind: 'wsl', driveRoot: automountRoot(probe) };
}

function isWsl(probe: HostProbe): boolean {
  if (probe.env.WSL_DISTRO_NAME || probe.env.WSL_INTEROP) return true;
  const version = probe.readText('/proc/version') ?? '';
  if (/microsoft|wsl/i.test(version)) return true;
  const release = probe.readText('/proc/sys/kernel/osrelease') ?? '';
  return /microsoft|wsl/i.test(release);
}

/**
 * Where `C:` is mounted. `/etc/wsl.conf` wins when it says something, because
 * a founder who moved their automount root moved it for a reason; otherwise
 * the first candidate that actually has a drive letter under it.
 */
function automountRoot(probe: HostProbe): string {
  const conf = probe.readText('/etc/wsl.conf');
  const configured = conf ? parseAutomountRoot(conf) : null;
  const candidates = [configured, '/mnt', ''].filter((c): c is string => c !== null);
  for (const root of candidates) {
    if (probe.exists(`${root}/c`)) return root;
  }
  return '/mnt';
}

/** `[automount]` / `root = /mnt/`, with the trailing slash taken off. */
export function parseAutomountRoot(conf: string): string | null {
  let inAutomount = false;
  for (const raw of conf.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    if (/^\[.*\]$/.test(line)) {
      inAutomount = line.toLowerCase() === '[automount]';
      continue;
    }
    if (!inAutomount) continue;
    const m = /^root\s*=\s*(.+)$/i.exec(line);
    if (m) {
      const value = m[1]!.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
      return value;
    }
  }
  return null;
}

/* ─────────────────── translating what they actually say ─────────────────── */

/** `C:\Users\x\Docs`, `C:/Users/x/Docs`, and the bare drive `C:`. */
const DRIVE_PATH = /^([A-Za-z]):(?:[\\/](.*))?$/;
/** `\\wsl$\Ubuntu\home\x` and `\\wsl.localhost\Ubuntu\home\x`, which is what
 *  Explorer puts in the address bar when the founder is looking at their WSL
 *  files from Windows. It is a Linux path wearing a Windows coat. */
const WSL_UNC = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+\\?(.*)$/i;

/** True when this looks like a Windows path, whatever host we are on. */
export function looksLikeWindowsPath(raw: string): boolean {
  return DRIVE_PATH.test(raw.trim()) || WSL_UNC.test(raw.trim());
}

/**
 * The same folder, named the way this machine can open it, or null when there
 * is no translation to do. Only ever returns something under WSL: on Windows
 * the input is already right, and on Linux there is nowhere for it to point.
 */
export function windowsPathToHost(raw: string, shape: HostShape): string | null {
  if (shape.kind !== 'wsl') return null;
  const input = raw.trim();

  const unc = WSL_UNC.exec(input);
  if (unc) {
    const rest = (unc[1] ?? '').replace(/\\/g, '/');
    return rest ? `/${rest.replace(/^\/+/, '')}` : '/';
  }

  const drive = DRIVE_PATH.exec(input);
  if (!drive) return null;
  const letter = drive[1]!.toLowerCase();
  const rest = (drive[2] ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const mount = `${shape.driveRoot}/${letter}`;
  return rest ? `${mount}/${rest}` : mount;
}

/** Is `path` the top of a mounted Windows drive, i.e. all of `C:`? */
export function isDriveRootPath(path: string, shape: HostShape): boolean {
  if (shape.kind !== 'wsl') return false;
  const norm = path.replace(/\/+$/, '');
  return new RegExp(`^${escapeRe(shape.driveRoot)}/[a-z]$`, 'i').test(norm);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ───────────────── the places a company's files actually live ───────────────── */

/** Windows profile directories that are never a person. */
const NOT_A_PERSON: ReadonlySet<string> = new Set([
  'Public', 'Default', 'Default User', 'All Users', 'defaultuser0', 'desktop.ini', 'WDAGUtilityAccount',
]);

/** Windows profile children that are machine plumbing, not the founder's work. */
const PROFILE_NOISE: ReadonlySet<string> = new Set([
  'AppData', 'Application Data', 'Cookies', 'Local Settings', 'NetHood', 'PrintHood', 'Recent',
  'SendTo', 'Start Menu', 'Templates', 'Searches', 'Links', 'Favorites', 'Contacts',
  'My Documents', 'Saved Games', '3D Objects', 'IntelGraphicsProfiles', 'MicrosoftEdgeBackups',
]);

/** Home children that are somebody's toolchain rather than their company. */
const HOME_NOISE: ReadonlySet<string> = new Set([
  'node_modules', 'snap', 'go', 'bin', 'tmp', 'Applications', 'Library', 'Public',
]);

/** The Windows user profiles on this machine, newest-looking first. */
export function windowsProfiles(shape: HostShape): string[] {
  if (shape.kind !== 'wsl') return [];
  const users = `${shape.driveRoot}/c/Users`;
  let entries: string[];
  try {
    entries = readdirSync(users);
  } catch {
    return [];
  }
  const out: { path: string; at: number }[] = [];
  for (const name of entries) {
    if (name.startsWith('.') || NOT_A_PERSON.has(name)) continue;
    const full = join(users, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) out.push({ path: full, at: st.mtimeMs });
    } catch {
      /* an unreadable profile is not ours */
    }
  }
  return out.sort((a, b) => b.at - a.at).map((p) => p.path);
}

/**
 * Every base a founder's folder might sit directly under: their Linux home,
 * their Windows profile, and any OneDrive inside it, which is where a
 * redirected Documents folder actually lives.
 */
export function searchBases(home: string, shape: HostShape): string[] {
  const bases: string[] = [home];
  for (const profile of windowsProfiles(shape)) {
    bases.push(profile);
    let children: string[] = [];
    try {
      children = readdirSync(profile);
    } catch {
      children = [];
    }
    for (const name of children) {
      if (!/^OneDrive/i.test(name)) continue;
      const full = join(profile, name);
      try {
        if (statSync(full).isDirectory()) bases.push(full);
      } catch {
        /* skip */
      }
    }
  }
  return bases;
}

/** The names worth looking for under a base, in the order a founder means them. */
const WANTED = [
  'Documents', 'Desktop', 'Projects', 'Code', 'Dev', 'Work', 'Business',
  'Startup', 'Company', 'workspace', 'repos', 'src', 'Downloads',
];

export type FolderCandidate = {
  path: string;
  /** What it is called out loud: "Documents, on Windows". */
  says: string;
  /** Files seen inside it, capped by the probe. */
  files: number;
  /** How many of those are in a format the reader can open. */
  readable: number;
  /** True when the probe stopped before it ran out of folder. */
  more: boolean;
  where: 'windows' | 'here';
};

/** How much of one candidate the probe will look at before it answers. */
const PROBE_ENTRIES = 240;
const PROBE_DEPTH = 2;

/** Extensions the reader can open. Kept in step with `READABLE_EXTS` in
 *  founder-files.ts; duplicated rather than imported so this module has no
 *  dependency on the beat that uses it. */
const READABLE = /\.(md|markdown|txt|rst|org|tex|csv|tsv|json|ya?ml|toml|html?|xml|docx?|pptx?|xlsx?|pdf|pages|key|numbers)$/i;

/** Shallow, bounded look inside one folder: is there anything in here. */
export function probeFolder(path: string): { files: number; readable: number; more: boolean } | null {
  let visited = 0;
  let files = 0;
  let readable = 0;
  let more = false;

  const walk = (dir: string, depth: number): void => {
    if (visited >= PROBE_ENTRIES) { more = true; return; }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (visited >= PROBE_ENTRIES) { more = true; return; }
      visited++;
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < PROBE_DEPTH) walk(full, depth + 1);
        else more = true;
        continue;
      }
      if (!st.isFile()) continue;
      files++;
      if (READABLE.test(name)) readable++;
    }
  };

  try {
    if (!statSync(path).isDirectory()) return null;
  } catch {
    return null;
  }
  walk(path, 1);
  return { files, readable, more };
}

/**
 * Real folders on this machine that could plausibly be where the company
 * lives, so Jarvis can answer "what can you see" with three names instead of
 * nothing.
 *
 * Deliberately a SUGGESTION and not an inventory. It looks under a short list
 * of bases, at one level, at a fixed set of names plus whatever else is
 * sitting there, keeps only what exists and has files in it, and returns the
 * best few. It never walks the disk and it never leaves the founder's own
 * account.
 */
export function folderCandidates(opts: {
  home?: string;
  shape?: HostShape;
  limit?: number;
} = {}): FolderCandidate[] {
  const home = opts.home ?? homedir();
  const shape = opts.shape ?? detectHostShape();
  const limit = opts.limit ?? 6;
  const bases = searchBases(home, shape);
  const seen = new Set<string>();
  const found: FolderCandidate[] = [];

  for (const base of bases) {
    const onWindows = base !== home;
    let children: string[];
    try {
      children = readdirSync(base);
    } catch {
      continue;
    }
    // The named ones first, then whatever else is sitting at the top of the
    // base, so a founder whose company folder is called "Kestrel" is offered
    // it rather than only the folders Microsoft made for them.
    const byLower = new Map(children.map((c) => [c.toLowerCase(), c]));
    const ordered = [
      ...WANTED.map((w) => byLower.get(w.toLowerCase())).filter((c): c is string => !!c),
      ...children,
    ];
    for (const name of ordered) {
      if (name.startsWith('.')) continue;
      if (onWindows ? PROFILE_NOISE.has(name) : HOME_NOISE.has(name)) continue;
      const full = join(base, name);
      if (seen.has(full)) continue;
      seen.add(full);
      if (/^ntuser|^onedrive/i.test(name) && onWindows) continue;
      const probe = probeFolder(full);
      if (!probe || probe.files === 0) continue;
      found.push({
        path: full,
        says: onWindows ? `${name}, on Windows` : name,
        files: probe.files,
        readable: probe.readable,
        more: probe.more,
        where: onWindows ? 'windows' : 'here',
      });
    }
  }

  // What the reader can actually open decides the order, because a folder of
  // 400 photographs is not where the company is written down.
  return found
    .sort((a, b) => b.readable - a.readable || b.files - a.files)
    .slice(0, limit);
}

/**
 * The same folder named with different capitals. Windows filesystems do not
 * care and founders do not either, so "documents" resolves rather than
 * becoming a refusal about a folder that is obviously there.
 */
export function resolveIgnoringCase(base: string, relative: string): string | null {
  const parts = relative.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (parts.length === 0) return null;
  let at = base;
  for (const part of parts) {
    let entries: string[];
    try {
      entries = readdirSync(at);
    } catch {
      return null;
    }
    const hit = entries.find((e) => e.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    at = join(at, hit);
  }
  return at === base ? null : at;
}

/** Every way this machine could read what the founder just said, best first. */
export function candidatePaths(raw: string, home: string, shape: HostShape): string[] {
  const input = raw.trim();
  const out: string[] = [];
  const push = (p: string | null | undefined): void => {
    if (p && !out.includes(p)) out.push(p);
  };

  const translated = windowsPathToHost(input, shape);
  push(translated);

  const expanded = input === '~'
    ? home
    : input.startsWith('~/') || input.startsWith('~\\')
      ? join(home, input.slice(2).replace(/\\/g, '/'))
      : input;

  // On WSL, `resolve(home, 'C:\\Users\\x')` is the bug this module exists for:
  // it produces `/home/vieri/C:\Users\vieri\Documents`, a path that has never
  // existed anywhere. Once there is a translation, that guess is not offered.
  if (!(translated && looksLikeWindowsPath(input))) push(resolve(home, expanded));

  // A bare name under WSL might be on either side of the boundary, and the
  // founder does not think of it as a boundary at all.
  if (shape.kind === 'wsl' && !isAbsolute(expanded) && !looksLikeWindowsPath(input)) {
    for (const base of searchBases(home, shape)) {
      if (base === home) continue;
      push(resolve(base, expanded));
    }
  }
  return out;
}

/** The near misses, tried only when nothing above existed. */
export function nearMisses(raw: string, home: string, shape: HostShape): string[] {
  const input = raw.trim();
  if (!input || isAbsolute(input) || looksLikeWindowsPath(input)) return [];
  const out: string[] = [];
  for (const base of searchBases(home, shape)) {
    const hit = resolveIgnoringCase(base, input);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * A path the founder can read back to themselves, on the machine they use.
 *
 * `/mnt/c/Users/vieri/Documents` is where the daemon opens the file and
 * `C:\Users\vieri\Documents` is where the founder keeps it. Both are true and
 * only one of them is theirs, so anything said out loud or drawn on a card
 * goes through here first.
 */
export function sayPath(path: string, shape: HostShape): string {
  if (shape.kind !== 'wsl') return path;
  const m = new RegExp(`^${escapeRe(shape.driveRoot)}/([a-z])(/.*)?$`, 'i').exec(path);
  if (!m) return path;
  const rest = (m[2] ?? '').replace(/\//g, '\\');
  return `${m[1]!.toUpperCase()}:${rest || '\\'}`;
}
