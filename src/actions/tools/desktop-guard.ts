/**
 * The `desktop.enabled` off switch (#905).
 *
 * `desktop.enabled: false` means Jarvis does not ask for or act on the user's
 * desktop: it requests no window lists, UI trees or screen captures, and sends
 * no clicks, typing, key presses, app launches or window focus, and does not
 * read or write the clipboard (#1159) -- on this machine or on a connected
 * sidecar. On the observer side Jarvis ignores what arrives: awareness and the
 * generic sidecar event pipeline drop the screen and clipboard events a
 * sidecar sends (sidecar-event-routing.ts), the pebble takes no screenshot or
 * window list of its own, and a skill recording stops. It does NOT stop a
 * sidecar's own screen and clipboard observers: the sidecar still captures,
 * OCRs and reads, and sends those events, which the daemon then drops unread
 * (stopping them at the source needs a sidecar change). The browser tools are
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
 * Settings changes it at run time (POST /api/config/desktop, #1159): the
 * route sets the live config object this check reads and runs the desktop
 * applier, so it applies at once. An edit to config.yaml is imported into the
 * settings store at boot, so that way takes a restart.
 *
 * Not covered: run_command. A shell can capture the screen or send input
 * itself (screencapture, osascript, xdotool), and a list of such commands
 * would always be incomplete, so the terminal is governed by its own approval
 * and by --no-local-tools, not by this switch (owner decision, #1159). The
 * prompt note below still tells the model not to reach the desktop that way.
 *
 * Lives in its own module, like local-tools-guard.ts, so the registry, the
 * tool filter and the tools can all import it.
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
  + 'Jarvis will not list windows, look at the screen, read or write the clipboard or act on desktop apps on any machine until the user turns it back on '
  + '(Settings > General > Desktop control, or desktop.enabled: true in config.yaml and a restart). '
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

/**
 * Screen awareness (#1314 m6). Turning it off blinds the pebble and pauses
 * the sidecar's own capture, so a tool that captures the screen is refused
 * too: the person's "stop looking" covers every way Jarvis looks.
 */
let screenSource: () => boolean = () => true;
export function setScreenCaptureEnabledSource(source: (() => boolean) | null): void {
  screenSource = source ?? (() => true);
}
/** Bind the switch to the daemon's live config (`awareness.enabled`), read through on every check. */
export function bindScreenCaptureSwitch(config: { awareness?: unknown }): void {
  setScreenCaptureEnabledSource(() => (config.awareness as { enabled?: unknown } | undefined)?.enabled !== false);
}
/** Whether screen capture is allowed. A reader that throws counts as OFF. */
export function isScreenCaptureEnabled(): boolean {
  try { return screenSource() !== false; } catch { return false; }
}
/** The tools that capture the screen. */
export const SCREEN_CAPTURE_TOOLS: ReadonlySet<string> = new Set(['desktop_screenshot', 'capture_screen', 'browser_screenshot']);
/**
 * Every tool that hands back what is on a screen (owner decision on #1314):
 * the screenshots above and the reads that return the screen as TEXT -- a
 * window's control tree, the window list, a found element, the accessibility
 * surface `ui_snapshot` reads and the surface diff `ui_act` returns. Turning
 * awareness off stops all of them, on every path, as it stops the screenshots.
 *
 * NOT here, by owner decision: `browser_navigate`, `browser_snapshot` and
 * `browser_evaluate`. They read the Jarvis browser's own tabs, in its own
 * browser, not what the person has on their screen, so they keep working with
 * awareness off. (`browser_screenshot` stays a screenshot and stays off.)
 */
export const BROWSER_PAGE_READS: ReadonlySet<string> = new Set(['browser_navigate', 'browser_snapshot', 'browser_evaluate']);
export const SCREEN_READ_TOOLS: ReadonlySet<string> = new Set([...SCREEN_CAPTURE_TOOLS,
  'desktop_snapshot', 'desktop_list_windows', 'desktop_find_element', 'ui_snapshot', 'ui_act',
  // A read by another name (#1314 review): a skill replay reads each surface
  // it acts on and reports what it saw (titles, new content, field values).
  'run_skill']);

/**
 * Whether this call hands back what is on a screen: a screen-read tool, a
 * desktop_click that reads a field's value (matched as the registry's enum
 * check matches, case-insensitively), or a skill recording, whose result
 * names the controls the person used.
 */
export function callReadsScreen(name: string | undefined, params: Record<string, unknown>): boolean {
  if (!name) return false;
  const action = typeof params.action === 'string' ? params.action.toLowerCase() : params.action;
  return SCREEN_READ_TOOLS.has(name) || (name === 'desktop_click' && action === 'get_value')
    || (name === 'record_skill' && action === 'start');
}

