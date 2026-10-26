/**
 * The `desktop.enabled` off switch (#905).
 *
 * `desktop.enabled: false` means Jarvis does not ask for or act on the user's
 * desktop: it requests no window lists, UI trees or screen captures, and sends
 * no clicks, typing, key presses, app launches or window focus -- on this
 * machine or on a connected sidecar. On the observer side Jarvis ignores what
 * arrives: awareness and the generic sidecar event pipeline drop the screen
 * events a sidecar sends (sidecar-event-routing.ts), the pebble takes no
 * screenshot or window list of its own, and a skill recording stops. It does
 * NOT stop a sidecar's own screen observer: the sidecar still captures and
 * OCRs the screen and sends those events, which the daemon then drops unread
 * (stopping it at the source is a follow-up). The browser tools are
 * unaffected. A screenshot the user attaches themselves from the dashboard is
 * the user's own act and is not covered. The default is `true`, so an install
 * that never set it behaves as before.
 *
 * Two halves, both driven by the tool's own declaration:
 * - what is OFFERED: a tool that always reaches the desktop (category
 *   `desktop`, or `usesDesktop: true`) is withheld from the model's list;
 * - what RUNS: every call that would reach the desktop is refused with
 *   DESKTOP_DISABLED_MESSAGE, at the orchestrator before any approval card and
 *   again in `ToolRegistry.execute`, which every dispatch path goes through.
 *
 * Changing it takes a restart: the value comes from config.yaml, which is
 * imported into the settings store at boot, and nothing writes the stored
 * `desktop` section at run time, so no settings reload carries a new value
 * today. The check still reads the config object live, so a future writer
 * plus a reload would apply at once. Lives in its own module, like local-tools-guard.ts, so
 * the registry, the tool filter and the tools can all import it.
 */

import { ActionOutcomeError } from '../action-outcome.ts';
import type { ToolDefinition } from './registry.ts';

let enabledSource: () => boolean = () => true;

/** Wire the live setting. The daemon passes a reader over its config. */
export function setDesktopEnabledSource(source: (() => boolean) | null): void {
  enabledSource = source ?? (() => true);
}

/**
 * Read a stored `desktop.enabled`. This is a privacy switch, so it fails
 * closed: only a missing value (the default) or a clear "on" keeps desktop
 * control on. YAML 1.2 reads `off`, `no` and `"false"` as strings and `0` as a
 * number, and each of those must turn it off rather than be ignored (#905
 * review); anything unrecognised is off as well.
 */
export function desktopEnabledFromConfig(value: unknown): boolean {
  // null is an empty `enabled:` line: no choice made, so the default.
  if (value === undefined || value === null || value === true || value === 1) return true;
  if (typeof value === 'string') return ['true', 'yes', 'on', '1'].includes(value.trim().toLowerCase());
  return false;
}

/**
 * Read the whole `desktop` section. A missing or empty section (`desktop:`
 * with nothing under it reads as null -- what is left once #897's obsolete keys
 * are deleted) is the default, on. A section that is there but is not a
 * mapping -- `desktop: false`, `desktop: off` -- is a user trying to turn it
 * off with the wrong shape, and fails closed like a bad value.
 */
export function desktopEnabledFromSection(section: unknown): boolean {
  if (section === undefined || section === null) return true;
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return false;
  return desktopEnabledFromConfig((section as { enabled?: unknown }).enabled);
}

/** Whether the stored section or value is not the plain shape, so boot can say how it was read. */
export function desktopValueNeedsWarning(section: unknown): boolean {
  if (section === undefined || section === null) return false;
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return true;
  const value = (section as { enabled?: unknown }).enabled;
  return value !== undefined && value !== null && typeof value !== 'boolean';
}

/**
 * Bind the switch to the daemon's config object. Read through on every check,
 * not copied: a settings reload re-hydrates that same object in place.
 */
export function bindDesktopSwitch(config: { desktop?: unknown }): void {
  setDesktopEnabledSource(() => desktopEnabledFromSection(config.desktop));
}

/**
 * Whether desktop access is switched on. A reader that throws counts as OFF:
 * when the setting cannot be read, the switch the user may have turned off
 * must not read as on.
 */
export function isDesktopEnabled(): boolean {
  try {
    return enabledSource() !== false;
  } catch {
    return false;
  }
}

