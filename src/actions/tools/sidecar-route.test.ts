import { afterEach, describe, expect, test } from "bun:test";
import type { SidecarManager } from "../../sidecar/manager.ts";
import type { SidecarInfo } from "../../sidecar/types.ts";
import { setNoLocalTools } from "./local-tools-guard.ts";
import { collectExecutionTargets, routeToSidecar, setSidecarManagerRef } from "./sidecar-route.ts";

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
