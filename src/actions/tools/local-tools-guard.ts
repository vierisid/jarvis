/**
 * Local Tools Guard — Module-level flag for --no-local-tools mode.
 *
 * Separate file to avoid circular dependencies between builtin.ts and desktop.ts.
 */

let _noLocalTools = false;

export function setNoLocalTools(enabled: boolean): void {
  _noLocalTools = enabled;
  if (enabled) {
    console.log('[Tools] Local tool execution disabled (--no-local-tools). Tools require a target sidecar.');
  }
}

export function isNoLocalTools(): boolean {
  return _noLocalTools;
}

export const LOCAL_DISABLED_MSG = 'Error: Local tool execution is disabled (--no-local-tools). Specify a "target" sidecar to route this command to a remote machine. Use list_sidecars to see available sidecars.';

/** Default working directory for tools — set by site builder context per conversation turn. */
let _defaultCwd: string | null = null;

export function setDefaultCwd(cwd: string | null): void {
  _defaultCwd = cwd;
}

export function getDefaultCwd(): string | null {
  return _defaultCwd;
}
