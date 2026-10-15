import { expect, test } from "bun:test";
import { BRIEF_ROOM_IDS } from "../contracts";
import { BRIEF_ROOMS } from "../rooms/registry";
import { briefHash, legacyHref, resolveBriefEntry } from "./route";

test("the default and non-exact flag values keep the released dashboard", () => {
  for (const query of ["", "brief=0", "brief=true", "brief=", "brief=preview"]) {
    expect(resolveBriefEntry(`http://localhost/?${query}#/brief/today`)).toEqual({ kind: "legacy" });
  }
});

test("all existing sidecar and dashboard destinations retain their route owner", () => {
  for (const flag of ["1", "preview"]) {
    for (const hash of ["#/", "#/_room_workflows", "#/_room_settings", "#/_panel_workflows", "#/_panel_settings", "#/_task_existing-id", "#/_answer_existing-id", "#/_palette", "#/_kit", "#/_billing", "#/_primitives", "#/_states"]) {
      expect(resolveBriefEntry(`http://localhost/?brief=${flag}${hash}`)).toEqual({ kind: "legacy" });
    }
  }
});

test("onboarding reset owns the page even when a Brief URL was bookmarked", () => {
  expect(resolveBriefEntry("http://localhost/?brief=1&onboarding=reset&scope=tutorial#/brief/today")).toEqual({ kind: "legacy" });
  expect(resolveBriefEntry("http://localhost/?brief=preview&onboarding=reset#/_brief_preview")).toEqual({ kind: "legacy" });
});

test("fixture mode requires both its explicit flag and isolated destination", () => {
  expect(resolveBriefEntry("http://localhost/?brief=preview#/_brief_preview")).toEqual({ kind: "preview" });
  for (const url of ["http://localhost/#/_brief_preview", "http://localhost/?brief=1#/_brief_preview", "http://localhost/?brief=preview#/brief/today"]) {
    expect(resolveBriefEntry(url)).toEqual({ kind: "legacy" });
  }
});

test("every registered destination resolves without requiring another room's module", () => {
  expect(Object.keys(BRIEF_ROOMS).sort()).toEqual([...BRIEF_ROOM_IDS].sort());
  for (const id of BRIEF_ROOM_IDS) {
    expect(BRIEF_ROOMS[id].id).toBe(id);
    expect(resolveBriefEntry(`http://localhost/?brief=1#/brief/${id}`)).toEqual({ kind: "brief", route: { room: id, selection: {} } });
  }
});

test("unknown or malformed Brief destinations use the existing safe fallback", () => {
  for (const path of ["missing", "__proto__", "today/extra", "today%3F", ""]) {
    expect(resolveBriefEntry(`http://localhost/?brief=1#/brief/${path}`)).toEqual({ kind: "legacy" });
  }
});

test("source identities roundtrip without inventing a record or retaining unknown query keys", () => {
  const route = { room: "workflow-runs" as const, selection: { flowId: "flow / &?α", versionId: "v2", runId: "001" } };
  const url = `http://localhost/?brief=1${briefHash(route)}&unknown=ignored`;
  expect(resolveBriefEntry(url)).toEqual({ kind: "brief", route });
});

test("rollback removes only the Brief opt-in and preserves connection parameters", () => {
  const next = new URL(legacyHref("https://brain.example/path?brief=1&access=sample&sidecar=desktop#/brief/workflow", "#/_room_workflows"));
  expect(next.searchParams.has("brief")).toBe(false);
  expect(next.searchParams.get("access")).toBe("sample");
  expect(next.searchParams.get("sidecar")).toBe("desktop");
  expect(next.pathname).toBe("/path");
  expect(next.hash).toBe("#/_room_workflows");
});
