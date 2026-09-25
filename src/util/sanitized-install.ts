/**
 * What the daemon's own `bun install` runs (the pieces library and the engine's
 * build deps) share: third-party packages from whatever registry is
 * configured, installed with `sanitizedEnv()` and `--ignore-scripts`.
 *
 * Kept out of subprocess-env.ts on purpose: that file is compiled into the
 * engine bundle, so editing it rebuilds every engine and piece, and nothing
 * here runs in the engine.
 */

/**
 * `--ignore-scripts`: bun's default-trusted list (esbuild, better-sqlite3,
 * couchbase, oracledb among ~370) would otherwise run lifecycle scripts from
 * whatever the registry serves, with the daemon's HOME and its ~/.jarvis
 * readable. scripts/build-shared-runtime.ts made the same call for the shared
 * pieces tree. Measured for #512 before adopting it here:
 *   - engine staging: esbuild's postinstall is the only script in the tree, and
 *     the JS API the build uses resolves the platform binary without it; the
 *     bundle builds and the engine end-to-end suite passes.
 *   - pieces: across the whole catalog (656 pieces), the default-trusted
 *     scripts that run are better-sqlite3 (a native addon Bun cannot load
 *     either way), couchbase and oracledb (both still load without them).
 *     655/656 pieces load with scripts, the same 655 without.
 */
export const BUN_INSTALL_ARGS = ['install', '--silent', '--ignore-scripts'] as const;

/**
 * Appended to a failed install's error. Without it, a self-hoster whose
 * registry auth lived in the environment sees only "exited with code 1".
 * Measured with bun 1.3: `~/.npmrc` and NPM_CONFIG_REGISTRY are honoured under
 * the sanitized env; NPM_CONFIG_USERCONFIG is not read by bun at all.
 */
export const SANITIZED_INSTALL_HINT =
  'This install runs with a sanitized environment, so registry credentials held in ' +
  'environment variables do not reach it (NPM_CONFIG_TOKEN, npm_config_token, ' +
  'BUN_CONFIG_TOKEN; a ${VAR} reference inside .npmrc or bunfig.toml is not expanded and ' +
  'goes to the registry as literal text, which it rejects). ' +
  'Write registry auth literally into ~/.npmrc or ~/.bunfig.toml. Lifecycle scripts are ' +
  'skipped (--ignore-scripts). See docs/SELF_HOSTING.md, "Package installs".';
