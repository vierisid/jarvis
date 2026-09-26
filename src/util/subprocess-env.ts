/**
 * Subprocess environment hygiene: what a child process spawned into a
 * model-written project tree is allowed to see of the daemon's environment.
 *
 * Why this exists: the site builder writes a project tree from model output and
 * then runs code out of it -- `bunx create-*`, `make install`, a long-lived
 * `make dev`, `sh -c <model text>`, and git commands that fire whatever sits in
 * that tree's `.git/hooks`. Every one of those is reachable content, not
 * developer-authored code. A child that inherits `process.env` gets
 * `ANTHROPIC_API_KEY`, the `JARVIS_*` tokens and the workflow encryption key
 * along with it.
 *
 * The same holds outside the site builder (#512): a workflow CODE step (run
 * from inside the engine bundle, which compiles this file in -- see
 * PATCHED_VENDOR_SOURCES in engine-runtime/build.ts), the `bun install` runs
 * that fetch pieces and the engine's build deps (lifecycle scripts skipped,
 * see src/util/sanitized-install.ts), and the dashboard auto-build.
 * src/spawn-env-guard.test.ts fails on any spawn under src/ that does not use
 * this, unless it is on that file's justified exemption list.
 *
 * ALLOWLIST, NOT DENYLIST. The predecessor of this module (a
 * `SECRET_ENV_PATTERNS` denylist in src/sites/builder-tools.ts) forwarded
 * everything it did not recognise, and it did not recognise
 * `JARVIS_WORKFLOW_ENCRYPTION_KEY` -- a real variable in this repo, matched by
 * none of `api[_-]?key` / `secret` / `token` / `password` / `credential`. Nor
 * would it catch a bare `ENCRYPTION_KEY` or `VAULT_KEY`. It was also over-eager
 * in the other direction, stripping `JARVIS_SECRETS_DIR`, which is a path. A
 * denylist has to predict every future name; the cost of one miss here is a
 * live credential in a process running attacker-influenced code. An allowlist
 * excludes a future `JARVIS_FOO_KEY` by construction.
 *
 * The cost of an allowlist is having to name what the toolchain needs, and
 * getting that wrong breaks project creation with a confusing error. So the
 * list below was measured, not guessed. Under `env -i` with only PATH, HOME,
 * LANG, TERM, TMPDIR and BUN_INSTALL: `bunx create-vite` scaffolds, `bunx
 * create-next-app` scaffolds from a cold cache with a fresh HOME, `make
 * install` (`bun install`) resolves and installs, and `make dev` (`bunx vite`)
 * serves real HTML. Most of what is beyond those six is for environments
 * unlike a default Linux box -- proxied networks, Windows, relocated caches.
 * The exceptions, forwarded for their own reasons rather than for the measured
 * happy path, are `USER` / `LOGNAME` / `SHELL`: git falls back to `USER` and
 * `LOGNAME` to build an identity when `~/.gitconfig` supplies none, which is
 * the failure mode described further down.
 *
 * Prior art, deliberately not merged: src/workflows/runner/engine-runtime/
 * spawn.ts builds its own 7-name allowlist for the same reason ("we avoid
 * blasting the whole process.env into the engine"): PATH, HOME, TMPDIR, LANG,
 * LC_ALL, TZ and BUN_RUNTIME_TRANSPILER_CACHE_PATH, plus two engine lifecycle
 * knobs. Everything but those two knobs is covered here. It is
 * load-bearing for a different subsystem with a different release cadence, so
 * it stays where it is. If a third copy ever appears, consolidate onto this one
 * rather than forking again -- see the standing rule in src/util/redact.ts.
 *
 * DELIBERATELY NOT FORWARDED, and what that costs. Worth stating plainly,
 * because each of these is a behaviour change, not just a tightening:
 *   - `SSH_AUTH_SOCK` / `GIT_ASKPASS`: see the capability note below. A model
 *     running `git push` to an SSH remote through site_run_command now fails
 *     where it previously worked.
 *   - `GIT_AUTHOR_*` / `GIT_COMMITTER_*` / `EMAIL`: GitManager.init() and
 *     autoCommit() now take their identity solely from `~/.gitconfig` (HOME is
 *     allowlisted, so the normal path is unaffected). A daemon that got its
 *     git identity from the environment will now see "please tell me who you
 *     are" instead.
 *   - `NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `VIRTUAL_ENV`, `DISPLAY`, and
 *     the version-manager knobs (`VOLTA_HOME`, `ASDF_DIR`, `NVM_DIR`): default
 *     installs resolve through PATH and HOME and are unaffected; relocated ones
 *     break. `NODE_OPTIONS` is dropped on purpose rather than by omission -- it
 *     can carry `--require`, which is code execution in the child.
 *   - all `GIT_*`: see the GitManager.run() comment. Inheriting GIT_DIR or
 *     GIT_INDEX_FILE from a hook-invoked daemon would point a project's git
 *     commands at jarvis's own repository.
 * If one of these turns out to be genuinely needed, add the specific name here
 * with a reason. Do not widen a pattern to cover it.
 *
 * WHAT THIS DOES NOT COVER. Env is one channel, not the only one:
 *   - argv. Until #511, `GitHubManager` put the GitHub PAT in the remote URL it
 *     handed to git, where `ps` showed it and git passed it to a `pre-push` hook
 *     as `$2`, however clean the environment. #511 handles that in
 *     GitHubManager (src/sites/github-manager.ts): the token reaches git through
 *     a one-shot credential helper, not argv. Do not "fix" it by moving the
 *     token into an env var: hooks inherit git's environment.
 *   - the filesystem. `HOME` is allowlisted because the toolchain genuinely
 *     needs it, so the child can still read `~/.npmrc`, `~/.bunfig.toml`,
 *     `~/.git-credentials` and -- the one that matters most -- `~/.jarvis`,
 *     which is where this daemon keeps the workflow encryption key and
 *     `.secrets.key` (see src/workflows/db/encryption.ts). Stripping
 *     `JARVIS_WORKFLOW_ENCRYPTION_KEY` from the environment removes one channel
 *     to that key, not the key's reachability. Same uid, same filesystem: that
 *     is a sandboxing problem, not an env-hygiene one.
 *   - values. `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` legitimately carry
 *     `https://user:pass@proxy` userinfo, and `NPM_CONFIG_REGISTRY` /
 *     `BUN_CONFIG_REGISTRY` routinely carry `https://user:token@host/repo/` for
 *     Artifactory and Nexus. `NPM_CONFIG_USERCONFIG` points at a file holding
 *     `_authToken`. All are forwarded anyway, on purpose: dropping them makes
 *     `bun install` fail on exactly the networks that need them. This filter is
 *     name-based and cannot see into a value.
 *   - a dropped capability worth recognising: `SSH_AUTH_SOCK` is deliberately
 *     NOT forwarded, because handing an agent socket to a process that runs
 *     `.git/hooks` out of a model-written tree is agent forwarding to
 *     attacker-influenced code. Consequence: git over an SSH remote cannot
 *     authenticate from these spawns. The GitHub path uses HTTPS plus a PAT, so
 *     no current flow regresses.
 */

