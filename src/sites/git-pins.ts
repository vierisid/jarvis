/**
 * Site Builder — git config pins
 *
 * The `-c` pins every daemon git call in a site project carries, and the
 * per-name hook lookup for git 2.54, shared by GitManager and GitHubManager so
 * the two cannot drift. Moved here verbatim from github-manager.ts (#511);
 * nothing in it holds state beyond what a caller creates.
 *
 * Command-line config beats every config file for the same key, so these hold
 * even against a `.git/config` planted before the site file tools stopped
 * writing it (#516), or written through site_run_command. They are defense in
 * depth: the site file tools refusing `.git` is the fix.
 */

// git version support, measured in review (2.34, 2.39, 2.47, 2.51, 2.54,
// 2.55):
//   - `safe.bareRepository` exists from 2.38; older git ignores the pin.
//   - `http.<url>.proactiveAuth` exists from 2.46 (see gitHardeningArgs in github-manager.ts).
//   - config-defined hooks (`hook.<name>.command`) exist from 2.54;
//   - the event-level `hook.<event>.enabled` switch from 2.55. So 2.54 alone
//     needs the per-name lookup (needsNamedHookLookup).

/**
 * Every hook event git itself fires, per githooks(5) as of git 2.55. The four
 * p4-* events are left out: only git-p4 fires them, and the daemon never
 * runs it.
 */
const HOOK_EVENTS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
  'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'fsmonitor-watchman', 'post-index-change',
] as const;

/**
 * `-c` pins on EVERY git command the daemon runs in a site project, from
 * GitManager (status, commit, diff, switch, merge, rebase, log, ...) and
 * GitHubManager (push, pull, fetch, remote), authenticated or not. Each
 * names something a model-written project tree could otherwise make git run:
 *   - `safe.bareRepository=explicit`: a bare repository planted at the
 *     project root (HEAD, objects/, refs/, config) is otherwise discovered
 *     implicitly, and its config runs code on a plain `git status` (#516).
 *     git < 2.38 does not know the key and is not protected by it.
 *   - `core.hooksPath=/dev/null` and `hook.<event>.enabled=false` for every
 *     event: no project hook runs on the daemon's own git -- push, pull and
 *     fetch, and the auto-commits, switches, merges and rebases (maintainer
 *     decision; the auto-commits lose the project's pre-commit lint). A
 *     project-level `core.hooksPath` is legitimate (husky sets
 *     `.husky/_`, inside the worktree, and runs `.husky/<hook>` through
 *     `sh -e`, so the file needs no executable bit), which made a
 *     site_write_file of `.husky/pre-push` into code execution on the next
 *     push. hooksPath alone is not enough: git also runs hooks defined in
 *     config (`hook.<name>.command` + `hook.<name>.event`) wherever hooksPath
 *     points, and only the per-event `enabled=false` stops those on git 2.55+
 *     (reproduced in review; the command line beats a project's own
 *     `enabled=true`). git 2.54 has config hooks but not that event-level
 *     switch, so there each configured hook is also pinned off by name
 *     (resolveHookPins). For a push the token was already consumed by
 *     then; this closes the write-to-execute path itself. Git the user runs
 *     is unaffected. A hook event added by a future git would need adding to
 *     HOOK_EVENTS.
 *   - `core.fsmonitor=` (empty): the fsmonitor command runs on every index
 *     read. Empty, not `false`: git 2.34 reads `false` as the name of a hook
 *     to run (via PATH), twice per index read; empty disables it with no
 *     child on 2.34 through 2.55.
 *   - `commit.gpgSign=false`, `log.showSignature=false`,
 *     `merge.verifySignatures=false`: pull's integrate step creates merge or
 *     rebase commits and would verify signed upstream commits, and
 *     `gpg.program` / `gpg.ssh.program` are configurable by the project (a
 *     planted `gpg.ssh.program` ran on `pull` with only the first two pinned).
 *     A project with commit.gpgSign=true now gets unsigned commits from a
 *     daemon pull.
 *   - `push.gpgSign=false`: GitHub does not accept signed pushes, and the
 *     signing program is project-configurable too.
 *   - `submodule.recurse=false`, `fetch.recurseSubmodules=false`,
 *     `push.recurseSubmodules=no` (#523; the last three used to be pinned on
 *     authenticated calls only): recursing runs git in a nested repository
 *     under THAT repository's config, which git-config-lint.ts never reads --
 *     its filter drivers and includes would run. `status` and `diff` also
 *     get `--ignore-submodules=all` from their callers, since a per-submodule
 *     `ignore` setting in `.gitmodules` beats the config default.
 *   - `gc.autoDetach=false`, `maintenance.autoDetach=false` (#523): auto
 *     maintenance otherwise runs detached, outliving the daemon's command and
 *     its timeout, and re-reads the project config long after the lint.
 *     Foreground, it is part of the command that triggered it (rare: loose
 *     objects have to pile up first). A git without maintenance.autoDetach
 *     ignores that key and falls back on gc.autoDetach, as newer git does.
 *
 * NOT pinnable this way, because their names are the writer's choice: filter
 * drivers (`filter.<x>.clean`), merge and textconv drivers, and config pulled
 * in through `include.path`. Those need a config file the site file tools can
 * write, which is what they no longer can (#516), and git-config-lint.ts
 * refuses to run git at all in a project whose own config holds one (#523).
 * GitManager.getDiff passes --no-ext-diff and --no-textconv for the diff
 * side of it. The pins still matter for what the lint does not read: the
 * global and system configs, and a config changed after the lint.
 */
