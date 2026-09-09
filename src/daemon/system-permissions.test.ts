import { describe, expect, test } from 'bun:test';
import {
  isPermissionName,
  PERMISSION_NAMES,
  readSystemPermissions,
  requestSystemPermission,
  resolvePermissionsHost,
  type PermissionsSidecarHost,
} from './system-permissions.ts';

/**
 * The interesting part of this module is not the dispatch - it is deciding
 * WHICH machine a "what have you granted" question is about, and refusing to
 * answer rather than guessing. A wrong answer here shows a user their other
 * laptop's permissions and opens System Settings on it.
 */

type Sidecar = { id: string; name: string; hostname: string };

function fakeHost(opts: {
  connected?: Sidecar[];
  sessions?: Record<string, string>;
  dispatch?: (id: string, method: string, params: Record<string, unknown>) => Promise<unknown>;
}): PermissionsSidecarHost & { calls: Call[] } {
  const connected = opts.connected ?? [];
  const calls: Call[] = [];
  return {
    calls,
    getConnectedSidecars: () => connected,
    resolvePanelSession: (sessionId) => {
      const sid = opts.sessions?.[sessionId];
      return sid ? { sid } : null;
    },
    dispatchRPC: async (id, method, params = {}, timeouts) => {
      calls.push({ id, method, params, timeouts });
      if (!opts.dispatch) throw new Error('no dispatch configured');
      return opts.dispatch(id, method, params);
    },
  };
}

interface Call {
  id: string;
  method: string;
  params: Record<string, unknown>;
  timeouts?: { initial: number; max: number };
}

const MAC: Sidecar = { id: 'sc-mac', name: 'Desk Mac', hostname: 'desk.local' };
const OTHER: Sidecar = { id: 'sc-laptop', name: 'Laptop', hostname: 'laptop.local' };

const OK_REPORT = {
  platform: 'darwin',
  bundled: true,
  permissions: [
    { name: 'notifications', status: 'undetermined', grant: 'prompt' },
    { name: 'microphone', status: 'granted', grant: 'prompt' },
    { name: 'screen', status: 'denied', grant: 'pane' },
    { name: 'accessibility', status: 'denied', grant: 'pane' },
  ],
};

describe('resolvePermissionsHost', () => {
  test('the panel session wins, even with other machines connected', () => {
    const host = fakeHost({ connected: [OTHER, MAC], sessions: { 'sess-1': MAC.id } });
    expect(resolvePermissionsHost(host, 'sess-1')).toEqual({
      id: MAC.id, name: MAC.name, hostname: MAC.hostname, source: 'panel',
    });
  });

  test('one connected sidecar and no cookie is unambiguous', () => {
    // The case that matters: auth.insecure_open_access skips the whole session
    // exchange, and that is the SETUP-time configuration -- exactly when the
    // onboarding wizard runs. Without this fallback the wizard would have no
    // answer on the most ordinary install there is.
    const host = fakeHost({ connected: [MAC] });
    expect(resolvePermissionsHost(host, null)).toEqual({
      id: MAC.id, name: MAC.name, hostname: MAC.hostname, source: 'only_connected',
    });
  });

  test('several connected and no session refuses instead of picking one', () => {
    const host = fakeHost({ connected: [MAC, OTHER] });
    expect(resolvePermissionsHost(host, null)).toEqual({ reason: 'ambiguous' });
  });

  test('nothing connected says so', () => {
    expect(resolvePermissionsHost(fakeHost({}), null)).toEqual({ reason: 'no_sidecar' });
  });

  test('a session whose sidecar is offline never answers for another machine', () => {
    // The session says the user is at the Mac. The Mac's app is not connected
    // this second (asleep, quit, or reconnecting after a hosted restart, which
    // sessions deliberately outlive). Falling through to "the only other one
    // that happens to be up" would show the laptop's rows and open panes on
    // the laptop, while the user watches the Mac.
    const host = fakeHost({ connected: [OTHER], sessions: { 'sess-1': MAC.id } });
    expect(resolvePermissionsHost(host, 'sess-1')).toEqual({ reason: 'offline' });
  });

  test('an offline session refuses even when its own machine is the only one enrolled', () => {
    const host = fakeHost({ connected: [], sessions: { 'sess-1': MAC.id } });
    expect(resolvePermissionsHost(host, 'sess-1')).toEqual({ reason: 'offline' });
  });

  test('an unknown or revoked session falls back rather than trusting it', () => {
    const host = fakeHost({ connected: [MAC, OTHER] });
    expect(resolvePermissionsHost(host, 'sess-revoked')).toEqual({ reason: 'ambiguous' });
  });
});

