/**
 * OS permissions, asked of the machine the dashboard is actually being looked
 * at on.
 *
 * The onboarding wizard's Permissions screen used to be static HTML: four rows
 * whose buttons called window.open("x-apple.systempreferences:...") and whose
 * status was never read at all. Neither half could work. A panel routes
 * window.open through the sidecar host, which allowlists http(s) (see
 * isExternallyOpenable in sidecar/panels_extnav.go), so the scheme was dropped
 * on the floor with a log line and no window ever appeared; and with no status
 * to read, a granted permission and a denied one looked identical. The user was
 * told to grant four things by a screen that could neither grant them nor tell
 * whether they had been.
 *
 * Both halves have to happen in the SIDECAR process, which is what this module
 * reaches: it opens the pane with an `open` from the desktop app, and it reads
 * the same TCC state the native `jarvis --setup` wizard reads (one source of
 * truth - the two screens cannot disagree about what is granted).
 *
 * WHICH MACHINE. The brain is not necessarily on the user's desktop (a hosted
 * install certainly is not), and it can have several sidecars enrolled. The
 * question "what has been granted" is meaningless without a machine, so this
 * resolves one and REFUSES rather than guessing when it cannot - the wizard
 * showing a row for someone else's laptop is worse than showing no row.
 */

import type { RPCTimeouts } from '../sidecar/protocol.ts';

/** What the OS says about one permission. "na" = no such concept here. */
export type PermissionStatus = 'granted' | 'denied' | 'undetermined' | 'na';

/**
 * How a permission is obtained, which is the only distinction the screen has
 * to render: a "prompt" row can be granted without leaving the app, a "pane"
 * row can only be granted by the user flipping a toggle in System Settings.
 */
export type PermissionGrantMode = 'prompt' | 'pane' | 'none';

export interface PermissionRow {
  name: string;
  status: PermissionStatus;
  grant: PermissionGrantMode;
}

/**
 * Why there is no answer. Each is a different sentence on screen, which is the
 * point of distinguishing them - "no desktop app is connected" and "your
 * desktop app is too old" send the user to completely different places.
 */
export type PermissionsUnavailable =
  | 'no_sidecar' // nothing connected to ask
  | 'offline' // this page's own machine is known, but its app is not connected
  | 'ambiguous' // several machines connected and nothing says which is this one
  | 'unsupported' // connected, but too old to know the RPC
  | 'refused' // it answered, and the answer was no
  | 'unreachable'; // connected, but the call failed or never came back

/** The machine an answer is about, so the screen can name it. */
export interface PermissionsHostInfo {
  id: string;
  name: string;
  hostname: string;
  /**
   * How it was identified. 'panel' means this page is literally being rendered
   * by that sidecar's webview, so "your machine" is safe to say. 'only_connected'
   * is an inference from there being exactly one candidate - true on every
   * ordinary local install, but the screen should name the host rather than
   * assume the user is sitting at it.
   */
  source: 'panel' | 'only_connected';
}

export type PermissionsResult =
  | {
      available: true;
      host: PermissionsHostInfo;
      platform: string;
      /**
       * False when macOS TCC has no app identity to attach grants to (a bare
       * binary instead of Jarvis.app). The rows then describe whatever launched
       * the sidecar - usually a terminal - so the screen must say so instead of
       * inviting the user to grant permissions to the wrong app.
       */
      bundled: boolean;
      permissions: PermissionRow[];
    }
  | { available: false; reason: PermissionsUnavailable; detail?: string };

/** The result of asking for one permission. */
export type PermissionRequestResult =
  | {
      available: true;
      host: PermissionsHostInfo;
      name: string;
      grant: PermissionGrantMode;
      /** Did System Settings actually come up? Only meaningful for a "pane" row. */
      paneOpened: boolean;
      paneError?: string;
      permissions: PermissionRow[];
    }
  | { available: false; reason: PermissionsUnavailable; detail?: string };

/**
 * The permissions this product asks about, and nothing else.
 *
 * Deliberately does NOT include Automation or Files & Folders, which the old
 * screen listed. Their TCC panes are EMPTY until the app has already tried the
 * thing they gate, so there is nothing to pre-grant and a link there shows the
 * user a list Jarvis is not in. macOS prompts for both in the moment, which is
 * the only time they can be granted.
 *
 * Checked here as well as in the sidecar. The name selects a System Settings
 * deep link that the sidecar hands to `open`, and defence in depth on the
 * pathway from an HTTP body to a process launch is cheap.
 */
