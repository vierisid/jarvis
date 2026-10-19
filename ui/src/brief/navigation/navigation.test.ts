import { expect, test } from "bun:test";
import { BriefCapabilities } from "../../../../src/brief/capabilities";
import { registerNavigationCompatibility, type NavigationReadiness } from "../../../../src/brief/registrations/navigation-compatibility";
import { DESTINATIONS, destination, legacyLink, roomIntent, targetHref, type DestinationId, type NavigationTarget } from "./destinations";
import { NavigationCompatibility, destinationPort } from "./controller";
import { ROOM_KEYS } from "../../v2/router";
import { settingsTabFromHref } from "../../v2/shell/settings-tab-request";
import { attentionKey, attentionView, notificationTarget, openNotification, type AttentionIdentity, type AttentionItem, type AttentionSnapshot } from "./notifications";

const ready: NavigationReadiness = { destinations: true, guardedNavigation: true, roomIntents: true, notificationsOutsideChat: true };
const caps = (enabled = true) => new BriefCapabilities(registerNavigationCompatibility(() => ready), enabled ? ["navigationCompatibility"] : []).snapshot();
function fixture(guard: (signal: AbortSignal) => Promise<boolean> = async () => true) {
  const opened: NavigationTarget[] = [], messages: string[] = [];
  const nav = new NavigationCompatibility({ roomAvailable: () => false, canLeave: guard, commit: t => { opened.push(t); }, explain: m => messages.push(m) });
  nav.setAccess(caps());
  return { nav, opened, messages };
}
const item = (source: AttentionItem["source"], id = "id"): AttentionItem => ({
  id, source, kind: source === "failure" || source === "update" ? "system" : source,
  title: "Fixture", text: "", timestamp: 1, tone: "warn", unread: true,
});

test("registration is optional and every integration check is fail-closed; explicit activation required", () => {
  expect(registerNavigationCompatibility()).toEqual([]);
  expect(caps(false).capabilities.navigationCompatibility.enabled).toBe(false);
  expect(caps().capabilities.navigationCompatibility.enabled).toBe(true);
  for (const key of Object.keys(ready)) {
    const c = new BriefCapabilities(registerNavigationCompatibility(() => ({ ...ready, [key]: false })), ["navigationCompatibility"]);
    expect(c.snapshot().capabilities.navigationCompatibility.enabled).toBe(false);
  }
  const c = new BriefCapabilities(registerNavigationCompatibility(() => { throw Error("secret"); }), ["navigationCompatibility"]);
  expect(JSON.stringify(c.snapshot())).not.toContain("secret");
  expect(c.snapshot().capabilities.navigationCompatibility.state).toBe("unavailable");
});

test("every retained destination has an owner and an exact released room/settings fallback", () => {
  for (const id of Object.keys(DESTINATIONS) as DestinationId[]) {
    const value = DESTINATIONS[id];
    expect(value.owner.length).toBeGreaterThan(0);
    const resolved = destination(id, () => false);
    expect(resolved.target).toEqual(value.legacy);
    expect(legacyLink(value.legacy.hash)?.target).toEqual({ kind: "legacy", hash: value.legacy.hash });
    const url = targetHref("https://fixture.invalid/dashboard?brief=1&keep=value#/brief/settings", value.legacy);
    // D33: leaving Brief is an explicit opt-out, so a later default-on release cannot reopen it.
    expect(new URL(url).searchParams.get("brief")).toBe("0");
    expect(new URL(url).searchParams.get("keep")).toBe("value");
    expect(settingsTabFromHref(url)).toBe("settingsTab" in value.legacy ? value.legacy.settingsTab : null);
  }
});

test("all room, native panel, standalone and opaque object links retain exact legacy owners", () => {
  for (const key of ROOM_KEYS) for (const prefix of ["room", "panel"]) {
    const hash = `#/_${prefix}_${key}`;
    expect(legacyLink(hash)).toEqual({ target: { kind: "legacy", hash }, message: null });
  }
  for (const hash of ["#/", "#/_primitives", "#/_kit", "#/_states", "#/_billing", "#/_palette", "#/_task_a%2Fb", "#/_answer_opaque-id"])
    expect(legacyLink(hash)?.target).toEqual({ kind: "legacy", hash });
  for (const hash of ["javascript:alert(1)", "#/_task_", "#/_room_missing", "#/_panel_settings?tab=voice"])
    expect(legacyLink(hash)).toBeNull();
});