describe('readSystemPermissions', () => {
  test('a good report comes back with the host that answered it', async () => {
    const host = fakeHost({ connected: [MAC], dispatch: async () => OK_REPORT });
    const res = await readSystemPermissions(host, null);
    expect(res.available).toBe(true);
    if (!res.available) return;
    expect(res.platform).toBe('darwin');
    expect(res.bundled).toBe(true);
    expect(res.permissions.map((p) => p.name)).toEqual([...PERMISSION_NAMES]);
    expect(res.host.name).toBe('Desk Mac');
    expect(host.calls[0]).toMatchObject({ id: MAC.id, method: 'system.permissions' });
  });

  test('a sidecar too old to know the method reads as unsupported, not broken', async () => {
    // Sidecars update independently of the brain, so every machine enrolled
    // before this shipped answers this way. It is a permanent, expected
    // condition that needs its own sentence -- "update your desktop app" --
    // not a red error the user retries forever.
    const host = fakeHost({
      connected: [MAC],
      dispatch: async () => { throw new Error('METHOD_NOT_FOUND: Unknown method: system.permissions'); },
    });
    expect(await readSystemPermissions(host, null)).toEqual({
      available: false,
      reason: 'unsupported',
      detail: 'METHOD_NOT_FOUND: Unknown method: system.permissions',
    });
  });

  test('any other dispatch failure reads as unreachable', async () => {
    const host = fakeHost({
      connected: [MAC],
      dispatch: async () => { throw new Error('Sidecar disconnected: disconnected'); },
    });
    const res = await readSystemPermissions(host, null);
    expect(res).toMatchObject({ available: false, reason: 'unreachable' });
  });

  test('a dispatch that detaches is a failure, not a pending success', async () => {
    // dispatchRPC resolves with the literal string "detached" at the initial
    // timeout. Rendering that as a report would print rows made of undefined.
    const host = fakeHost({ connected: [MAC], dispatch: async () => 'detached' });
    const res = await readSystemPermissions(host, null);
    expect(res).toMatchObject({ available: false, reason: 'unreachable' });
  });

  test('a malformed report is refused rather than half-rendered', async () => {
    // The sidecar is a separate, independently-updated program; its answer is
    // input. Inventing a status from a shape we do not understand is worse
    // than saying the machine is unreadable.
    for (const bad of [
      null,
      {},
      { platform: 'darwin' },
      { platform: 'darwin', permissions: 'nope' },
      { platform: 'darwin', permissions: [{ name: 'screen' }] },
      { platform: 'darwin', permissions: [{ name: 'screen', status: 'maybe', grant: 'pane' }] },
      { platform: 'darwin', permissions: [{ name: 'screen', status: 'denied', grant: 'telepathy' }] },
      { platform: 42, permissions: [] },
    ]) {
      const host = fakeHost({ connected: [MAC], dispatch: async () => bad });
      const res = await readSystemPermissions(host, null);
      expect(res.available).toBe(false);
    }
  });

  test('an older report with no bundled flag is not treated as unbundled', async () => {
    // bundled:false triggers a warning that the grants are attaching to the
    // wrong app. Defaulting a missing field to false would show that to
    // everyone running a slightly older sidecar.
    const host = fakeHost({
      connected: [MAC],
      dispatch: async () => ({ platform: 'darwin', permissions: OK_REPORT.permissions }),
    });
    const res = await readSystemPermissions(host, null);
    expect(res.available && res.bundled).toBe(true);
  });

  test('no machine to ask never reaches the wire', async () => {
    const host = fakeHost({});
    expect(await readSystemPermissions(host, null)).toEqual({ available: false, reason: 'no_sidecar' });
    expect(host.calls).toHaveLength(0);
  });
});