export const PROJECT_GIT_PINS: readonly string[] = [
  '-c', 'safe.bareRepository=explicit',
  '-c', 'core.hooksPath=/dev/null',
  ...HOOK_EVENTS.flatMap(event => ['-c', `hook.${event}.enabled=false`]),
  '-c', 'core.fsmonitor=',
  '-c', 'commit.gpgSign=false',
  '-c', 'log.showSignature=false',
  '-c', 'merge.verifySignatures=false',
  '-c', 'push.gpgSign=false',
  '-c', 'submodule.recurse=false',
  '-c', 'fetch.recurseSubmodules=false',
  '-c', 'push.recurseSubmodules=no',
  '-c', 'gc.autoDetach=false',
  '-c', 'maintenance.autoDetach=false',
];

/**
 * `git status` as the daemon runs it in a project, from both managers.
 * `--ignore-submodules=all`: checking a submodule's work tree runs git inside
 * it, under a config git-config-lint.ts never read, and a per-submodule
 * `ignore` in `.gitmodules` (which the site file tools can write) beats a
 * `-c diff.ignoreSubmodules` pin. Only the command-line option beats it.
 */
export const PROJECT_STATUS_ARGS: readonly string[] = ['status', '--porcelain', '--ignore-submodules=all'];

/** A git binary's major.minor, or null when `git --version` is unparseable. */
export type GitVersion = readonly [number, number] | null;

/**
 * Release candidates parse as unknown (null), which means "do the hook
 * lookup": whether an rc of 2.55 already carries the event-level switch is
 * not something to guess at. git prints an rc as `2.55.0.rc1` (its version
 * script turns `-` into `.`), or `2.55.0.rc0.12.gabc` between tags; `-rc1` is
 * matched too. Dev builds of a release (`2.55.0.123.gabc`) parse normally.
 */
