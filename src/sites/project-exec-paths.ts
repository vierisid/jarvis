/**
 * Site Builder -- which in-project paths the daemon RUNS (#558).
 *
 * `site_write_file` writes a model-chosen path in a model-chosen project and
 * is rated `write_data`. For most of a project that is honest: `src/App.tsx`
 * is content the browser renders. But the daemon itself executes part of every
 * project tree, unattended, as soon as a preview is up -- so a write to those
 * paths is a command that runs later, exactly what `execOnWrite` already says
 * about a write to `~/.bashrc` for the generic `write_file`
 * (actions/tools/file-path-policy.ts, which deliberately declined to judge
 * site projects and called it the site builder's contract). This module is
 * that contract, written down.
 *
 * Why it matters more than an ordinary write: nothing else in the chain stops.
 * #529 frames what `site_read_file` returns but does not taint the turn, so a
 * pulled README saying `curl x | sh` reaches the model defanged and the
 * `site_write_file` that follows is ungated. And under `--no-local-tools` the
 * generic `write_file` refuses while the site tools deliberately do not, so on
 * a hosted brain this is the only write path to the project at all.
 *
 * ## What the daemon actually runs, and how this set is derived from it
 *
 * The daemon spawns exactly three things inside a project tree:
 *
 *   - `make dev`     (sites/dev-server-manager.ts, for the life of the preview)
 *   - `make install` (sites/project-manager.ts, at create time)
 *   - the template CLI (`bunx create-vite` ...), once, before the tree exists.
 *
 * Both of the recurring ones are `make`, so the derivation starts there and
 * reads outwards rather than listing filenames:
 *
 *  1. The ENTRY is whatever `make` opens: its own default search list,
 *     `GNUmakefile`, `makefile`, `Makefile`, matched case-insensitively (a
 *     case-insensitive filesystem makes `MAKEFILE` the same file) and at any
 *     depth (`make -C sub`, a nested project). Plus anything those files
 *     `include`.
 *  2. The COMMANDS are that makefile's recipes for the targets the daemon
 *     names -- DAEMON_MAKE_TARGETS, proven against the spawn sites by
 *     project-exec-paths.test.ts -- and their prerequisites. Not every target:
 *     `make build`'s `bun build index.html` would otherwise make writing
 *     `index.html` execution, and nothing runs `make build`.
 *  3. Each recipe word is then read for what IT executes: a file argument
 *     (`bun --hot index.ts` names the dev-server entry -- the entry is derived
 *     from the recipe, not assumed to be called `index.ts`), and a program
 *     name that loads a config file as code (`bunx vite` loads
 *     `vite.config.*`). PROGRAM_CONFIGS is the one hand-written part of this
 *     module and cannot be otherwise: "vite executes vite.config.ts" is a fact
 *     about vite, not about this repo.
 *  4. The project's own makefile is read when it can be, so a project whose
 *     `dev` recipe is `./run.sh` gets `run.sh` rated as execution without
 *     anyone adding it here. It is UNIONED with the same scan run over
 *     `generateMakefile()` for every shipped template (TEMPLATE_SCAN), not
 *     replaced by it, for two reasons: the makefile may be missing, being
 *     created by this very write, or unreadable on a hosted brain; and a model
 *     could otherwise write `vite.config.ts` BEFORE the makefile that runs
 *     vite and have both writes rated as data.
 *  5. `package.json` and the lockfiles are execution at ANY depth, from
 *     `make install` -> `bun install`: a `postinstall` hook runs on install, a
 *     lockfile decides which third-party tarball is fetched and then runs, and
 *     `bunx <bin>` resolves through the nearest manifest. Any depth because
 *     bun runs a workspace package's lifecycle scripts too.
 *  6. Anything under `node_modules/` is code the dev server imports on the
 *     next reload.
 *
 * On top of that, `siteExecOnWrite` runs the generic `execOnWrite` over the
 * resolved absolute path, so the site tool inherits the classes that are about
 * the filesystem rather than the framework: `bunfig.toml` (bun `preload`),
 * `.npmrc` (`script-shell`), `.envrc`, a `node_modules/.bin` program. Those
 * were already execution for `write_file` and were data for `site_write_file`.
 *
 * ## What it deliberately does NOT rate as execution
 *
 * Application source, including under Next.js, where every page component
 * really does run in the dev server process. Rating app source as execution
 * would fire on every turn of ordinary site work, and #558 is explicit that a
 * rating which escalates everything is not a control but an always-on gate:
 * the point is that `src/index.html` stays `write_data` while `vite.config.ts`
 * does not. The line is the build and config surface -- the files that decide
 * WHAT runs -- not the files that are the site.
 *
 * Stated plainly, because it is the largest residual: for a `next` project
 * this control covers the CONFIG surface only. `app/**` server components,
 * `middleware.ts` and route handlers all execute inside the daemon's `next
 * dev` child with the user's filesystem, and all rate `write_data`. The trade
 * is deliberate; it is not a claim that a Next.js project's source is inert.
 *
 * A hardlink is the other thing this cannot see, and does not need to:
 * `ln Makefile notes.txt` then writing `notes.txt` rates as data, but
 * `ProjectManager.writeFile` detects `nlink > 1` and replaces the NAME by
 * rename (#516), so the makefile's bytes never change. The classifier and the
 * writer are coupled here: drop `replaceFile` and this module has no answer,
 * because no realpath can see a hardlink.
 *
 * Known over-inclusions, all cheap and none frequent enough to train
 * click-through: a root `index.ts` in a vite project (TEMPLATE_SCAN is a
 * union, and the bun-react recipe runs one), a `package.json` or lockfile in
 * a content directory, a `vite.config.*` nested where vite would never load
 * it, and any file under a `node_modules/` directory including documentation.
 *
 * ## Resolution
 *
 * Judged on the spelling, on where `safeJoin` will land it, and on where a
 * symlink then points -- see `siteExecOnWrite`. One limit worth naming: the
 * delegated `execOnWrite` skips its DISK-based classes under
 * `--no-local-tools` (it sets `onDisk = !isNoLocalTools()`), so on a hosted
 * brain its `node_modules/.bin` and home-symlink classes do not fire. This
 * module's own rules are name-based and its own symlink resolution does run
 * there, which is what matters: the project is on that host by design.
 *
 */

