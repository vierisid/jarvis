/**
 * Fail-closed pre-check for the `--system-config <path>` flag.
 *
 * The brain's config loader (src/config/loader.ts) is deliberately forgiving:
 * when its `configPath` is undefined it reads `~/.jarvis/config.yaml` and
 * falls back to defaults if the file is missing. That is the right behavior
 * for self-host installs and for the CLIs under src/cli/.
 *
 * In hosted mode the hosting platform passes `--system-config <path>` to
 * pin the daemon to a root-owned file at
 * `/etc/jarvis-host/instances/u_<id>/config.yaml`. In that mode a missing
 * or unreadable file MUST fail the daemon rather than quietly fall back to
 * the tenant-owned `~/.jarvis/config.yaml`: the whole point of Phase 1 of
 * usejarvis issue #66 is that the authoritative file is not tenant-writable,
 * so a silent fallback would undo the fix. This check runs at the daemon
 * call site before `loadConfig()` is invoked, so the loader itself stays
 * usable by the self-host CLIs with their forgiving defaults.
 *
 * Returns `{ok: true}` when the file exists and is readable; otherwise
 * `{ok: false, message}` with the exact stderr line the daemon logs before
 * `process.exit(1)`. The caller owns the exit so this stays testable.
 */
export async function validateSystemConfigPath(
  systemConfigPath: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const file = Bun.file(systemConfigPath);
    if (!(await file.exists())) {
      return {
        ok: false,
        message: `[Daemon] --system-config <path>: cannot read ${systemConfigPath}: file does not exist`,
      };
    }
    // Attempt to read the file to catch permission errors (EACCES, EPERM)
    // before we hand the path to the loader. The loader also swallows "file
    // doesn't exist" into a defaults fallback, which is exactly the
    // self-host behavior that must NOT engage in hosted mode.
    await file.text();
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `[Daemon] --system-config <path>: cannot read ${systemConfigPath}: ${reason}`,
    };
  }
}