export function parseGitVersion(versionOutput: string): GitVersion {
  if (/[.-]rc\d/i.test(versionOutput)) return null;
  const m = /(\d+)\.(\d+)/.exec(versionOutput);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Whether config-defined hooks must be pinned off one by one: only on git
 * 2.54, which runs `hook.<name>.command` but has no event-level
 * `hook.<event>.enabled` (there `hook.pre-push.enabled=false` disables only a
 * hook NAMED "pre-push"; reproduced in review). Before 2.54 there are no
 * config hooks; from 2.55 the event pins in PROJECT_GIT_PINS cover them. An
 * unknown version does the lookup: it costs one spawn.
 */
export function needsNamedHookLookup(version: GitVersion): boolean {
  return version === null || (version[0] === 2 && version[1] === 54);
}

/**
 * The query whose output hookPinsFromListing parses. `.*`, not `.+`:
 * `[hook ""]` is a valid, runnable hook with an empty name. Exit status 1
 * means "no such keys"; anything else is a failure.
 */
export const HOOK_LOOKUP_ARGS: readonly string[] = ['config', '-z', '--get-regexp', '^hook\\..*\\.(command|event)$'];

/**
 * Hook names from `git config -z --get-regexp '^hook\..*\.(command|event)$'`:
 * entries are NUL-separated, each `key\nvalue` (or just `key` when valueless).
 * The name is everything between `hook.` and the last `.command`/`.event`,
 * case preserved (git keeps a subsection's case, and matches it exactly), and
 * may be empty or contain dots and spaces.
 *
 * Throws on a name `-c hook.<name>.enabled=false` cannot carry: git splits
 * `-c` at the first `=`, so the pin would silently name a different key.
 */
export function hookNamesFromListing(listing: string): string[] {
  const names = new Set<string>();
  for (const entry of listing.split('\0')) {
    const key = entry.split('\n', 1)[0]!;
    const match = /^hook\.(.*)\.(command|event)$/s.exec(key);
    if (!match) continue;
    const name = match[1]!;
    if (/[=\n]/.test(name)) throw new Error(`Refusing to run git: a config hook name cannot be disabled ("${name}")`);
    names.add(name);
  }
  return [...names];
}

/** `-c hook.<name>.enabled=false` for every name in a HOOK_LOOKUP_ARGS listing. */
export function hookPinsFromListing(listing: string): string[] {
  return hookNamesFromListing(listing).flatMap(name => ['-c', `hook.${name}.enabled=false`]);
}

/**
 * Runs one git command (with PROJECT_GIT_PINS, no per-name pins) and resolves
 * to its stdout; rejects with an Error carrying `exitCode` on failure.
 */
export type RunGit = (args: string[]) => Promise<string>;

/**
 * The per-name hook pins for one project, as `-c` arguments: `[]` unless
 * needsNamedHookLookup(version), else one pin per configured hook name.
 * Re-reads the config on every call, so a hook added between two commands is
 * still caught; one added between this lookup and the command it guards is
 * not -- the same race as any check-then-run on a config the project can
 * write (#516). Callers holding a secret must resolve this BEFORE the secret
 * exists: the lookup is a git process of its own.
 *
 * Fails closed: only exit 1 ("no such keys") means none; any other failure
 * (a broken config is 128) rethrows, as does a name no `-c` key can carry.
 */
export async function resolveHookPins(run: RunGit, version: GitVersion): Promise<string[]> {
  if (!needsNamedHookLookup(version)) return [];
  let listing: string;
  try {
    listing = await run([...HOOK_LOOKUP_ARGS]);
  } catch (err) {
    if ((err as { exitCode?: number }).exitCode === 1) return [];
    throw err;
  }
  return hookPinsFromListing(listing);
}

/**
 * A memoised `git --version` reader. `run` should use a fixed cwd (the version
 * describes the binary, and a project cwd that does not exist would fail the
 * read). A failed read is not cached: the next call retries. Concurrent
 * callers share the one in-flight read.
 */
export function gitVersionReader(run: RunGit): () => Promise<GitVersion> {
  let cached: Promise<GitVersion> | undefined;
  return () => {
    cached ??= run(['--version']).then(
      out => parseGitVersion(out),
      (err) => {
        cached = undefined;
        throw err;
      },
    );
    return cached;
  };
}