/** A refusal for a screen read made by a path that is not a tool call (a surface capture, a region). */
export function assertScreenReadAllowed(): void {
  if (isScreenCaptureEnabled()) return;
  throw new ActionOutcomeError({ status: 'blocked', code: SCREEN_CAPTURE_DISABLED_CODE, effect: 'not_started', message: SCREEN_CAPTURE_DISABLED_MESSAGE });
}

/**
 * An action's reply with the window titles it carries removed while
 * awareness is off (#1314 review): launching or focusing an app is allowed,
 * reading what its window says is not.
 */
export function withoutScreenText<T>(reply: T): T {
  if (isScreenCaptureEnabled() || !reply || typeof reply !== 'object') return reply;
  const copy: Record<string, unknown> = { ...(reply as Record<string, unknown>) };
  for (const key of ['title', 'window_title', 'note', 'toggle_state']) if (key in copy) copy[key] = '(hidden: screen awareness is off)';
  return copy as T;
}

export const SCREEN_CAPTURE_DISABLED_CODE = 'SCREEN_CAPTURE_DISABLED';
export const SCREEN_CAPTURE_DISABLED_MESSAGE =
  'Error: Screen awareness is turned off on this Jarvis, so this was not run: Jarvis does not take screenshots or read what is on a screen '
  + '(windows, controls, page text) on any machine until the user turns awareness back on. Do NOT retry; tell the user awareness is off.';

/** The refusal text for this call, or null when it may run. */
export function desktopRefusal(tool: Pick<ToolDefinition, 'category' | 'usesDesktop'> & { name?: string } | undefined, params: Record<string, unknown>): string | null {
  if (!tool) return null;
  if (callReadsScreen(tool.name, params) && !isScreenCaptureEnabled()) return SCREEN_CAPTURE_DISABLED_MESSAGE;
  if (isDesktopEnabled()) return null;
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
export function assertDesktopAllowed(tool: Pick<ToolDefinition, 'category' | 'usesDesktop'> & { name?: string }, params: Record<string, unknown>): void {
  const refusal = desktopRefusal(tool, params);
  if (refusal === null) return;
  throw new ActionOutcomeError({ status: 'blocked', code: refusal === SCREEN_CAPTURE_DISABLED_MESSAGE ? SCREEN_CAPTURE_DISABLED_CODE : DESKTOP_DISABLED_CODE,
    effect: 'not_started', message: refusal });
}

/**
 * The dynamic-prompt note for a switched-off desktop, or null while it is on.
 * States absence, like scopeSystemNote, because the cached tool guide still
 * documents the desktop tools.
 */
export function screenAwarenessOffSystemNote(): string | null {
  if (isScreenCaptureEnabled()) return null;
  return [
    '# Screen awareness is off',
    '',
    'The user has turned screen awareness off. The tool guide above documents tools that read the screen, '
    + 'but on this install you cannot take screenshots or read what is on any screen: '
    + `${[...SCREEN_READ_TOOLS].join(', ')} and desktop_click with action get_value are not available, and record_skill cannot start a recording. `
    + `The Jarvis browser's own tabs stay readable: ${[...BROWSER_PAGE_READS].join(', ')} still work. `
    + 'Do not read the screen another way, for example through shell commands. '
    + 'If the user asks about what is on their screen, say that screen awareness is off and that they can turn it back on.',
  ].join('\n');
}

export function desktopOffSystemNote(): string | null {
  if (isDesktopEnabled()) return null;
  return [
    '# Desktop control is off',
    '',
    'The user has turned desktop control off (desktop.enabled: false). The tool guide above documents the desktop tools, '
    + 'but on this install you cannot list windows, read the screen, read or write the clipboard, or click, type, press keys, launch or focus apps on any machine: '
    + `the desktop_* tools, capture_screen, get_clipboard and set_clipboard are not available, ${isScreenCaptureEnabled() ? 'ui_snapshot, ui_act and run_skill work only on the browser' : 'and with screen awareness off ui_snapshot, ui_act, run_skill and browser_screenshot are not available either (browser_navigate, browser_snapshot and browser_evaluate still work)'}, `
    + 'and record_skill cannot start a recording. '
    + 'Do not try to reach the desktop another way, for example through shell commands. '
    + 'If the user asks for something on their desktop, say that desktop control is off and that they can turn it back on '
    + 'in Settings > General > Desktop control, or by setting desktop.enabled to true in config.yaml and restarting Jarvis.',
  ].join('\n');
}

/** The tools to offer: drops the always-desktop ones while the switch is off. */
export function withoutDisabledDesktopTools<T extends Pick<ToolDefinition, 'category' | 'usesDesktop'> & { name?: string }>(tools: readonly T[]): readonly T[] {
  const screen = isScreenCaptureEnabled();
  if (isDesktopEnabled() && screen) return tools;
  return tools.filter((tool) => !(!isDesktopEnabled() && toolAlwaysUsesDesktop(tool)) && !(!screen && tool.name && SCREEN_READ_TOOLS.has(tool.name)));
}
