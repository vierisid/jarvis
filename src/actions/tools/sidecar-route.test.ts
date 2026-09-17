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

  test('an unverified launch window stays an unverified success, note and pid intact', async () => {
    // launchResultLinux/launchResultDarwin report this as success on purpose:
    // calling it a failure makes the model launch an app that is already open.
    const reply = { success: true, window_visible: null, pid: 4242, note: 'could NOT be checked' };
    setSidecarManagerRef(stubManager([mac], async () => reply));
    expect(JSON.parse(await routeToSidecarAction(mac.id, 'launch_app', {}, 'desktop'))).toEqual(reply);
  });

  test('a reported failure carries the whole reply so the pid and note survive', async () => {
    setSidecarManagerRef(stubManager([mac], async () => ({ success: false, pid: 7, note: 'no window appeared' })));
    await expect(routeToSidecarAction(mac.id, 'launch_app', {}, 'desktop')).rejects.toMatchObject({
      outcome: { status: 'error', code: 'SIDECAR_ACTION_FAILED', effect: 'may_have_occurred',
        message: expect.stringContaining('no window appeared') },
    });
  });

  test('data containing the word Error is not classified as a failed action', async () => {
    setSidecarManagerRef(stubManager([mac], async () => 'Error: the title of a visible window'));
    expect(await routeToSidecarAction(mac.id, 'list_windows', {}, 'desktop')).toBe('Error: the title of a visible window');
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