/**
 * Keys a call site may add on top of the sanitized base.
 *
 * Deliberately a closed union. The code this module replaces looked like
 * `env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }`, so the cheapest possible
 * edit -- by a contributor or by a model doing a mechanical refactor -- is
 * `sanitizedEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0' })`. With an open
 * `Record<string, string>` that compiles, runs, and forwards the entire daemon
 * environment while looking sanitized. With this union it fails to compile, and
 * adding a key is a deliberate one-line edit reviewed in this file.
 */
export const EXTRA_ENV_KEYS = [
  'PORT', 'HOST', 'NODE_ENV', 'GIT_TERMINAL_PROMPT',
  // WSL, added for src/actions/terminal/wsl-bridge.ts (#519). WSL_INTEROP is
  // the one launching a Windows program needs on WSL2: the socket it goes
  // through. WSL_DISTRO_NAME is this distro's name, and WSLENV lists the
  // variables shared with the Windows side (only ones that survived the
  // allowlist can be). A socket path and names, not credentials. Extras are
  // opt-in per call site: only a spawn that names these receives them.
  'WSL_INTEROP', 'WSL_DISTRO_NAME', 'WSLENV',
] as const;

export type ExtraEnvKey = (typeof EXTRA_ENV_KEYS)[number];

export type ExtraEnv = Partial<Record<ExtraEnvKey, string | undefined>>;

