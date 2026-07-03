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

// ── Local browser guard (browser.local: false) ──────────────────────────────
//
// Separate from --no-local-tools: hosted instances disable ONLY the local
// Chrome (no CDP ports may open on a shared VPS) while other local tools
// follow their own policy. Set once at daemon boot from the system config.

let _localBrowserDisabled = false;

export function setLocalBrowserDisabled(disabled: boolean): void {
  _localBrowserDisabled = disabled;
  if (disabled) {
    console.log('[Tools] Local browser disabled (browser.local: false). Browser actions route to a sidecar browser.');
  }
}

export function isLocalBrowserDisabled(): boolean {
  return _localBrowserDisabled;
}

export const LOCAL_BROWSER_DISABLED_MSG =
  'Error: The local browser is disabled on this machine (browser.local: false). Browser actions run on a connected sidecar with the "browser" capability - none is currently available. Ask the user to open their Jarvis desktop app, then retry. Do NOT retry without a sidecar.';