import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { TEMPLATES, generateMakefile } from './templates.ts';
import { execOnWrite, getSiteProjectsDir, resolveReal } from '../actions/tools/file-path-policy.ts';

/**
 * `path` is the spelling that was asked for; `lands` is where it really goes
 * when that differs.
 *
 * Both are carried AS SPELLED, not as the lower-cased form matching uses: the
 * card names the file, and a user shown `makefile` for a write to `Makefile`
 * -- or `src/foo.tsx` for `src/Foo.tsx` -- is being shown a path that is not
 * the one the tool will write.
 */
export type ProjectExecHit = { kind: string; path: string; lands?: string };

/**
 * The `make` targets the daemon spawns in a project tree. The recipe scan
 * follows these and their prerequisites and nothing else.
 *
 * project-exec-paths.test.ts reads dev-server-manager.ts and project-manager.ts
 * and fails if either spawns `make` with a target that is not in here, so a
 * fourth entry point cannot be added without the scan learning about it.
 */
export const DAEMON_MAKE_TARGETS: readonly string[] = ['dev', 'install'];

const MAKEFILE = 'a makefile the daemon runs';
const MANIFEST = 'a package manifest or lockfile whose install runs code';
const CONFIG = 'a build config the dev server loads as code';
const ENTRY = 'a file the dev server runs';
const INSTALLED = 'installed package code the dev server loads';

/** GNU make's own default search list, lower-cased for matching. */
const MAKE_ENTRY_NAMES: ReadonlySet<string> = new Set(['gnumakefile', 'makefile']);

/**
 * GNU make's search order, as spelled on disk. All three are read: on a
 * case-insensitive filesystem any of them may be the one it opens. Declared
 * here because the recipe scanner needs it, and the scanner runs at module
 * load to build TEMPLATE_SCAN.
 */
const MAKEFILE_CANDIDATES: readonly string[] = ['GNUmakefile', 'makefile', 'Makefile'];

/**
 * Manifests and lockfiles: `bun install` runs the one's lifecycle scripts and
 * fetches what the other names. `.npmrc` and `bunfig.toml` are not here
 * because the generic execOnWrite already classifies them by name.
 */
const MANIFEST_NAMES: ReadonlySet<string> = new Set([
  'package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json',
  'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
]);

/** The extensions a JS toolchain loads a config file as CODE under. */
const CONFIG_EXT = '(?:js|mjs|cjs|ts|mts|cts)';

function configRe(stem: string): RegExp {
  return new RegExp(`^${stem}\\.config\\.${CONFIG_EXT}$`);
}

/**
 * Program -> the config files that program executes when it starts. The
 * irreducibly hand-written part: it states facts about vite, next and postcss,
 * which no amount of reading this repo can derive. Keyed on the bare program
 * word as a recipe spells it.
 */