/**
 * Rejects an object type that carries a string index signature.
 *
 * The closed union above is not sufficient on its own. TypeScript skips
 * excess-property checking for properties introduced by a spread, and
 * `process.env` is typed with a `[key: string]: string | undefined` index
 * signature, so `sanitizedEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0' })` --
 * character for character the shape of the code this module replaced -- type
 * checks cleanly against `Partial<Record<ExtraEnvKey, ...>>`. Verified: a bogus
 * literal key IS rejected, the spread form was NOT.
 *
 * Any key of T outside ExtraEnvKey is required to be `never`, which no real
 * value satisfies, so a plain literal with an unknown key is rejected.
 *
 * T must stay inferable, so the guard is intersected with T rather than wrapped
 * around it: with a conditional type like `extra?: Guard<T>` the parameter is
 * no longer an inference site, T silently falls back to its constraint, and the
 * guard never fires. That was verified the hard way.
 *
 * HOW MUCH THIS ACTUALLY GUARANTEES, precisely -- it is weaker than it looks.
 * TypeScript DROPS a string index signature when other properties are added in
 * the same object literal, so `Exclude<keyof T, ExtraEnvKey>` does not become
 * `string` for the spread form. `sanitizedEnv({ ...process.env, ... })` is
 * rejected only because the ambient `ProcessEnv` type happens to declare a
 * named `TZ?: string` that falls outside ExtraEnvKey. A spread of a bare
 * `{ [k: string]: string | undefined }` still compiles.
 *
 * So the REAL guarantee is the runtime EXTRA_ENV_KEY_SET check in filterEnv,
 * which no cast or spread can get past. This type is an early-feedback
 * tripwire, not the control. subprocess-env.type-guard.ts pins the behaviour
 * that does exist so a dependency bump cannot erode it silently.
 */
export type OnlyExtraEnvKeys<T> = T & { [K in Exclude<keyof T, ExtraEnvKey>]: never };

/**
 * Exact variable names forwarded to a subprocess.
 *
 * Windows names are compared case-insensitively (the OS treats them that way)
 * but the base's original casing is preserved on output, because this repo
 * itself reads `process.env.ProgramFiles` and `process.env['ProgramFiles(x86)']`
 * with that exact spelling.
 */
export const SUBPROCESS_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  // -- Process basics. PATH finds bunx/make/git/sh; HOME is where bun and npm
  // keep their caches and where git reads global config. Without these two
  // nothing runs at all.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',

  // -- Temp. bun install stages here; vite writes caches here.
  'TMPDIR', 'TMP', 'TEMP',

  // -- Locale and terminal. Not credentials, and a missing TERM makes some
  // CLIs emit control-character soup or bail outright.
  'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM',

  // -- Network reachability. Without these the registry is simply unreachable
  // on a corporate network and `make install` fails as an opaque timeout.
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',

  // -- TLS trust anchors. Paths to CA bundles, needed behind a TLS-inspecting
  // proxy. These are file paths, not secrets, which is why the backstop below
  // deliberately has no /cert/i rule.
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',

  // -- Toolchain locations. Relocated caches and private registries. Registry
  // *auth* lives in ~/.npmrc, not here; an NPM_TOKEN-style name is excluded by
  // the allowlist and would be caught by the backstop anyway.
  'BUN_INSTALL', 'BUN_INSTALL_CACHE_DIR', 'BUN_INSTALL_BIN', 'BUN_CONFIG_REGISTRY',
  // Not a secret, and the sibling allowlist in engine-runtime/spawn.ts already
  // forwards it: a child bun process otherwise recompiles against a relocated
  // transpiler cache. Bun is fail-open on an unreadable cache dir, so this
  // cannot break a spawn.
  'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
  'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_USERCONFIG',
  // npm exports the lowercase spelling to child processes, and POSIX name
  // comparison is case-sensitive, so the uppercase entries alone would silently
  // drop a registry set by an `npm_config_*` export. The credentialed members
  // of that family (`npm_config__auth`, `npm_config__authToken`) are absent
  // from this list and caught by the /auth/i backstop besides.
  'npm_config_registry', 'npm_config_cache', 'npm_config_prefix', 'npm_config_userconfig',

  // -- XDG base directories, for tools that keep state outside ~/.cache.
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',

  // -- Windows essentials. Dropping SYSTEMROOT alone breaks winsock, i.e.
  // every network call the child makes.
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'ALLUSERSPROFILE', 'PUBLIC', 'USERPROFILE', 'USERNAME', 'USERDOMAIN',
  'HOMEDRIVE', 'HOMEPATH', 'HOMESHARE', 'PSMODULEPATH',
]);

/**
 * Prefix rules, anchored on purpose. The denylist this replaces used unanchored
 * `.test()` throughout, an idiom that copy-pastes badly into an allowlist: an
 * unanchored /LC_/ would admit `MY_SECRET_LC_KEY`.
 *
 * Locale values are not credentials, and there are too many LC_* names
 * (LC_CTYPE, LC_NUMERIC, LC_TIME, ...) to enumerate.
 */