test("room-only commands use a ready Brief room; action-bearing commands retain canonical handlers", () => {
  for (const key of ROOM_KEYS) {
    expect(roomIntent(key, () => true, true).target).toEqual({ kind: "legacy", hash: `#/_room_${key}` });
  }
  expect(roomIntent("workflows", () => true).target).toEqual({ kind: "brief", route: { room: "workflows", selection: {} } });
  expect(roomIntent("workflows", () => false).target.kind).toBe("legacy");
  for (const key of ["arrange", "cluster", "archive", "saved", "dismissed", "constructor", "__proto__", "unknown"]) {
    const resolved = roomIntent(key, () => true);
    expect(resolved.target).toEqual({ kind: "legacy", hash: "#/_room_settings", settingsTab: "general" });
    expect(resolved.message).toContain("Advanced settings and support");
  }
});

test("deep-linked Settings tabs accept canonical names only and do not affect unrelated rooms", () => {
  for (const tab of ["general", "profile", "llm", "channels", "voice", "integrations", "billing", "sidecar"])
    for (const mode of ["room", "panel"]) expect(settingsTabFromHref(`https://fixture.invalid/?settingsTab=${tab}#/_${mode}_settings`)).toBe(tab as any);
  for (const href of ["/?settingsTab=models#/_room_settings", "/?settingsTab=sidecar#/_room_authority", "/?settingsTab=voice#/brief/settings"])
    expect(settingsTabFromHref(href)).toBeNull();
});

test("closed/old/malformed gates never ask a guard or navigate", async () => {
  let checks = 0; const f = fixture(async () => { checks++; return true; });
  for (const snapshot of [undefined, {}, { contractVersion: 2 }, caps(false)]) {
    f.nav.setAccess(snapshot); expect((await f.nav.navigate("emergency-controls")).state).toBe("unavailable");
  }
  expect(checks).toBe(0); expect(f.opened).toEqual([]);
});

test("guard cancel, rejected guard, caller abort, access loss and retirement do not navigate", async () => {
  expect((await fixture(async () => false).nav.navigate("devices")).state).toBe("cancelled");
  const failed = fixture(async () => { throw Error("private guard state"); });
  expect((await failed.nav.navigate("devices")).state).toBe("unavailable");
  expect(failed.messages.join()).not.toContain("private");
  for (const action of ["abort", "disable", "retire"]) {
    let release!: (v: boolean) => void;
    const f = fixture(() => new Promise(r => { release = r; }));
    const signal = new AbortController();
    const promise = f.nav.navigate("emergency-controls", signal.signal);
    if (action === "abort") signal.abort(); else if (action === "disable") f.nav.setAccess(caps(false)); else f.nav.retire();
    release(true); expect((await promise).state).toBe("cancelled"); expect(f.opened).toEqual([]);
  }
});

test("latest navigation wins and destinations are resolved after the guard", async () => {
  const pending: ((v: boolean) => void)[] = [];
  const f = fixture(() => new Promise(r => pending.push(r)));
  const a = f.nav.navigate("devices"), b = f.nav.navigate("tasks");
  pending[1]!(true); await b; pending[0]!(true);
  expect((await a).state).toBe("cancelled"); expect(f.opened).toEqual([DESTINATIONS.tasks.legacy]);
  let available = true, release!: (v: boolean) => void;
  const nav = new NavigationCompatibility({ roomAvailable: () => available, canLeave: () => new Promise(r => { release = r; }), commit: t => f.opened.push(t), explain() {} });
  nav.setAccess(caps()); const result = nav.navigate("authority"); available = false; release(true); await result;
  expect(f.opened.at(-1)).toEqual(DESTINATIONS.authority.legacy);
});

test("D-27/D-28 callbacks respect abort and D-30 callbacks reject cancelled handoffs", async () => {
  const f = fixture(async () => false), port = destinationPort(f.nav);
  expect((await port.navigate("devices", AbortSignal.abort())).state).toBe("unavailable");
  await expect(port.callback("advanced-settings")()).rejects.toThrow("Navigation did not open");
  expect(f.opened).toEqual([]);
});

test("approval, failure and update notifications preserve source IDs and open no effect", () => {
  expect(notificationTarget(item("approval", "a/1"), () => true).target).toEqual({ kind: "brief", route: { room: "needs-you", selection: { approvalId: "a/1" } } });
  expect(notificationTarget(item("approval"), () => false).target).toEqual(DESTINATIONS["advanced-authority"].legacy);
  expect(notificationTarget(item("update"), () => true).target).toEqual(DESTINATIONS.devices.legacy);
  expect(notificationTarget(item("clarifier"), () => true).target).toEqual({ kind: "conversation", itemId: "id" });
  const failure = { ...item("failure"), refs: { flowId: "flow", versionId: "version", runId: "run", taskId: "task" } };
  expect(notificationTarget(failure, () => true).target).toEqual({ kind: "brief", route: { room: "workflow-runs", selection: { flowId: "flow", versionId: "version", runId: "run" } } });
  expect(() => notificationTarget(failure, () => false)).toThrow("Workflow run history is unavailable");
  expect(notificationTarget({ ...failure, refs: { taskId: "task" } }, () => false).target).toEqual({ kind: "legacy", hash: "#/_task_task" });
  expect(notificationTarget({ ...failure, refs: { taskId: "a/b" } }, () => false).target).toEqual(DESTINATIONS.tasks.legacy);
});