const PROGRAM_CONFIGS: ReadonlyMap<string, readonly RegExp[]> = new Map<string, readonly RegExp[]>([
  // Vite evaluates its own config, the postcss config it finds, the tailwind
  // config that postcss plugin loads, and svelte.config.* via the svelte
  // plugin -- all as modules, in the dev-server process.
  ['vite', [configRe('vite'), configRe('vitest'), configRe('postcss'), configRe('tailwind'), configRe('svelte')]],
  ['next', [configRe('next'), configRe('postcss'), configRe('tailwind'), configRe('babel')]],
  ['postcss', [configRe('postcss'), configRe('tailwind')]],
  ['tailwindcss', [configRe('tailwind')]],
  // `bun`/`bunx` read bunfig.toml (`preload` runs before anything else) and
  // the manifest. Both are covered by rules that apply at any depth or by the
  // generic execOnWrite; listed so a recipe naming only bun still says so.
  ['bun', [/^bunfig\.toml$/]],
  ['bunx', [/^bunfig\.toml$/]],
  // A project whose makefile was changed to another package manager. Each of
  // these runs JS of its own during install.
  ['pnpm', [/^\.?pnpmfile\.cjs$/, /^\.?pnpmfile\.js$/]],
  ['yarn', [/^\.pnp\.c?js$/]],
  ['npm', []],
]);

/** Extensions a recipe's file argument is executed as. */
const RUNNABLE_EXT = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|sh|bash|zsh|py|rb|pl)$/;

/**
 * One spelling per in-project path, mirroring file-path-policy's `normalize`
 * and `ProjectManager.safeJoin`: '/'-separated, lower-cased, `.` and `..`
 * collapsed, leading slashes dropped (safeJoin does `join(projectPath, req)`,
 * so an absolute spelling is project-relative), and each component stripped of
 * what Windows ignores -- trailing dots and spaces (`Makefile.` opens
 * `Makefile`) and an NTFS stream suffix (`package.json::$DATA` writes the file).
 */