export const PERMISSION_NAMES = ['notifications', 'microphone', 'screen', 'accessibility'] as const;
export type PermissionName = (typeof PERMISSION_NAMES)[number];

export function isPermissionName(value: unknown): value is PermissionName {
  return typeof value === 'string' && (PERMISSION_NAMES as readonly string[]).includes(value);
}

/**
 * These calls are a status read and a window open, both of which are instant or
 * broken. The 30s default would leave the wizard's spinner up for half a minute
 * on a wedged sidecar and then resolve to the string "detached", which is not an
 * answer anyone can render.
 */
const PERMISSION_RPC_TIMEOUTS: RPCTimeouts = { initial: 8_000, max: 15_000 };

/** The slice of SidecarManager this needs. Narrow on purpose: it makes the
 *  resolution rules - which are the interesting part - testable without a
 *  running brain. */
export interface PermissionsSidecarHost {
  resolvePanelSession(sessionId: string): { sid: string } | null;
  getConnectedSidecars(): Array<{ id: string; name: string; hostname: string }>;
  dispatchRPC(
    sidecarId: string,
    method: string,
    params?: Record<string, unknown>,
    timeouts?: RPCTimeouts,
  ): Promise<unknown>;
}

/**
 * Which sidecar this page's question is about.
 *
 * The panel session is the answer whenever there is one: the cookie was minted
 * for a webview that a specific sidecar spawned, so it identifies the machine
 * the user is looking at, even with a dozen others enrolled.
 *
 * The fallback matters more than it looks. A dashboard opened at
 * localhost:3142 in a real browser has no panel cookie, and neither does ANY
 * page when auth.insecure_open_access is set (the whole session exchange is
 * skipped) - which is the setup-time configuration, i.e. exactly when the
 * onboarding wizard runs. With one sidecar connected there is no ambiguity to
 * resolve; with several, refuse, because picking one at random would show the
 * user their other laptop's permissions and open panes there.
 */
export function resolvePermissionsHost(
  host: PermissionsSidecarHost,
  panelSessionId: string | null,
): PermissionsHostInfo | { reason: 'no_sidecar' | 'offline' | 'ambiguous' } {
  const connected = host.getConnectedSidecars();

  if (panelSessionId) {
    const session = host.resolvePanelSession(panelSessionId);
    if (session) {
      const match = connected.find((s) => s.id === session.sid);
      if (match) {
        return { id: match.id, name: match.name, hostname: match.hostname, source: 'panel' };
      }
      // The session names a machine that is not connected this second. That is
      // still POSITIVE knowledge of where the user is sitting, so it ends the
      // search: falling through to "the only other one that happens to be up"
      // would answer for, and open panes on, a different computer. Sessions
      // deliberately outlive a disconnect (see panel-sessions.ts), and a
      // hosted update restarts the brain while sidecars reconnect at their own
      // pace, so this gap is ordinary rather than exotic.
      return { reason: 'offline' };
    }
  }

  if (connected.length === 1) {
    const only = connected[0]!;
    return { id: only.id, name: only.name, hostname: only.hostname, source: 'only_connected' };
  }
  return { reason: connected.length === 0 ? 'no_sidecar' : 'ambiguous' };
}

/**
 * Classify a failed dispatch.
 *
 * The one that must not be lumped in with the rest is METHOD_NOT_FOUND. Sidecars
 * update independently of the brain, so a machine enrolled before this shipped
 * answers every call with it - a permanent, expected condition that deserves
 * "your desktop app is too old", not a red error the user will retry forever.
 */
function classifyDispatchFailure(err: unknown): { reason: PermissionsUnavailable; detail: string } {
  const detail = err instanceof Error ? err.message : String(err);
  if (detail.includes('METHOD_NOT_FOUND')) return { reason: 'unsupported', detail };
  // A refusal is not a silence. The sidecar answers HANDLER_ERROR for real,
  // considered nos -- "cannot be requested on linux", "not running as an app
  // bundle" -- and describing a prompt, correct answer as "the app did not
  // respond" sends the user to look for a problem that is not there.
  if (detail.includes('HANDLER_ERROR')) {
    return { reason: 'refused', detail: detail.replace(/^HANDLER_ERROR:\s*/, '') };
  }
  return { reason: 'unreachable', detail };
}

/**
 * A dispatch that resolves to the literal string "detached" hit the initial
 * timeout: the sidecar has not answered and may answer much later, to nobody.
 * For a status read that is a failure, not a pending success.
 */
