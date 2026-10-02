import { afterEach, describe, expect, test } from "bun:test";
import type { SidecarManager } from "../../sidecar/manager.ts";
import type { SidecarInfo } from "../../sidecar/types.ts";
import { setNoLocalTools } from "./local-tools-guard.ts";
import { collectExecutionTargets, resolveToolTarget, routeToSidecar, setSidecarManagerRef } from "./sidecar-route.ts";
import { routeToSidecarAction } from './sidecar-route.ts';
import { DESKTOP_TOOLS } from './desktop.ts';
import { SidecarRPCError } from '../../sidecar/rpc.ts';

const mac: SidecarInfo = {
  id: "sc-mac",
  name: "Lapo's MacBook",
  enrolled_at: "2026-01-01",
  last_seen_at: "2026-01-02",
  status: "enrolled",
  connected: true,
  hostname: "lapo-mbp",
  os: "darwin",
  platform: "arm64",
  capabilities: ["terminal", "desktop"],
};

/**
 * Await a call that must REJECT, and hand back the error.
 *
 * `.catch((e) => e)` would turn an unexpected RESOLVE into
 * `expect(undefined).toMatchObject(...)`, which reads as a shape mismatch
 * rather than as "this was supposed to throw".
 */
async function rejection(call: () => Promise<unknown>): Promise<any> {
  try {
    const out = await call();
    throw new Error(`expected a rejection, got: ${JSON.stringify(out)}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('expected a rejection')) throw e;
    return e;
  }
}

describe('typed desktop outcomes', () => {
  for (const tool of DESKTOP_TOOLS) test(`${tool.name}: offline prevents dispatch`, async () => {
    let calls = 0;
    setSidecarManagerRef(stubManager([{ ...mac, connected: false }], async () => { calls++; return 'ok'; }));
    await expect(tool.execute({ target: mac.id })).rejects.toMatchObject({
      outcome: { status: 'blocked', code: 'SIDECAR_OFFLINE', effect: 'not_started' },
    });
    expect(calls).toBe(0);
  });

  for (const [label, sidecars, code] of [
    ['missing machine', [], 'SIDECAR_NOT_FOUND'],
    ['disabled capability', [{ ...mac, capabilities: [] }], 'CAPABILITY_DISABLED'],
    ['unavailable capability', [{ ...mac, unavailable_capabilities: [{ name: 'desktop', reason: 'dependency missing' }] }], 'CAPABILITY_UNAVAILABLE'],
  ] as const) test(label, async () => {
    let calls = 0;
    setSidecarManagerRef(stubManager(sidecars as unknown as SidecarInfo[], async () => { calls++; return 'ok'; }));
    await expect(routeToSidecarAction(mac.id, 'click_element', {}, 'desktop')).rejects.toMatchObject({
      outcome: { status: 'blocked', code, effect: 'not_started' },
    });
    expect(calls).toBe(0);
  });

  for (const [label, dispatch, status, code] of [
    ['timeout', async () => 'detached', 'unknown', 'SIDECAR_TIMEOUT'],
    ['disconnect', async () => { throw new Error('Sidecar disconnected'); }, 'unknown', 'SIDECAR_OUTCOME_UNKNOWN'],
    ['remote rejection', async () => { throw new SidecarRPCError('ACTION_FAILED', 'failed after starting'); }, 'error', 'ACTION_FAILED'],
    ['missing method', async () => { throw new SidecarRPCError('METHOD_NOT_FOUND', 'not enabled'); }, 'blocked', 'METHOD_NOT_FOUND'],
    ['negative receipt', async () => ({ success: false, window_visible: false }), 'error', 'SIDECAR_ACTION_FAILED'],
  ] as const) test(label, async () => {
    setSidecarManagerRef(stubManager([mac], dispatch));
    await expect(routeToSidecarAction(mac.id, 'launch_app', {}, 'desktop')).rejects.toMatchObject({
      outcome: { status, code, effect: status === 'blocked' ? 'not_started' : 'may_have_occurred' },
    });
  });

  test('a chord the sidecar refused before pressing anything is not started', async () => {
    // sidecar/desktop_linux.go sends DESKTOP_INVALID_KEYS for a key name it
    // will not pass to xdotool (#518): the model should fix the name, not
    // go and check whether a key was pressed.
    setSidecarManagerRef(stubManager([mac], async () => {
      throw new SidecarRPCError('DESKTOP_INVALID_KEYS', 'press_keys refused, nothing was pressed: invalid key name "-h"');
    }));
    await expect(routeToSidecarAction(mac.id, 'press_keys', { keys: '-h' }, 'desktop')).rejects.toMatchObject({
      outcome: { status: 'error', code: 'DESKTOP_INVALID_KEYS', effect: 'not_started' },
    });
  });

  test('an unverified launch window stays an unverified success, note and pid intact', async () => {
    // launchResultLinux/launchResultDarwin report this as success on purpose:
    // calling it a failure makes the model launch an app that is already open.
    const reply = { success: true, window_visible: null, pid: 4242, note: 'could NOT be checked' };
    setSidecarManagerRef(stubManager([mac], async () => reply));
    expect(JSON.parse(await routeToSidecarAction(mac.id, 'launch_app', {}, 'desktop'))).toEqual(reply);
  });

  test('a reported failure leads with what the handler said, pid and note both surviving', async () => {
    // #627: this used to be `JSON.stringify(reply)`, so the one field the model
    // needed arrived inside a serialised struct. The note now leads the
    // sentence and the pid follows it -- the earlier decision that neither is
    // lost still holds, it is just no longer a struct.
    setSidecarManagerRef(stubManager([mac], async () => ({ success: false, pid: 7, note: 'no window appeared' })));
    const err = await rejection(() => routeToSidecarAction(mac.id, 'launch_app', {}, 'desktop'));
    expect(err.outcome).toMatchObject({ status: 'error', code: 'SIDECAR_ACTION_FAILED', effect: 'may_have_occurred' });
    const msg = err.outcome.message as string;
    expect(msg).toContain('reported failure: no window appeared');
    expect(msg).toContain('pid=7');
    // Not a serialised struct any more, and not carrying the flag that
    // selected this branch.
    expect(msg).not.toContain('"success"');
    expect(msg).not.toContain('{"');
  });

  test('`error` is preferred over `note`, which is how Linux focus_window reports', async () => {
    // sidecar/desktop_linux.go's handleFocusWindow returns
    // {success:false, pid, error: <xdotool stderr>}.
    setSidecarManagerRef(stubManager([mac], async () => ({ success: false, pid: 9, error: 'xdotool: no such window', note: 'try again' })));
    const err = await rejection(() => routeToSidecarAction(mac.id, 'focus_window', {}, 'desktop'));
    expect(err.outcome.message).toContain('reported failure: xdotool: no such window');
    expect(err.outcome.message).toContain('note=try again');
  });

  test('a reply with nothing readable still carries the whole object', async () => {
    // The fallback, and the reason it has to stay: `window_visible: false` with
    // no sentence beside it is all some negative probes send.
    setSidecarManagerRef(stubManager([mac], async () => ({ success: false, window_visible: false })));
    const err = await rejection(() => routeToSidecarAction(mac.id, 'launch_app', {}, 'desktop'));
    expect(err.outcome).toMatchObject({ status: 'error', code: 'SIDECAR_ACTION_FAILED', effect: 'may_have_occurred' });
    expect(err.outcome.message).toContain('"window_visible":false');
  });

  test('a non-string error field is not read as the sentence', async () => {
    // The reply is JSON from another machine and the validator preserves arrays
    // verbatim, so a `string` annotation TypeScript erases would have coerced
    // this into the sentence.
    setSidecarManagerRef(stubManager([mac], async () => ({ success: false, error: ['injected'], note: 'the real note' })));
    const err = await rejection(() => routeToSidecarAction(mac.id, 'launch_app', {}, 'desktop'));
    expect(err.outcome.message).toContain('reported failure: the real note');
    expect(err.outcome.message).toContain('error=["injected"]');
  });

  test('one long remote field cannot push the rest of the sentence out', async () => {
    setSidecarManagerRef(stubManager([mac], async () => ({ success: false, error: 'z'.repeat(50_000), pid: 3 })));
    const err = await rejection(() => routeToSidecarAction(mac.id, 'launch_app', {}, 'desktop'));
    const msg = err.outcome.message as string;
    expect(msg.length).toBeLessThan(1500);
    expect(msg).toContain('truncated, was 50000 chars');
    expect(msg).toContain('pid=3');
  });

  /**
   * Each of these produced tens of kilobytes from per-field caps alone, because
   * the field COUNT, the key NAMES and a non-string VALUE are all separately
   * chosen by whatever is on the other end of the socket.
   */
  for (const [label, reply] of [
    ['a reply with thousands of fields',
      { success: false, error: 'nope', ...Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i])) }],
    ['a huge non-string value',
      { success: false, error: 'nope', frames: Array.from({ length: 20_000 }, (_, i) => i) }],
    ['a huge key name',
      { success: false, error: 'nope', ['k'.repeat(20_000)]: 1 }],
  ] as const) test(`${label} is bounded in total`, async () => {
    setSidecarManagerRef(stubManager([mac], async () => reply));
    const err = await rejection(() => routeToSidecarAction(mac.id, 'launch_app', {}, 'desktop'));
    const msg = err.outcome.message as string;
    expect(`${label}:${msg.length < 1500}`).toBe(`${label}:true`);
    // Bounded, not emptied: the sentence the handler sent still leads.
    expect(msg).toContain('reported failure: nope');
    // And the triple is still the one #605 established -- the bound must not
    // have been bought by letting the helper throw into the catch below it.
    expect(err.outcome).toMatchObject({ status: 'error', code: 'SIDECAR_ACTION_FAILED', effect: 'may_have_occurred' });
  });

  test('a demoted sentence field keeps the full budget in the tail', async () => {
    // A sidecar can push the real cause into `note` by also sending a bland
    // `error`. The order still prefers `error`, but `note` is not cut to the
    // incidental 120 the way an unrelated field is.
    const cause = 'c'.repeat(400);
    setSidecarManagerRef(stubManager([mac], async () => ({ success: false, error: 'operation completed', note: cause, other: 'o'.repeat(400) })));
    const err = await rejection(() => routeToSidecarAction(mac.id, 'launch_app', {}, 'desktop'));
    const msg = err.outcome.message as string;
    expect(msg).toContain(`note=${cause}`);
    expect(msg).toContain('other=' + 'o'.repeat(120) + '... (truncated, was 400 chars)');
  });

  test('data containing the word Error is not classified as a failed action', async () => {
    setSidecarManagerRef(stubManager([mac], async () => 'Error: the title of a visible window'));
    expect(await routeToSidecarAction(mac.id, 'list_windows', {}, 'desktop')).toBe('Error: the title of a visible window');
  });
});

/**
 * #605. These three refusals used to be two sentences between them, and the
 * model acted on the wrong one: an old sidecar was reported as a disabled
 * capability, so the user was sent to a config file that was fine.
 *
 * The assertions are on the REMEDY, not on phrasing, because the remedy is what
 * the model acts on. Each test also asserts the absence of the OTHER remedy:
 * a message that names both is as useless as one that names the wrong one.
 */
describe('an old sidecar and a disabled capability are different conditions (#605)', () => {
  /** The text a model-facing tool gets. Legacy text path, which is what builtin.ts uses. */
  const refusalFor = async (sidecars: SidecarInfo[],
    dispatch?: (id: string, method: string, params: Record<string, unknown>) => Promise<unknown>) => {
    setSidecarManagerRef(stubManager(sidecars, dispatch));
    return routeToSidecar(mac.id, 'browser_element_point', {}, 'browser');
  };
  const missingMethod = async () => { throw new SidecarRPCError('METHOD_NOT_FOUND', 'Unknown method: browser_element_point'); };
  const withBrowser = { ...mac, capabilities: ['browser'] as SidecarInfo['capabilities'] };
  /** The two remedies that must never both appear, and never swap. */
  const SETTING = /ask the user to enable it in the sidecar's config/;
  const UPDATE = /ask the user to (update the sidecar|make sure that machine is running the newest sidecar build)/;

  test('a capability the operator turned off names the setting, and never an update', async () => {
    const text = await refusalFor([{ ...mac, capabilities: ['terminal'], version: '0.10.0', latest_version: '0.10.0' }]);
    expect(text).toMatch(SETTING);
    // A sidecar that is not behind rules age out, so the message must not hedge.
    expect(text).not.toMatch(UPDATE);
    expect(text).not.toContain('too old');
  });

  test('a missing method names a sidecar update, and never the config', async () => {
    const text = await refusalFor([{ ...withBrowser, version: '0.9.6', latest_version: '0.10.0' }], missingMethod);
    expect(text).toMatch(UPDATE);
    expect(text).toContain('older than this brain');
    // The whole bug: this used to tell the user to go and enable a capability.
    expect(text).not.toMatch(SETTING);
    expect(text).not.toContain('enable the capability');
    // And it says the capability is fine rather than leaving that to be guessed.
    expect(text).toContain('does advertise the "browser" capability');
  });

  test('a missing method names both versions, so the user knows what to update to', async () => {
    const text = await refusalFor([{ ...withBrowser, version: '0.9.6', latest_version: '0.10.0' }], missingMethod);
    expect(text).toContain('0.9.6');
    expect(text).toContain('0.10.0');
  });

  test('a sidecar already at the newest version is NOT told to update to it', async () => {
    // #605 inverted, and the normal state of main: a method lands in the brain
    // and sidecar/VERSION is bumped later, so a user on the newest released
    // sidecar has no method and no update to install. "Update the sidecar" is
    // then as unactionable as "check your config".
    const text = await refusalFor([{ ...withBrowser, version: '0.10.0', latest_version: '0.10.0' }], missingMethod);
    expect(text).not.toContain('older than this brain');
    expect(text).toContain('the newest sidecar this brain knows of');
    expect(text).toContain('stale jarvis-sidecar process');
    expect(text).not.toMatch(SETTING);
  });

  test('a sidecar AHEAD of the brain is not called too old', async () => {
    // A newer sidecar against an older brain is supported (compat.ts: "a new
    // sidecar release needs no brain change to be considered ok"), so an
    // ordered comparison is required -- equality would call this one too old.
    const ahead: SidecarInfo = { ...mac, capabilities: ['terminal'], version: '0.11.0', latest_version: '0.10.0' };
    const text = await refusalFor([ahead]);
    expect(text).toMatch(SETTING);
    expect(text).not.toContain('too old');
    expect(text).not.toMatch(UPDATE);
  });

  test('a local build is compared on its core version, not refused as unparseable', async () => {
    // parseSemver tolerates +local where isUpdateAvailable refuses it, and for
    // a DIAGNOSIS that build is perfectly comparable.
    const text = await refusalFor([{ ...mac, capabilities: ['terminal'], version: '0.10.0+local', latest_version: '0.10.0' }]);
    expect(text).toMatch(SETTING);
    expect(text).not.toContain('too old');
  });

  test('a dev build reads as unknown age, so the remedy still names an update', async () => {
    // manager.ts defaults a missing reported version to the string 'dev', so
    // this is the real production shape of "the brain cannot tell".
    const text = await refusalFor([{ ...withBrowser, version: 'dev', latest_version: '0.10.0' }], missingMethod);
    expect(text).toContain('older than this brain');
    expect(text).toContain('(it reports dev)');
    // Not a false pair: the brain cannot order 'dev' against 0.10.0.
    expect(text).not.toContain('this brain ships');
    expect(text).toMatch(UPDATE);
  });

  test('no version at all reads as absent, never as current', async () => {
    const text = await refusalFor([{ ...withBrowser, version: undefined, latest_version: undefined }], missingMethod);
    expect(text).toMatch(UPDATE);
    expect(text).toContain('older than this brain');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('it reports');
  });

  test('a known version with no latest to compare against stays unknown', async () => {
    const text = await refusalFor([{ ...withBrowser, version: '0.9.6', latest_version: undefined }], missingMethod);
    expect(text).toContain('(it reports 0.9.6)');
    expect(text).not.toContain('this brain ships');
    expect(text).toMatch(UPDATE);
  });

  test('a capability that is on but unavailable names neither of the other remedies', async () => {
    // The third condition, and the reason the other two have to be explicit:
    // a missing host dependency is fixed by neither a setting nor an update.
    const text = await refusalFor([{ ...mac, capabilities: ['browser'],
      unavailable_capabilities: [{ name: 'browser', reason: 'no Chromium on PATH' }] }]);
    expect(text).toContain('no Chromium on PATH');
    expect(text).toContain('not a capability setting');
    // It points at the reason instead of predicting that an update cannot help,
    // which the brain has no way to know.
    expect(text).toContain('install what the reason names');
    expect(text).not.toMatch(SETTING);
    expect(text).not.toMatch(UPDATE);
  });

  test('each of the three conditions names a different remedy', async () => {
    // The property that matters is the REMEDY, not that three strings differ:
    // the old code also produced three distinct strings while two of them gave
    // the same (wrong) instruction.
    const remedies = async (sidecars: SidecarInfo[], dispatch?: () => Promise<unknown>) => {
      const text = await refusalFor(sidecars, dispatch);
      return { setting: SETTING.test(text), update: UPDATE.test(text) };
    };
    expect(await remedies([{ ...mac, capabilities: ['terminal'], version: '0.10.0', latest_version: '0.10.0' }]))
      .toEqual({ setting: true, update: false });
    expect(await remedies([{ ...withBrowser, version: '0.9.6', latest_version: '0.10.0' }], missingMethod))
      .toEqual({ setting: false, update: true });
    expect(await remedies([{ ...mac, capabilities: ['browser'],
      unavailable_capabilities: [{ name: 'browser', reason: 'no Chromium' }] }]))
      .toEqual({ setting: false, update: false });
  });

  test('a sidecar of unknown age names both remedies rather than guessing', async () => {
    // Its neighbour's share of the same conflation: an operator who turned the
    // capability off and a sidecar too old to have heard of the name both leave
    // it out of the advertised list, and the brain cannot tell them apart
    // without a version pair that says which.
    const text = await refusalFor([{ ...mac, capabilities: ['terminal'], version: '0.9.6', latest_version: '0.10.0' }]);
    expect(text).toMatch(SETTING);
    expect(text).toContain('too old to offer it');
    expect(text).toContain('ask the user to update it');
  });

  test('an empty capability list reads as none rather than a dangling colon', async () => {
    const text = await refusalFor([{ ...mac, capabilities: [] }]);
    expect(text).toContain('Available capabilities: none.');
  });

  test('the code and the status are unchanged, so nothing downstream reclassifies', async () => {
    // A PIN, not a regression test: #591's probe switches on the CODE, and
    // rewording the text must never move it.
    setSidecarManagerRef(stubManager([withBrowser], missingMethod));
    await expect(routeToSidecarAction(mac.id, 'browser_element_point', {}, 'browser')).rejects.toMatchObject({
      outcome: { status: 'blocked', code: 'METHOD_NOT_FOUND', effect: 'not_started' },
    });
  });
});

/** Minimal manager stub: only the two methods these paths touch. */
function stubManager(
  sidecars: SidecarInfo[],
  dispatch: (id: string, method: string, params: Record<string, unknown>) => Promise<unknown> = async () => "ok",
): SidecarManager {
  return {
    listSidecars: () => sidecars,
    dispatchRPC: (id: string, method: string, params: Record<string, unknown>) => dispatch(id, method, params),
  } as unknown as SidecarManager;
}

afterEach(() => {
  setNoLocalTools(false);
  // No unset API; a null ref is how the module behaves before the daemon wires it.
  setSidecarManagerRef(null as unknown as SidecarManager);
});

describe("collectExecutionTargets", () => {
  test("maps a sidecar's OS and arch, keeping offline machines", () => {
    setSidecarManagerRef(stubManager([mac, { ...mac, id: "sc-pc", name: "Desk PC", os: "windows", platform: "amd64", connected: false }]));
    const targets = collectExecutionTargets();
    const found = targets.find((t) => t.id === "sc-mac");
    expect(found?.os).toBe("darwin");
    // SidecarInfo.platform is GOARCH; it must land on `arch`, not `os`.
    expect(found?.arch).toBe("arm64");
    expect(found?.capabilities).toEqual(["terminal", "desktop"]);
    // The laptop that is asleep now is still the machine a scheduled flow means.
    expect(targets.find((t) => t.id === "sc-pc")?.connected).toBe(false);
  });

  test("appends the brain host", () => {
    setSidecarManagerRef(stubManager([mac]));
    const host = collectExecutionTargets().find((t) => t.isHost);
    expect(host?.os).toBe(process.platform);
  });

  test("omits the host under --no-local-tools, where it refuses every call", () => {
    // Otherwise a hosted brain's own OS would excuse commands that can only
    // ever run on the user's sidecar.
    setSidecarManagerRef(stubManager([mac]));
    setNoLocalTools(true);
    const targets = collectExecutionTargets();
    expect(targets.some((t) => t.isHost)).toBe(false);
    expect(targets).toHaveLength(1);
  });

  test("still reports the host when the registry is unavailable", () => {
    const targets = collectExecutionTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.isHost).toBe(true);
  });
});

describe("routeToSidecar error messages", () => {
  test("names the machine's OS when a call fails", async () => {
    // The commonest remote failure is a command written for the wrong
    // platform; "command not found" alone says nothing about why.
    setSidecarManagerRef(
      stubManager([mac], async () => {
        throw new Error("exec: notepad.exe: executable file not found");
      }),
    );
    const out = await routeToSidecar("sc-mac", "launch_app", { executable: "notepad.exe" }, "desktop");
    expect(out).toContain("Lapo's MacBook, macOS");
    expect(out).toContain("executable file not found");
  });

  test("names the OS on an offline machine too", async () => {
    setSidecarManagerRef(stubManager([{ ...mac, connected: false }]));
    const out = await routeToSidecar("sc-mac", "run_command", {}, "terminal");
    expect(out).toContain("Lapo's MacBook, macOS");
    expect(out).toContain("offline");
  });

  test("falls back to the bare name when the OS was never reported", async () => {
    setSidecarManagerRef(stubManager([{ ...mac, os: undefined, connected: false }]));
    const out = await routeToSidecar("sc-mac", "run_command", {}, "terminal");
    expect(out).toContain('"Lapo\'s MacBook" is offline');
  });

  test("passes a successful result through untouched", async () => {
    setSidecarManagerRef(stubManager([mac], async () => "total 8\\ndrwx"));
    expect(await routeToSidecar("sc-mac", "run_command", {}, "terminal")).toBe("total 8\\ndrwx");
  });
});

/**
 * A timed-out ("detached") RPC must never be reported as background success
 * for an interactive tool: detached results are only console-logged by
 * manager.ts's onDetachedComplete and never reach the model, so the old
 * "running in the background" was a plain false success.
 */
describe("routeToSidecar detached handling", () => {
  const pc: SidecarInfo = {
    ...mac,
    id: "sc-pc",
    name: "Desk PC",
    os: "windows",
    platform: "amd64",
    capabilities: ["terminal", "desktop", "browser"],
  };
  const detached = () => stubManager([pc], async () => "detached");

  test("reports an honest timeout for a desktop tool instead of background success", async () => {
    setSidecarManagerRef(detached());
    const out = await routeToSidecar("sc-pc", "launch_app", { executable: "notepad.exe" }, "desktop");
    expect(out).toContain("Error");
    expect(out).toContain("do NOT assume it succeeded");
    expect(out).not.toContain("running in the background");
  });

  test("names the machine and its OS in the timeout, as every other error does", async () => {
    setSidecarManagerRef(detached());
    const out = await routeToSidecar("sc-pc", "launch_app", {}, "desktop");
    expect(out).toContain("Desk PC, Windows");
  });

  test("reports an honest timeout for a browser tool", async () => {
    setSidecarManagerRef(detached());
    const out = await routeToSidecar("sc-pc", "browser_navigate", { url: "https://x.test" }, "browser");
    expect(out).toContain("Error");
    expect(out).not.toContain("running in the background");
  });

  test("keeps fire-and-forget for run_command, with an explicit no-output caveat", async () => {
    // The one method whose result genuinely does not have to come back, so
    // it keeps the old behaviour - but says out loud that no output follows.
    setSidecarManagerRef(detached());
    const out = await routeToSidecar("sc-pc", "run_command", { command: "sleep 60" }, "terminal");
    expect(out).toContain("still running in the background");
    expect(out).toContain("will NOT be reported back");
    expect(out).not.toContain("Error");
  });

  test("passes a real object result through as JSON", async () => {
    setSidecarManagerRef(stubManager([pc], async () => ({ success: true, pid: 42 })));
    const out = await routeToSidecar("sc-pc", "launch_app", {}, "desktop");
    expect(JSON.parse(out)).toEqual({ success: true, pid: 42 });
  });
});

/**
 * Every desktop_* and browser_* tool is backed by two implementations - the
 * Go sidecar and the daemon's local controllers - and which one answers used
 * to be decided in silence.
 */
describe("resolveToolTarget", () => {
  const pc: SidecarInfo = {
    ...mac,
    id: "sc-pc",
    name: "Desk PC",
    os: "windows",
    platform: "amd64",
    capabilities: ["terminal", "desktop", "browser"],
  };

  test("passes an explicit target through verbatim", () => {
    setSidecarManagerRef(stubManager([pc]));
    expect(resolveToolTarget("  Desk PC  ", "desktop", "desktop_click")).toBe("  Desk PC  ");
  });

  test("treats a blank target as no target and auto-selects", () => {
    setSidecarManagerRef(stubManager([pc]));
    expect(resolveToolTarget("   ", "desktop", "desktop_click")).toBe("sc-pc");
    expect(resolveToolTarget(undefined, "desktop", "desktop_click")).toBe("sc-pc");
  });

  test("resolves against the capability the RPC needs, not a default", () => {
    // pc advertises desktop/browser/terminal but not screenshot. Resolving a
    // screenshot call against 'desktop' would pick it and then hard-fail in
    // routeToSidecar with a "do NOT retry" error, so it must fall through to
    // the local stack instead.
    setSidecarManagerRef(stubManager([pc]));
    expect(resolveToolTarget(undefined, "screenshot", "desktop_screenshot")).toBeNull();
  });

  test("names the stack that served the call", () => {
    setSidecarManagerRef(stubManager([pc]));
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      resolveToolTarget(undefined, "browser", "browser_click");
      resolveToolTarget(undefined, "screenshot", "desktop_screenshot");
    } finally {
      console.log = original;
    }
    expect(lines[0]).toContain("browser_click -> sidecar stack");
    expect(lines[0]).toContain("auto");
    expect(lines[1]).toContain("desktop_screenshot -> local stack");
  });
});
