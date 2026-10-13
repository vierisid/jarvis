/** Optional integration evidence against pinned sibling modules. No runtime imports from that stack. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { BriefCapabilities } from "../src/brief/capabilities";
import { registerNavigationCompatibility } from "../src/brief/navigation-compatibility";
import { NavigationCompatibility, destinationPort } from "../ui/src/brief/navigation/controller";
import { deviceNavigation } from "../ui/src/brief/navigation/devices";
import { roomIntent, type NavigationTarget } from "../ui/src/brief/navigation/destinations";
import { settingsTabFromHref } from "../ui/src/v2/shell/settings-tab-request";

const root = process.env.F25_D29_ROOT;
if (!root) throw Error("Set F25_D29_ROOT to the pinned, clean D-29 checkout");
const pin = "2168db73bb2430a96a862ca80da19aa016e315b3";
const mainPin = "f74044de53615dfa91430d2b543f05deffc0c49c";
const d30Pin = "db9f59100091a18e45a9a7a633bd5e74726898d3";
const d30Root = process.env.F25_D30_ROOT;
if (!d30Root) throw Error("Set F25_D30_ROOT to the pinned, clean D-30 checkout");
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { env });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout.toString().trim();
};
assert.equal(git("-C", root, "rev-parse", "HEAD"), pin);
assert.equal(git("-C", root, "status", "--porcelain", "--untracked-files=no"), "");
assert.equal(git("-C", d30Root, "rev-parse", "HEAD"), d30Pin);
assert.equal(git("-C", d30Root, "status", "--porcelain", "--untracked-files=no"), "");
const load = (file: string): Promise<any> => import(pathToFileURL(resolve(root, file)).href);
const caps = new BriefCapabilities(registerNavigationCompatibility(() => ({
  destinations: true, guardedNavigation: true, roomIntents: true, notificationsOutsideChat: true,
})), ["navigationCompatibility"]).snapshot();
const opened: NavigationTarget[] = [];
const { makeProfileFixture } = await load("ui/src/brief/account/profile/fixtures.ts");
const profile = makeProfileFixture();
profile.controller.setAccess(true);
for (let i = 0; i < 100 && profile.controller.snapshot().reading; i++) await Bun.sleep(5);
assert.equal(profile.controller.snapshot().availability, "ready");
const nav = new NavigationCompatibility({ roomAvailable: () => false, canLeave: () => profile.controller.requestLeave(), commit: t => { opened.push(t); }, explain() {} });
nav.setAccess(caps);
try {
  const { createAuthorityPort } = await load("ui/src/brief/authority/adapter.ts");
  const port = createAuthorityPort("fixture", {
    canWrite: false, request() { throw Error("Navigation must not call an API"); },
    destinations: { "advanced-authority": true, "emergency-controls": true },
    navigate: destinationPort(nav).navigate,
  });
  profile.controller.edit("company", "Unsaved fixture");
  const cancelled = port.navigate("emergency-controls", new AbortController().signal);
  await profile.controller.resolvePrompt(false);
  assert.equal((await cancelled).state, "unavailable"); assert.equal(opened.length, 0);
  const confirmed = port.navigate("emergency-controls", new AbortController().signal);
  await profile.controller.resolvePrompt(true);
  assert.equal((await confirmed).state, "opened");
  assert.deepEqual(opened.pop(), { kind: "legacy", hash: "#/_room_authority" });
  assert.equal(profile.writes.length, 0);
  const { createSettingsPort } = await import(pathToFileURL(resolve(d30Root, "ui/src/brief/account/settings/adapter.ts")).href);
  const settings = createSettingsPort("fixture", {
    canWrite: false, request() { throw Error("Navigation must not call an API"); },
    destinations: { "advanced-settings": destinationPort(nav).callback("advanced-settings") },
  });
  assert.equal((await settings.navigate("advanced-settings")).state, "opened");
  assert.deepEqual(opened.pop(), { kind: "legacy", hash: "#/_room_settings", settingsTab: "general" });
  nav.setAccess({});
  assert.equal((await settings.navigate("advanced-settings")).state, "unavailable");
  nav.setAccess(caps);

  const devices = deviceNavigation(nav, () => [{ id: "one", name: "Fixture", enrolled_at: "2026-01-01", last_seen_at: null, status: "active", connected: true, version: "1", update_available: true, latest_version: "2" }]);
  const row = { sourceId: "device:one", kind: "device", serviceId: "sidecar", label: "Fixture", accountId: "one", availability: "ready", authenticated: false, status: "connected", evidence: "live_session", pieceVersion: null, setupActionId: null, permissions: { canInspect: true, canRevoke: true, canConnect: false } };
  const { projectF22 } = await load("ui/src/brief/connections/f22-adapter.ts");
  const projection = projectF22({ contractVersion: 1, scopeId: "fixture", asOf: 100, sources: { devices: "ready", google: "unavailable", channels: "unavailable", pieces: "unavailable", accounts: "unavailable" }, rows: [row], setup: [] }, "fixture", devices.deviceDetails);
  assert.equal(projection.connections[0].device.canUpdate, true);
  assert.equal((await devices.manageDevice(row as any, "revoke", new AbortController().signal)).state, "opened");
  assert.deepEqual(opened.pop(), { kind: "legacy", hash: "#/_room_settings", settingsTab: "sidecar", sidecarId: "one" });
  assert.equal((await devices.addDevice(AbortSignal.abort())).state, "unavailable");

  const dir = mkdtempSync(join(tmpdir(), "f25-main-tabs-"));
  try {
    const file = join(dir, "room-tabs.ts");
    writeFileSync(file, git("show", `${mainPin}:src/daemon/room-tabs.ts`));
    const { ROOM_TABS } = await import(pathToFileURL(file).href);
    for (const [room, tabs] of Object.entries(ROOM_TABS) as [string, string[]][]) {
      for (const tab of tabs) {
        assert.deepEqual(roomIntent(room, () => true, true).target, { kind: "legacy", hash: `#/_room_${room}` });
        if (room === "settings") assert.equal(settingsTabFromHref(`https://fixture.invalid/?settingsTab=${tab}#/_room_settings`), tab);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log(JSON.stringify({ result: "passed", d29: pin, d30: d30Pin, main: mainPin, checks: ["D27 device identity/projection", "D28 retained emergency handoff", "D29 cancel/discard draft guard", "D30 Settings opened/unavailable handoff", "main canonical voice tab names"], writes: profile.writes.length }));
} finally { nav.retire(); profile.controller.retire(); }