function normalizeRel(requested: unknown): string {
  const raw = String(requested ?? '').replace(/\\/g, '/').toLowerCase();
  const parts = raw.split('/').map((c) => (c === '.' || c === '..' ? c : trimComponent(c)));
  // A trailing slash would leave an empty basename, and every name rule
  // matches on the basename: `Makefile/` is the makefile.
  return posix.normalize(`/${parts.join('/')}`).replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Drop an NTFS stream suffix (`.gitconfig::$DATA` writes the file itself) and
 * the trailing dots and spaces Windows ignores (`Makefile.` opens `Makefile`).
 *
 * Written as a scan rather than as `/[. ]+$/`, which is quadratic when it
 * fails: a model-chosen path of 200k dots took 40 SECONDS in the regex, on the
 * daemon's only thread, inside an authorityGate that runs before any approval
 * or refusal -- a whole-daemon freeze from one tool call. What this module
 * hands to the generic `execOnWrite` is bounded as well, since that function
 * normalizes paths of its own; see MAX_JUDGED_PATH.
 */
function trimComponent(component: string): string {
  const colon = component.indexOf(':');
  const cut = colon === -1 ? component : component.slice(0, colon);
  let end = cut.length;
  while (end > 0) {
    const ch = cut[end - 1];
    if (ch !== '.' && ch !== ' ') break;
    end--;
  }
  return end === cut.length ? cut : cut.slice(0, end);
}

/**
 * Longer than any path a write can succeed at (PATH_MAX is 4096 on Linux),
 * and the point past which this module stops handing the string to the
 * generic `execOnWrite`, whose own normalizer still backtracks quadratically.
 * The name rules here are linear and keep running.
 */
const MAX_JUDGED_PATH = 8192;

type Scan = {
  /** Exact project-relative paths a recipe runs. */
  entries: Set<string>;
  /** Matching keys (normalized) of the makefiles this one pulls in. */
  included: Set<string>;
  /**
   * The same files AS THE MAKEFILE SPELLS THEM, which is what `projectScan`
   * must open with.
   *
   * These are two different jobs and sharing one set silently broke the
   * second: `normalizeRel` lower-cases, so `include Common.mk` became
   * `common.mk`, which does not exist on a case-sensitive filesystem -- the
   * read failed, the scan was marked complete, and every file that included
   * makefile's recipes named rated as ordinary data. `make` reads it fine.
   */
  includedRaw: Set<string>;
  /**
   * Makefiles whose ABSENCE is normal, so a failed read says nothing about the
   * scan's completeness: make's three root spellings, and the same three under
   * a `make -C <dir>`. Exactly one of each group exists, and a `-C` into a
   * directory with no makefile fails at run time, so nothing executes.
   */
  candidateRaw: Set<string>;
  /** Basename patterns of configs the recipes' programs load. */
  configs: RegExp[];
  /**
   * The makefile could not be read in full or holds something this parser
   * cannot resolve -- a `define` body, a glob `include`, a `$(VAR)` that no
   * assignment in the file explains. The scan is then a LOWER BOUND on what
   * the daemon runs, and `classifyRel` compensates (see UNRESOLVED_EXEC).
   *
   * This exists because the alternative is approval laundering: the Makefile
   * write itself is carded, but at that moment it is empty of payload -- the
   * owner approves a two-line recipe -- and if the file the recipe names then
   * rates as data, the payload lands with no card at all. A scan that quietly
   * returns "nothing" for a makefile it could not read is the same bug.
   */
  partial: boolean;
};

function emptyScan(): Scan {
  return {
    entries: new Set(), included: new Set(), includedRaw: new Set(), candidateRaw: new Set(),
    configs: [], partial: false,
  };
}

function mergeScan(into: Scan, from: Scan): void {
  for (const e of from.entries) into.entries.add(e);
  for (const i of from.included) into.included.add(i);
  for (const i of from.includedRaw) into.includedRaw.add(i);
  for (const i of from.candidateRaw) into.candidateRaw.add(i);
  into.configs.push(...from.configs);
  into.partial ||= from.partial;
}

type Makefile = {
  recipes: Map<string, string[]>;
  prereqs: Map<string, string[]>;
  includes: string[];
  /** Simple `VAR = value` assignments, for expanding `$(VAR)` in a recipe. */
  vars: Map<string, string>;
  /** A `define` body or anything else this parser knows it did not understand. */
  partial: boolean;
  /** Recipes of a pattern rule (`%:`), which `make dev` can fall through to. */
  patternRecipes: string[];
};

/**
 * Enough of the makefile syntax to find what a target runs: rule lines
 * (`target: prereqs`, but not `VAR := x`), tab-indented recipe lines, and
 * `include` / `-include` / `sinclude` directives.
 */
function parseMakefile(text: string): Makefile {
  const recipes = new Map<string, string[]>();
  const prereqs = new Map<string, string[]>();
  const includes: string[] = [];
  const vars = new Map<string, string>();
  const patternRecipes: string[] = [];
  let partial = false;
  let current: string[] = [];
  let inDefine = false;
  for (const rawLine of text.split('\n')) {
    if (inDefine) {
      // A define body is a recipe this parser does not follow into.
      if (/^endef\b/.test(rawLine.trim())) inDefine = false;
      continue;
    }
    if (rawLine.startsWith('\t')) {
      for (const t of current) {
        if (t.includes('%')) patternRecipes.push(rawLine.slice(1));
        else recipes.get(t)!.push(rawLine.slice(1));
      }
      continue;
    }
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (/^define\b/.test(line)) {
      inDefine = true;
      partial = true;
      current = [];
      continue;
    }
    const inc = /^(?:-|s)?include\s+(.+)$/.exec(line);
    if (inc) {
      for (const word of inc[1]!.split(/\s+/)) {
        if (!word) continue;
        // A glob or a variable cannot be resolved to one file to read. The
        // `.mk` name rule still gates the writes; the recipes inside a file
        // this could not read are what `partial` stands in for.
        if (word.includes('$') || word.includes('*') || word.includes('?')) partial = true;
        else includes.push(word);
      }
      current = [];
      continue;
    }
    // `VAR = value`, `:=`, `::=`, `?=`. `+=` appends.
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\+?|:{0,2}|\?)=\s*(.*)$/.exec(line);
    if (assign) {
      const [, name, op, value] = assign as unknown as [string, string, string, string];
      vars.set(name, op === '+' ? `${vars.get(name) ?? ''} ${value}`.trim() : value);
      current = [];
      continue;
    }
    // `target: prereqs`. Assignments were taken above, so a `:` here is a rule.
    const rule = /^([^#=:]+):(?!=)(.*)$/.exec(line);
    if (rule) {
      current = rule[1]!.trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
      for (const t of current) if (!t.includes('%') && !recipes.has(t)) recipes.set(t, []);
      const pre = rule[2]!.replace(/^[:=]/, '').trim().split(/\s+/).filter(Boolean).map((p) => p.toLowerCase());
      for (const t of current) prereqs.set(t, [...(prereqs.get(t) ?? []), ...pre]);
      continue;
    }
    current = [];
  }
  return { recipes, prereqs, includes, vars, partial, patternRecipes };
}

/**
 * Expand `$(VAR)` / `${VAR}` from the file's own assignments, so
 * `ENTRY = boot.ts` + `bun --hot $(ENTRY)` names `boot.ts`. One pass plus a
 * bounded chase for a variable defined in terms of another; what is still
 * unexpanded afterwards is what `partial` is for.
 */
function expandVars(line: string, vars: ReadonlyMap<string, string>): string {
  let out = line;
  for (let round = 0; round < 4 && /\$[({]/.test(out); round++) {
    out = out.replace(/\$[({]([A-Za-z_][A-Za-z0-9_]*)[)}]/g, (whole, name: string) => vars.get(name) ?? whole);
  }
  return out;
}

/** Every recipe line of the given targets and, transitively, their prerequisites. */
function commandsFor(mk: Makefile, targets: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...targets];
  const out: string[] = [];
  while (queue.length) {
    const target = queue.shift()!;
    if (seen.has(target) || seen.size > 200) continue;
    seen.add(target);
    out.push(...(mk.recipes.get(target) ?? []));
    for (const pre of mk.prereqs.get(target) ?? []) queue.push(pre);
  }
  return out;
}

/**
 * Interpreters whose first non-flag operand IS the file they run. `bun`, `npm`
 * and friends are deliberately absent: their first operand is a subcommand
 * (`bun install`), and the file case there (`bun --hot index.ts`) is caught by
 * the extension rule instead.
 */
const SCRIPT_INTERPRETERS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'node', 'deno', 'python', 'python3', 'ruby', 'perl', 'php', 'tsx', 'ts-node',
]);

/**
 * What one recipe line executes. Shell operators split it into commands;
 * `VAR=value` prefixes are environment, not a program.
 *
 * Three ways a token is the file being run, because a makefile has three
 * ordinary ways to say it and missing any of them is a free payload write:
 * an extension this toolchain executes (`index.ts`), a path spelling
 * (`./run`, `bin/serve` -- an extension is not required, and `./run` was the
 * cheapest bypass of the first version of this scanner), and the operand of
 * an interpreter (`sh bin/serve`, `bash ./setup`).
 */
function scanCommand(command: string, into: Scan): void {
  const body = command.replace(/^[\s@+-]+/, '');
  let expectMakefile = false;
  let expectDirectory = false;
  let interpreter = false;
  let tookOperand = false;
  let namedSomething = false;
  let unresolved = false;
  const addMakefile = (spelling: string) => {
    into.included.add(normalizeRel(spelling));
    into.includedRaw.add(spelling);
  };
  for (const token of body.split(/[;|&()<>]+|\s+/)) {
    if (!token) continue;
    if (expectMakefile) {
      addMakefile(token);
      expectMakefile = false;
      namedSomething = true;
      continue;
    }
    // `make -C sub dev` runs sub's own makefile. Following it also settles the
    // `$(MAKE) -C sub dev` spelling, which otherwise resolved to nothing and
    // marked the whole project `partial` -- so the two ordinary ways of
    // writing the same line used to fail in opposite directions, one silent
    // miss and one always-fires gate.
    if (expectDirectory) {
      for (const name of MAKEFILE_CANDIDATES) {
        const spelling = `${token}/${name}`;
        into.included.add(normalizeRel(spelling));
        into.candidateRaw.add(spelling);
      }
      expectDirectory = false;
      namedSomething = true;
      continue;
    }
    // `make -f build.mak`: the file it reads is another makefile.
    if (token === '-f' || token === '--file' || token === '--makefile') {
      expectMakefile = true;
      continue;
    }
    if (token === '-C' || token === '--directory') {
      expectDirectory = true;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (token.includes('$')) {
      // Survived expandVars: no assignment in the file explains it.
      unresolved = true;
      continue;
    }
    const rel = normalizeRel(token);
    if (!rel) continue;
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    const configs = PROGRAM_CONFIGS.get(base.replace(/\.(?:exe|cmd|bat)$/, ''));
    if (configs) {
      into.configs.push(...configs);
      namedSomething = true;
    }
    if (MAKE_ENTRY_NAMES.has(base) || /\.mk$/.test(base)) {
      addMakefile(token);
      namedSomething = true;
    }
    const looksLikePath = token.startsWith('./') || token.startsWith('../') || token.includes('/');
    if (!configs && (RUNNABLE_EXT.test(base) || looksLikePath || (interpreter && !tookOperand))) {
      into.entries.add(rel);
      tookOperand = true;
      namedSomething = true;
    }
    if (SCRIPT_INTERPRETERS.has(base)) {
      interpreter = true;
      namedSomething = true;
    }
  }
  // An unresolved `$(VAR)` only makes the scan a lower bound when it could BE
  // the thing being run. `./serve.sh --port $(PORT)` and `bunx vite --port
  // $(PORT)` name their program outright -- and `PORT` is one the daemon
  // passes in the environment, so it is unresolvable in most real makefiles.
  // Marking those partial would rate every script in the project as execution
  // and turn this into the always-fires gate #558 forbids.
  if (unresolved && !namedSomething) into.partial = true;
}

function scanMakefileText(text: string, targets: readonly string[]): Scan {
  const scan = emptyScan();
  const mk = parseMakefile(text);
  scan.partial ||= mk.partial;
  for (const inc of mk.includes) {
    scan.included.add(normalizeRel(inc));
    scan.includedRaw.add(inc);
  }
  // A pattern rule (`%:`) answers for any target, `make dev` included.
  for (const command of [...commandsFor(mk, targets), ...mk.patternRecipes]) {
    scanCommand(expandVars(command, mk.vars), scan);
  }
  return scan;
}

/**
 * The same scan over the makefile the daemon WRITES for every template it
 * ships (sites/templates.ts), including the default branch for a framework it
 * does not know. Unioned into every judgement, so the answer does not depend
 * on the project's makefile being present or readable, and so writing the
 * config before the makefile that runs it does not launder either write.
 */
const TEMPLATE_SCAN: Scan = (() => {
  const scan = emptyScan();
  const frameworks = [...new Set(TEMPLATES.map((t) => t.framework)), '__unknown_framework__'];
  for (const framework of frameworks) {
    mergeScan(scan, scanMakefileText(generateMakefile(framework), DAEMON_MAKE_TARGETS));
  }
  return scan;
})();

/**
 * How much of a makefile is read. Generous, because a makefile that does not
 * fit is not skipped -- skipping one was a laundering route: pad the file past
 * the limit with comments (one approved card, for a file the owner expects to
 * see edited) and every recipe-derived entry in that project rates as data
 * from then on. What does not fit marks the scan `partial` instead.
 */
const MAX_MAKEFILE_BYTES = 4 * 1024 * 1024;

/**
 * Cached on the makefiles' own (size, mtime), not on a clock.
 *
 * A TTL was wrong in a way that mattered: two tool calls in one model turn sit
 * inside a 5s window every time, so "write the Makefile, then write the file
 * its new recipe names" answered from the pre-write scan and the second write
 * rated as data. The signature makes a stale answer impossible instead of
 * unlikely.
 */
const projectScanCache = new Map<string, { signature: string; scan: Scan }>();

/** `${size}:${mtimeMs}` of each candidate makefile, or '-' where there is none. */
function makefileSignature(projectPath: string, alsoRead: Iterable<string> = []): string {
  // The root candidates AND whatever the cached scan reached through
  // `include` / `-f` / `-C`. Covering only the roots left the cache stale for
  // every included file: rewriting `build.mk` did not change the signature, so
  // the second write of a turn was answered from the pre-write scan -- the
  // same one-turn laundering the TTL had, in the one place the guard next to
  // it did not test.
  const parts: string[] = [];
  for (const rel of [...MAKEFILE_CANDIDATES, ...alsoRead]) {
    try {
      const st = statSync(join(projectPath, rel));
      parts.push(`${rel}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push(`${rel}:-`);
    }
  }
  return parts.join('|');
}

/**
 * Read at most MAX_MAKEFILE_BYTES of a REGULAR file.
 *
 * `statSync().size` was the whole guard here, and it is 0 for a FIFO and for a
 * character device -- so the size check passed and `readFileSync` then blocked
 * the daemon's only thread forever on `mkfifo Makefile`, or ran it out of
 * memory on a `Makefile` symlinked to /dev/zero. Either can arrive when a repo
 * is pulled into the project, which is the untrusted case this module exists
 * for, and after that EVERY write to that project hung.
 *
 * `statSync` follows the link deliberately: a makefile that is a symlink to a
 * real file is ordinary, and it is the TARGET's type that decides.
 */
function readMakefile(path: string): { text: string; truncated: boolean } | null {
  let fd: number | null = null;
  try {
    // O_NONBLOCK, then fstat the descriptor that was actually opened: a stat
    // first and an open afterwards is two looks at a name something else can
    // change in between, and an ordinary `open` on a FIFO blocks the daemon's
    // only thread until a writer appears -- the exact hang this function
    // exists to prevent. The untrusted `make dev` child runs in this tree, so
    // a racing writer is not hypothetical.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    // Sized from the descriptor, not the 4 MiB ceiling: the include walk reads
    // up to 32 files and a Makefile is usually a few hundred bytes.
    const cap = Math.min(Number(st.size) + 1, MAX_MAKEFILE_BYTES);
    const buffer = Buffer.allocUnsafe(cap);
    const read = readSync(fd, buffer, 0, cap, 0);
    return {
      text: buffer.subarray(0, read).toString('utf-8'),
      truncated: read >= MAX_MAKEFILE_BYTES || Number(st.size) > MAX_MAKEFILE_BYTES,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already gone */ }
    }
  }
}

/**
 * The project's own makefile chain, scanned. Never throws -- a project with no
 * readable makefile falls back to TEMPLATE_SCAN alone.
 */
function projectScan(projectPath: string): Scan {
  const cached = projectScanCache.get(projectPath);
  if (cached && cached.signature === makefileSignature(projectPath, [...cached.scan.includedRaw, ...cached.scan.candidateRaw])) return cached.scan;
  const scan = emptyScan();
  const root = resolve(projectPath);
  // The roots are spellings; everything after them is whatever a makefile
  // wrote, opened with that spelling and not with its lower-cased matching key.
  const pending: Array<{ spelling: string; named: boolean }> =
    MAKEFILE_CANDIDATES.map((spelling) => ({ spelling, named: false }));
  const seen = new Set<string>();
  for (let depth = 0; depth < 4 && pending.length; depth++) {
    for (const { spelling, named } of pending.splice(0, pending.length)) {
      if (seen.has(spelling) || seen.size > 32) continue;
      seen.add(spelling);
      // Contained deliberately: `include ../../etc/shadow` must not turn this
      // scanner into a file-read oracle. A spelling that leaves the project is
      // not read -- and, like any include it cannot read, leaves the scan a
      // lower bound rather than a clean "nothing here".
      const abs = resolve(join(projectPath, spelling));
      if (abs !== root && !abs.startsWith(`${root}/`)) {
        scan.partial = true;
        continue;
      }
      const read = readMakefile(abs);
      if (read === null) {
        // A missing candidate is ordinary -- make looks for all three
        // spellings, in the project root and under a `-C` directory alike. An
        // include the makefile NAMES and this cannot read is the laundering
        // case `partial` exists for.
        if (named) scan.partial = true;
        continue;
      }
      if (read.truncated) scan.partial = true;
      const one = scanMakefileText(read.text, DAEMON_MAKE_TARGETS);
      mergeScan(scan, one);
      for (const inc of one.includedRaw) pending.push({ spelling: inc, named: true });
      for (const cand of one.candidateRaw) pending.push({ spelling: cand, named: false });
    }
  }
  if (projectScanCache.size > 64) projectScanCache.clear();
  projectScanCache.set(projectPath, {
    signature: makefileSignature(projectPath, [...scan.includedRaw, ...scan.candidateRaw]),
    scan,
  });
  return scan;
}

/** Drop the cached makefile scans (tests, and a project that was just rewritten). */
export function resetProjectScanCache(): void {
  projectScanCache.clear();
}

/**
 * What a write is rated as in a project whose makefile could not be scanned
 * in full (`Scan.partial`): a script, or a file with no extension at all --
 * the two shapes a recipe's file argument takes.
 *
 * Deliberately NOT every runnable extension. `.ts`, `.tsx` and `.js` are what
 * a site IS, and rating those as execution in a partial project would fire on
 * every turn of ordinary work there, which is the failure #558 names. The
 * resolved scan covers the JS entry cases when it can be trusted; this covers
 * what is left when it cannot.
 */
const UNRESOLVED_EXEC = /(?:^|\/)(?:[^./]+|[^/]+\.(?:sh|bash|zsh|py|rb|pl|mk))$/;

function classifyRel(rel: string, scan: Scan): string | null {
  if (!rel || rel === '.' || rel.startsWith('..')) return null;
  const components = rel.split('/');
  const base = components[components.length - 1]!;
  // Installed third-party code the dev server imports on the next reload.
  if (components.slice(0, -1).includes('node_modules')) return INSTALLED;
  // At any depth: `make -C sub`, a nested project, a workspace package. `.mk`
  // by name because an `include` may be a glob, which names no one file.
  if (MAKE_ENTRY_NAMES.has(base) || /\.mk$/.test(base) || scan.included.has(rel)) return MAKEFILE;
  if (MANIFEST_NAMES.has(base)) return MANIFEST;
  if (scan.entries.has(rel)) return ENTRY;
  if (scan.configs.some((re) => re.test(base))) return CONFIG;
  if (scan.partial && UNRESOLVED_EXEC.test(rel)) return ENTRY;
  return null;
}

/**
 * What kind of thing-the-daemon-runs a `site_write_file` to `requested` in
 * `projectPath` would write, or null for ordinary project content.
 *
 * `projectPath` may be null (an unknown project id, whose write will fail
 * anyway): the path-only rules still apply, so an unresolvable project cannot
 * be a way to have a Makefile write rated as data.
 */
export function siteExecOnWrite(projectPath: string | null | undefined, requested: unknown): ProjectExecHit | null {
  const asked = String(requested ?? '');
  const rel = normalizeRel(requested);
  if (!rel || rel === '.') return null;

  const scan = emptyScan();
  mergeScan(scan, TEMPLATE_SCAN);
  if (projectPath) {
    try {
      mergeScan(scan, projectScan(projectPath));
    } catch { /* an unreadable project keeps the template-derived set */ }
  }

  const spelled = classifyRel(rel, scan);
  if (spelled) return { kind: spelled, path: asked };

  if (!projectPath) return null;

  let lands: string | null = null;
  try {
    // Resolved from the RAW request, not from `rel`: `rel` is lower-cased for
    // name matching, and a lower-cased path does not exist on a
    // case-sensitive filesystem -- so resolving it found nothing and a
    // symlink called `README.md` pointing at the Makefile rated as data,
    // which is precisely the spelling a pulled repo carries.
    const raw = asked.replace(/\\/g, '/');
    const requestedAbs = resolve(join(projectPath, raw));
    const realRoot = resolveReal(projectPath);

    // What safeJoin will actually open. It resolves `join(projectPath,
    // requested)` on the raw string, so a `..`-climbing spelling that lands
    // back inside the project ('x/../../<project>/scripts/serve.sh') is a
    // legal write to that file -- while `normalizeRel` annihilates the `..`
    // against '/' and would have judged a different path. Both spellings are
    // judged. (The annihilation is kept for `include` words, where it is what
    // stops the scanner reading outside the project.)
    const landedRel = relative(resolve(projectPath), requestedAbs);
    if (landedRel && !landedRel.startsWith('..') && normalizeRel(landedRel) !== rel) {
      const landed = classifyRel(normalizeRel(landedRel), scan);
      if (landed) return { kind: landed, path: asked, lands: landedRel };
    }

    // Where the write LANDS through a symlink. safeJoin follows symlinks and
    // then demands the result stay in the project, so an in-project link to a
    // config is a legal write to that config.
    const real = resolveReal(requestedAbs);
    const r = relative(realRoot, real);
    if (r && !r.startsWith('..') && normalizeRel(r) !== rel) lands = r;
    if (lands) {
      const landed = classifyRel(normalizeRel(lands), scan);
      if (landed) return { kind: landed, path: asked, lands };
    }
    // The classes that are about this filesystem rather than this framework:
    // bunfig.toml, .npmrc, .envrc, a node_modules/.bin program, a git dir.
    // Not consulted for an absurd path: its normalizer still backtracks
    // quadratically, and nothing that long is writable anyway.
    if (requestedAbs.length <= MAX_JUDGED_PATH) {
      const generic = execOnWrite(requestedAbs);
      if (generic) return { kind: generic.kind, path: asked, ...(lands ? { lands } : {}) };
    }
  } catch { /* fall through: an unresolvable path is judged on its spelling alone */ }

  return null;
}

/**
 * The same judgement for an ABSOLUTE path, for the generic `write_file`.
 *
 * `execOnWrite` deliberately says nothing about site projects -- it called
 * that the site builder's contract -- so the same physical write to
 * `<projects>/shop/Makefile` cost an `execute_command` card through
 * `site_write_file` and nothing at all through `write_file`, and the model
 * picks the tool. Returns null for any path outside the projects dir, and for
 * the projects dir itself (no site tool can write there).
 */
export function siteProjectExecOnWrite(absolutePath: string): ProjectExecHit | null {
  const dir = getSiteProjectsDir();
  if (!dir || !absolutePath || absolutePath.length > MAX_JUDGED_PATH) return null;
  try {
    const rel = relative(resolve(dir), resolve(absolutePath));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    const parts = rel.split(/[\\/]/).filter(Boolean);
    if (parts.length < 2) return null;
    const [project, ...rest] = parts;
    return siteExecOnWrite(join(resolve(dir), project!), rest.join('/'));
  } catch {
    return null;
  }
}