const ALLOWED_PREFIXES: readonly RegExp[] = [/^LC_/];

/**
 * Backstop denylist, applied *over* the allowlist and over caller-supplied
 * extras.
 *
 * This cannot fire for anything in SUBPROCESS_ENV_ALLOWLIST today -- a unit
 * test asserts exactly that, so the two lists cannot silently contradict each
 * other. It is not defense in depth for the base env; it is a tripwire for the
 * next edit, so that adding `NPM_CONFIG_AUTHTOKEN` or an `extra` named for a
 * credential fails closed instead of quietly reopening the hole.
 *
 * Note there is deliberately no /cert/i rule: it would strip the allowlisted
 * NODE_EXTRA_CA_CERTS and SSL_CERT_FILE, which are trust-anchor paths. That is
 * the over-sanitization failure mode in miniature -- a filter that breaks the
 * toolchain to protect something that was never a secret.
 */
const SECRET_ENV_PATTERNS: readonly RegExp[] = [
  /key/i,
  /secret/i,
  /token/i,
  /password|passwd|passphrase/i,
  /credential/i,
  /auth/i,
  /private/i,
];

const EXTRA_ENV_KEY_SET: ReadonlySet<string> = new Set(EXTRA_ENV_KEYS);

/** True if a variable name looks like it names a credential. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_PATTERNS.some(p => p.test(name));
}

const ALLOWED_EXACT: ReadonlySet<string> = new Set(SUBPROCESS_ENV_ALLOWLIST);
const ALLOWED_EXACT_UPPER: ReadonlySet<string> = new Set(
  SUBPROCESS_ENV_ALLOWLIST.map(n => n.toUpperCase()),
);

/**
 * `platform` is an injectable test seam. Both lookup sets are built at module
 * load, so a test that reassigns `process.platform` after import would
 * otherwise exercise only half the branch.
 */
export function isAllowedEnvName(name: string, platform: string = process.platform): boolean {
  const candidate = platform === 'win32' ? name.toUpperCase() : name;
  const exact = platform === 'win32' ? ALLOWED_EXACT_UPPER : ALLOWED_EXACT;
  if (exact.has(candidate)) return true;
  return ALLOWED_PREFIXES.some(p => p.test(candidate));
}

/**
 * Pure form, for tests: filter `base` through the allowlist and the backstop,
 * then apply `extra` on top.
 *
 * `extra` is a deliberate per-call-site addition (a port, a git prompt switch),
 * so it bypasses the allowlist -- but not the backstop. An `undefined` value
 * removes the key rather than stringifying to "undefined".
 *
 * Kept separate from `sanitizedEnv` so the helper's own unit tests never have
 * to mutate `process.env`, while call sites get a signature with no injectable
 * base to misuse.
 */
export function filterEnv<T extends ExtraEnv>(
  base: Record<string, string | undefined>,
  extra?: OnlyExtraEnvKeys<T>,
  platform: string = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!isAllowedEnvName(key, platform)) continue;
    if (isSecretEnvName(key)) continue;
    // The base's own spelling is preserved deliberately: on win32 the match is
    // case-insensitive, but this repo reads `process.env.ProgramFiles` and
    // `process.env['ProgramFiles(x86)']` with that exact casing.
    out[key] = value;
  }

  for (const [key, value] of Object.entries(extra ?? {})) {
    // Runtime half of the closed union, and the ONLY real guarantee here: the
    // type-level guard can be defeated by a cast, by plain JS, or by a spread
    // of a bare index-signature type, any of which would otherwise reinstate
    // the whole leak while reading as sanitized. Unknown keys are dropped.
    if (!EXTRA_ENV_KEY_SET.has(key)) continue;
    if (value === undefined) {
      delete out[key];
      continue;
    }
    // Unreachable today: no EXTRA_ENV_KEYS member is credential-shaped, and a
    // test pins that. Kept as the tripwire for the next key someone adds.
    if (isSecretEnvName(key)) continue;
    out[key] = value;
  }

  return out;
}

/**
 * The environment to hand a subprocess that will run project code.
 *
 * Always returns an object. Never let a call site turn this into `undefined`:
 * `Bun.spawn` with an explicit env REPLACES the environment, but omitting `env`
 * INHERITS the full one, so a `?? undefined` anywhere downstream silently
 * restores the entire leak.
 */
export function sanitizedEnv<T extends ExtraEnv>(
  extra?: OnlyExtraEnvKeys<T>,
): Record<string, string> {
  return filterEnv(process.env, extra);
}