function isDetached(result: unknown): boolean {
  return result === 'detached';
}

/** Diagnosing a shape mismatch from a user's screenshot is impossible without
 *  this: the reply is discarded on the way to a one-sentence `detail`. */
function warnUnreadable(sidecarId: string, method: string, raw: unknown): void {
  let sample: string;
  try {
    sample = JSON.stringify(raw)?.slice(0, 300) ?? String(raw);
  } catch {
    sample = String(raw);
  }
  console.warn(`[API] ${method} from sidecar ${sidecarId} was unreadable: ${sample}`);
}

interface RawReport {
  platform?: unknown;
  bundled?: unknown;
  permissions?: unknown;
}

/**
 * Shape-check what came back over the wire.
 *
 * The sidecar is a separate, independently-updated program, so its answer is
 * input rather than a value this code produced. A half-understood report
 * rendered as rows would invent statuses; better to report the machine as
 * unreadable.
 */
function parseRows(value: unknown): PermissionRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: PermissionRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const { name, status, grant } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || typeof status !== 'string' || typeof grant !== 'string') return null;
    if (!['granted', 'denied', 'undetermined', 'na'].includes(status)) return null;
    if (!['prompt', 'pane', 'none'].includes(grant)) return null;
    rows.push({ name, status: status as PermissionStatus, grant: grant as PermissionGrantMode });
  }
  return rows;
}

/** Read the machine's permission state. */
export async function readSystemPermissions(
  host: PermissionsSidecarHost,
  panelSessionId: string | null,
): Promise<PermissionsResult> {
  const target = resolvePermissionsHost(host, panelSessionId);
  if ('reason' in target) return { available: false, reason: target.reason };

  let raw: unknown;
  try {
    raw = await host.dispatchRPC(target.id, 'system.permissions', {}, PERMISSION_RPC_TIMEOUTS);
  } catch (err) {
    return { available: false, ...classifyDispatchFailure(err) };
  }
  if (isDetached(raw)) {
    return { available: false, reason: 'unreachable', detail: 'the desktop app did not answer in time' };
  }

  const report = (raw ?? {}) as RawReport;
  const rows = parseRows(report.permissions);
  if (typeof report.platform !== 'string' || rows === null) {
    warnUnreadable(target.id, 'system.permissions', raw);
    return { available: false, reason: 'unreachable', detail: 'the desktop app sent an answer this brain cannot read' };
  }

  return {
    available: true,
    host: target,
    platform: report.platform,
    // Absent means an older report shape; assume bundled rather than showing
    // the "grants are attaching to the wrong app" warning to everyone.
    bundled: report.bundled !== false,
    permissions: rows,
  };
}

/** Ask the machine for one permission. */
export async function requestSystemPermission(
  host: PermissionsSidecarHost,
  panelSessionId: string | null,
  name: PermissionName,
): Promise<PermissionRequestResult> {
  const target = resolvePermissionsHost(host, panelSessionId);
  if ('reason' in target) return { available: false, reason: target.reason };

  let raw: unknown;
  try {
    raw = await host.dispatchRPC(target.id, 'system.request_permission', { name }, PERMISSION_RPC_TIMEOUTS);
  } catch (err) {
    return { available: false, ...classifyDispatchFailure(err) };
  }
  if (isDetached(raw)) {
    return { available: false, reason: 'unreachable', detail: 'the desktop app did not answer in time' };
  }

  // As strict as the read path, and for the same reason: the sidecar is an
  // independently-updated program. Being lenient here would turn a renamed
  // field into a silent "nothing to do on this platform" -- available: true,
  // grant: 'none', no rows, no error -- which is precisely the confident wrong
  // answer this whole change exists to delete.
  const result = (raw ?? {}) as Record<string, unknown>;
  const rows = parseRows(result.permissions);
  const grant = typeof result.grant === 'string' && ['prompt', 'pane', 'none'].includes(result.grant)
    ? (result.grant as PermissionGrantMode)
    : null;
  if (rows === null || grant === null) {
    warnUnreadable(target.id, 'system.request_permission', raw);
    return { available: false, reason: 'unreachable', detail: 'the desktop app sent an answer this brain cannot read' };
  }

  return {
    available: true,
    host: target,
    name,
    grant,
    paneOpened: result.pane_opened === true,
    ...(typeof result.pane_error === 'string' ? { paneError: result.pane_error } : {}),
    permissions: rows,
  };
}
