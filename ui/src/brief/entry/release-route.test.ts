import { expect, test } from "bun:test";
import { BRIEF_ROOM_IDS } from "../contracts";
import { BRIEF_ROOMS } from "../rooms/registry";
import { ROOM_KEYS, type RoomKey } from "../../v2/router";
import { FOREGROUND_ALIASES, LEGACY_ROOMS, resolveReleaseEntry, rollbackHref } from "./release-route";
import { briefHash, legacyHref } from "./route";

test("cohort requires exact opt-in; released aliases still respect explicit opt-out", () => {
  for (const [hash, room] of Object.entries(FOREGROUND_ALIASES)) {
    expect(resolveReleaseEntry(`http://test/${hash}`, "cohort").kind).toBe("legacy");
    expect(resolveReleaseEntry(`http://test/?brief=1${hash}`, "cohort")).toEqual({ kind: "brief", route: { room, selection: {} } });
    expect(resolveReleaseEntry(`http://test/${hash}`, "released").kind).toBe("brief");
    for (const flag of ["0", "false", "true", "preview", ""]) {
      expect(resolveReleaseEntry(`http://test/?brief=${flag}${hash}`, "released").kind).toBe("legacy");
    }
    expect(resolveReleaseEntry(`http://test/?brief=1${hash}`, "off").kind).toBe("legacy");
  }
  expect(resolveReleaseEntry("http://test/", "released")).toEqual({ kind: "brief", route: { room: "today", selection: {} } });
});
test("every direct room retains selected source IDs when approved and restores a usable parent when disabled", () => {
  for (const room of BRIEF_ROOM_IDS) {
    const route = { room, selection: { flowId: "a /?&λ", versionId: "v2", runId: "001", factId: "fact" } };
    const href = `http://test/base?brief=1&access=example&sidecar=desktop${briefHash(route)}`;
    expect(resolveReleaseEntry(href, "cohort")).toEqual({ kind: "brief", route });
    expect(resolveReleaseEntry(href, "off").kind).toBe("legacy");
    const rollback = new URL(rollbackHref(href)!);
    expect(rollback.pathname).toBe("/base"); expect(rollback.searchParams.get("access")).toBe("example");
    expect(rollback.searchParams.get("sidecar")).toBe("desktop");
    expect(rollback.searchParams.get("briefReturn")).toBe(briefHash(route));
    expect(rollback.hash).toBe(LEGACY_ROOMS[room] ? `#/_room_${LEGACY_ROOMS[room]}` : "#/");
    expect(LEGACY_ROOMS[room]).toBe((BRIEF_ROOMS[room] as { legacyRoom?: RoomKey }).legacyRoom ?? null);
    expect(resolveReleaseEntry(rollback.toString(), "released").kind).toBe("legacy");
    expect(rollbackHref(rollback.toString())).toBeNull();
  }
});
test("native panel, advanced, result and onboarding routes keep the legacy owner", () => {
  const paths = [...ROOM_KEYS].map(key => `#/_panel_${key}`).concat([
    "#/_room_tools", "#/_room_agents", "#/_room_workspaces", "#/_room_calendar", "#/_room_tasks", "#/_room_content",
    "#/_room_logs", "#/_room_agent_strip", "#/_task_existing", "#/_answer_existing", "#/_palette", "#/_kit", "#/_billing", "#/_states", "#/_primitives",
  ]);
  for (const hash of paths) {
    expect(resolveReleaseEntry(`http://test/?brief=1${hash}`, "released").kind).toBe("legacy");
    expect(rollbackHref(`http://test/?brief=1${hash}`)).toBeNull();
  }
  for (const flag of ["1", "preview", "0"]) {
    const href = `http://test/?brief=${flag}&onboarding=reset&scope=tutorial#/brief/today`;
    expect(resolveReleaseEntry(href, "released", true).kind).toBe("legacy");
    expect(rollbackHref(href)).toBeNull();
  }
});
test("developer previews are explicit and cannot alias foreground routes", () => {
  const href = "http://test/?brief=preview&specimen=memory#/_brief_preview";
  expect(resolveReleaseEntry(href, "released").kind).toBe("legacy");
  expect(resolveReleaseEntry(href, "off", true).kind).toBe("preview");
  expect(resolveReleaseEntry("http://test/?brief=1#/brief/memory", "off", true).kind).toBe("brief");
  expect(resolveReleaseEntry("http://test/?brief=1#/_room_memory", "off", true).kind).toBe("legacy");
  expect(resolveReleaseEntry("http://test/?brief=0#/brief/memory", "released", true).kind).toBe("legacy");
});
test("pre-cutover F25 maintenance bookmarks and settings tab/device links preserve their owner", () => {
  for (const [hash] of Object.entries(FOREGROUND_ALIASES)) {
    for (const optin of ["", "&brief=1"]) {
      const href = `http://test/?briefMaintenance=1${optin}${hash}`;
      expect(resolveReleaseEntry(href, "released", true).kind).toBe("legacy");
      expect(rollbackHref(href)).toBeNull();
    }
  }
  for (const query of ["settingsTab=sidecar&sidecarId=device-1", "settingsTab=llm", "sidecarId=device-1"]) {
    expect(resolveReleaseEntry(`http://test/?${query}#/_room_settings`, "released").kind).toBe("legacy");
  }
  expect(resolveReleaseEntry("http://test/?brief=1&brief=0#/", "released", true).kind).toBe("legacy");
});
test("malformed URLs never become foreground aliases or rollback targets", () => {
  for (const hash of ["#/brief/__proto__", "#/brief/today/extra", "#/brief/today%3F", "#/_room_memory?factId=x", "#__proto__"]) {
    expect(resolveReleaseEntry(`http://test/?brief=1${hash}`, "released").kind).toBe("legacy");
    expect(rollbackHref(`http://test/?brief=1${hash}`)).toBeNull();
  }
  expect(resolveReleaseEntry(legacyHref("http://test/?brief=1#/brief/today"), "released").kind).toBe("legacy");
});
test("owner decision (#1106): an approved release explains a well-formed unknown room; malformed URLs keep the dashboard", () => {
  for (const hash of ["#/brief/inbox", "#/brief/old-room", "#/brief/inbox?flowId=f1", "#/brief/room2"]) {
    expect(resolveReleaseEntry(`http://test/?brief=1${hash}`, "cohort")).toEqual({ kind: "moved" });
    expect(resolveReleaseEntry(`http://test/?brief=1${hash}`, "released")).toEqual({ kind: "moved" });
    expect(resolveReleaseEntry(`http://test/${hash}`, "released")).toEqual({ kind: "moved" });
    // The same opt-in, opt-out and switch rules as a known room.
    expect(resolveReleaseEntry(`http://test/${hash}`, "cohort").kind).toBe("legacy");
    expect(resolveReleaseEntry(`http://test/?brief=1${hash}`, "off").kind).toBe("legacy");
    expect(resolveReleaseEntry(`http://test/?brief=0${hash}`, "released").kind).toBe("legacy");
    expect(resolveReleaseEntry(`http://test/?brief=1&brief=1${hash}`, "released").kind).toBe("legacy");
    expect(resolveReleaseEntry(`http://test/?briefMaintenance=1&brief=1${hash}`, "released").kind).toBe("legacy");
    expect(rollbackHref(`http://test/?brief=1${hash}`)).toBeNull();
  }
  for (const hash of ["#/brief/", "#/brief/__proto__", "#/brief/today/extra", "#/brief/today%3F", "#/brief/Inbox",
    "#/brief/-x", "#/brief/a b", "#/brief/" + "a".repeat(65), "#/brief//today", "#/brief?x"]) {
    expect(resolveReleaseEntry(`http://test/?brief=1${hash}`, "released").kind).toBe("legacy");
    expect(resolveReleaseEntry(`http://test/?brief=1${hash}`, "cohort").kind).toBe("legacy");
  }
});