describe('requestSystemPermission', () => {
  test('passes the name through and reports where the pane landed', async () => {
    const host = fakeHost({
      connected: [MAC],
      dispatch: async () => ({
        name: 'accessibility', grant: 'pane', pane_opened: true, permissions: OK_REPORT.permissions,
      }),
    });
    const res = await requestSystemPermission(host, null, 'accessibility');
    expect(res.available).toBe(true);
    if (!res.available) return;
    expect(res.grant).toBe('pane');
    expect(res.paneOpened).toBe(true);
    expect(res.paneError).toBeUndefined();
    expect(host.calls[0]).toMatchObject({
      method: 'system.request_permission', params: { name: 'accessibility' },
    });
  });

  test('a pane that failed to open is reported, not swallowed', async () => {
    // Silently claiming a window opened is the original bug in miniature.
    const host = fakeHost({
      connected: [MAC],
      dispatch: async () => ({
        name: 'screen', grant: 'pane', pane_opened: false, pane_error: 'exec: "open": not found',
        permissions: OK_REPORT.permissions,
      }),
    });
    const res = await requestSystemPermission(host, null, 'screen');
    expect(res.available && res.paneOpened).toBe(false);
    expect(res.available && res.paneError).toBe('exec: "open": not found');
  });

  test('a truthy-looking pane_opened that is not true stays false', async () => {
    const host = fakeHost({
      connected: [MAC],
      dispatch: async () => ({ name: 'screen', grant: 'pane', pane_opened: 'yes', permissions: [] }),
    });
    const res = await requestSystemPermission(host, null, 'screen');
    expect(res.available && res.paneOpened).toBe(false);
  });
});

describe('isPermissionName', () => {
  test('accepts exactly the four rows the product asks about', () => {
    for (const name of PERMISSION_NAMES) expect(isPermissionName(name)).toBe(true);
  });

  test('rejects everything else, including the two rows this change removed', () => {
    // Automation and Files & Folders were on the old screen and could never
    // work: their TCC panes are empty until the app has already asked.
    for (const bad of ['automation', 'files', 'full_disk', '', 'SCREEN', 'screen ', null, 42, {}]) {
      expect(isPermissionName(bad)).toBe(false);
    }
  });
});

describe('failure classification and strictness', () => {
  test('a considered refusal is not reported as silence', async () => {
    // The sidecar answers HANDLER_ERROR for real nos: "cannot be requested on
    // linux", "not running as an app bundle". Calling that "the app did not
    // answer" sends the user hunting a problem that is not there.
    const host = fakeHost({
      connected: [MAC],
      dispatch: async () => {
        throw new Error('HANDLER_ERROR: not running as an app bundle: a grant would attach to the launching app');
      },
    });
    const res = await requestSystemPermission(host, null, 'screen');
    expect(res).toEqual({
      available: false,
      reason: 'refused',
      detail: 'not running as an app bundle: a grant would attach to the launching app',
    });
  });

  test('a malformed request reply is refused, not read as "nothing to do"', async () => {
    // Being lenient here turns a renamed field into available:true, grant:
    // 'none', no rows and no error -- a confident wrong answer.
    for (const bad of [null, true, 'ok', {}, { grant: 'pane' }, { grant: 'telepathy', permissions: [] }, { grant: 'pane', permissions: 'nope' }]) {
      const host = fakeHost({ connected: [MAC], dispatch: async () => bad });
      const res = await requestSystemPermission(host, null, 'screen');
      expect(res.available).toBe(false);
    }
  });

  test('both calls ask for the short timeouts, not the 30s default', async () => {
    // Losing these would put a wedged sidecar behind a half-minute spinner
    // that then resolves to the string "detached".
    const host = fakeHost({ connected: [MAC], dispatch: async () => OK_REPORT });
    await readSystemPermissions(host, null);
    await requestSystemPermission(host, null, 'screen').catch(() => {});
    expect(host.calls).toHaveLength(2);
    for (const call of host.calls) {
      expect(call.timeouts).toEqual({ initial: 8_000, max: 15_000 });
    }
  });
});