export const DESKTOP_DISABLED_CODE = 'DESKTOP_DISABLED';

export const DESKTOP_DISABLED_MESSAGE =
  'Error: Desktop control is turned off on this Jarvis (desktop.enabled: false), so this was not run. '
  + 'Jarvis will not list windows, look at the screen or act on desktop apps on any machine until the user turns it back on '
  + '(desktop.enabled: true in config.yaml, then restart Jarvis). '
  + 'Browser tools still work. Do NOT retry; tell the user desktop control is off.';

/** Whether this call, with these arguments, would reach the desktop. */
export function callUsesDesktop(tool: Pick<ToolDefinition, 'category' | 'usesDesktop'>, params: Record<string, unknown>): boolean {
  if (tool.category === 'desktop') return true;
  const declared = tool.usesDesktop;
  if (declared === true) return true;
  if (typeof declared !== 'function') return false;
  try {
    return declared(params) === true;
  } catch {
    // A declaration that cannot decide is treated as reaching the desktop:
    // this is only consulted while the switch is off.
    return true;
  }
}

/** Whether the tool reaches the desktop on every call, whatever its arguments. */
export function toolAlwaysUsesDesktop(tool: Pick<ToolDefinition, 'category' | 'usesDesktop'>): boolean {
  return tool.category === 'desktop' || tool.usesDesktop === true;
}

/** The refusal text for this call, or null when it may run. */
export function desktopRefusal(tool: Pick<ToolDefinition, 'category' | 'usesDesktop'> | undefined, params: Record<string, unknown>): string | null {
  if (!tool || isDesktopEnabled()) return null;
  return callUsesDesktop(tool, params) ? DESKTOP_DISABLED_MESSAGE : null;
}

/**
 * The typed refusal for a step refused part way through a run that started
 * while the switch was on. `effect` is the caller's to say: earlier steps of
 * the run may already have happened.
 */
export function desktopDisabledError(effect: 'not_started' | 'may_have_occurred'): ActionOutcomeError {
  return new ActionOutcomeError({ status: 'blocked', code: DESKTOP_DISABLED_CODE, effect, message: DESKTOP_DISABLED_MESSAGE });
}

/** Whether an error is the switch's own refusal, so a catch-all can let it through. */
export function isDesktopDisabledError(error: unknown): boolean {
  return error instanceof ActionOutcomeError && error.outcome.code === DESKTOP_DISABLED_CODE;
}

/** Throw the typed refusal when this call may not run. Nothing was started. */
export function assertDesktopAllowed(tool: Pick<ToolDefinition, 'category' | 'usesDesktop'>, params: Record<string, unknown>): void {
  const refusal = desktopRefusal(tool, params);
  if (refusal === null) return;
  throw new ActionOutcomeError({ status: 'blocked', code: DESKTOP_DISABLED_CODE, effect: 'not_started', message: refusal });
}

/**
 * The dynamic-prompt note for a switched-off desktop, or null while it is on.
 * States absence, like scopeSystemNote, because the cached tool guide still
 * documents the desktop tools.
 */
export function desktopOffSystemNote(): string | null {
  if (isDesktopEnabled()) return null;
  return [
    '# Desktop control is off',
    '',
    'The user has turned desktop control off (desktop.enabled: false). The tool guide above documents the desktop tools, '
    + 'but on this install you cannot list windows, read the screen, or click, type, press keys, launch or focus apps on any machine: '
    + 'the desktop_* tools and capture_screen are not available, ui_snapshot, ui_act and run_skill work only on the browser, '
    + 'and record_skill cannot start a recording. '
    + 'Do not try to reach the desktop another way, for example through shell commands. '
    + 'If the user asks for something on their desktop, say that desktop control is off and that they can turn it back on '
    + 'by setting desktop.enabled to true in config.yaml and restarting Jarvis.',
  ].join('\n');
}

/** The tools to offer: drops the always-desktop ones while the switch is off. */
export function withoutDisabledDesktopTools<T extends Pick<ToolDefinition, 'category' | 'usesDesktop'>>(tools: readonly T[]): readonly T[] {
  if (isDesktopEnabled()) return tools;
  return tools.filter((tool) => !toolAlwaysUsesDesktop(tool));
}