test("unknown freshness is not an empty count; read critical rows remain discoverable and duplicate IDs are source-scoped", () => {
  for (const status of ["stale", "unavailable", "loading", "unsupported"] as const) expect(attentionView({ status }).count).toBeNull();
  const a = item("approval"), b = item("update");
  const v = attentionView({ status: "ready", items: [a, { ...a, unread: false }, b] });
  expect(v.count).toBe(2); expect(v.items[0]?.unread).toBe(false);
  expect(attentionView({ status: "ready", items: [] }).count).toBe(0);
});

test("a stale/resolved notification after a dirty-draft dialog cannot route or be marked read", async () => {
  let release!: (v: boolean) => void;
  const f = fixture(() => new Promise(r => { release = r; }));
  let snapshot: AttentionSnapshot = { status: "ready", items: [item("approval")] };
  const read: AttentionIdentity[] = [];
  const host = { snapshot: () => snapshot, roomAvailable: () => true, markRead: (identity: AttentionIdentity) => read.push(identity) };
  const promise = openNotification(attentionKey(item("approval")), host, f.nav);
  snapshot = { status: "stale" }; release(true);
  expect((await promise).state).toBe("unavailable"); expect(f.opened).toEqual([]); expect(read).toEqual([]);
});

test("mark read only follows a successful navigation and ambiguous source IDs cannot select the wrong row", async () => {
  const read: AttentionIdentity[] = [], f = fixture();
  const host = { snapshot: (): AttentionSnapshot => ({ status: "ready", items: [item("approval"), item("update")] }), roomAvailable: () => true, markRead: (identity: AttentionIdentity) => read.push(identity) };
  expect((await openNotification(attentionKey(item("update")), host, f.nav)).state).toBe("opened");
  expect(f.opened[0]).toEqual(DESTINATIONS.devices.legacy); expect(read).toEqual([{ source: "update", id: "id" }]);
});

test("workflow failures stay unread until their exact run history is available", async () => {
  const failure = { ...item("failure", "run-1"), refs: { flowId: "flow", versionId: "version", runId: "run", taskId: "different-task" } };
  const f = fixture(), read: AttentionIdentity[] = [];
  let ready = false;
  let refs: AttentionItem["refs"] = failure.refs;
  const host = {
    snapshot: (): AttentionSnapshot => ({ status: "ready", items: [{ ...failure, refs }] }),
    roomAvailable: () => ready,
    markRead: (identity: AttentionIdentity) => read.push(identity),
  };
  expect((await openNotification(attentionKey(failure), host, f.nav)).state).toBe("unavailable");
  expect(f.opened).toEqual([]); expect(read).toEqual([]);
  // A partial workflow identity must not fall through to an unrelated task either.
  ready = true;
  for (const partial of [{ flowId: "flow" }, { versionId: "version" }, { runId: "run" }]) {
    refs = { ...partial, taskId: "different-task" };
    expect((await openNotification(attentionKey(failure), host, f.nav)).state).toBe("unavailable");
  }
  expect(f.opened).toEqual([]); expect(read).toEqual([]);
  refs = failure.refs;
  expect((await openNotification(attentionKey(failure), host, f.nav)).state).toBe("opened");
  expect(f.opened).toEqual([{ kind: "brief", route: { room: "workflow-runs", selection: { flowId: "flow", versionId: "version", runId: "run" } } }]);
  expect(read).toEqual([{ source: "failure", id: "run-1" }]);
});

test("workflow history readiness is rechecked after the shared draft guard", async () => {
  let release!: (allow: boolean) => void;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const failure = { ...item("failure"), refs: { flowId: "flow", versionId: "version", runId: "run" } };
  let ready = true;
  const read: AttentionIdentity[] = [];
  const pending = openNotification(attentionKey(failure), {
    snapshot: () => ({ status: "ready", items: [failure] }),
    roomAvailable: () => ready,
    markRead: identity => read.push(identity),
  }, f.nav);
  ready = false; release(true);
  expect((await pending).state).toBe("unavailable");
  expect(f.opened).toEqual([]); expect(read).toEqual([]);
});
