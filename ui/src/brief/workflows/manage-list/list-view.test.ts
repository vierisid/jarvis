import { expect, test } from "bun:test";
import { buildListView, matchesQuery } from "./list-view";
import type { ManagementSlot } from "./controller";

const slot = (
  name: string,
  over: Partial<ManagementSlot["item"]> = {},
  removed = false,
  extra: Partial<ManagementSlot> = {},
): ManagementSlot =>
  ({
    item: {
      flowId: name,
      name,
      activation: "ENABLED",
      readiness: { state: "ready", reason: null },
      ...over,
    },
    removed,
    confirming: false,
    phase: "idle",
    ...extra,
  }) as ManagementSlot;

test("query matches every word in any order, case-insensitively", () => {
  expect(matchesQuery("Morning inbox brief", "BRIEF morning")).toBe(true);
  expect(matchesQuery("Morning inbox brief", "evening")).toBe(false);
  expect(matchesQuery("anything", "   ")).toBe(true);
});
test("state filters and the limit count only live rows; removed rows pass through", () => {
  const rows = [
    slot("a"),
    slot("b", { activation: "DISABLED" }),
    slot("c", { readiness: { state: "blocked", reason: null } }),
    slot("d", {}, true),
    slot("e"),
  ];
  expect(
    buildListView(rows, "", "off", 10).rows.map((r) => r.item.name),
  ).toEqual(["b", "d"]);
  expect(buildListView(rows, "", "setup", 10).matching).toBe(1);
  const paged = buildListView(rows, "", "on", 2);
  expect(paged.matching).toBe(3);
  expect(paged.total).toBe(4);
  expect(paged.rows.map((r) => r.item.name)).toEqual(["a", "c", "d"]);
});
test("busy and kept rows stay drawn whatever the search, filter or page", () => {
  const rows = [
    slot("a"),
    slot("b"),
    slot("confirming", {}, false, { confirming: true }),
    slot("uncertain", {}, false, { phase: "uncertain" }),
    slot("paused", { activation: "DISABLED" }),
    slot("f"),
  ];
  const v = buildListView(rows, "", "on", 1, new Set(["paused"]));
  expect(v.rows.map((r) => r.item.name)).toEqual([
    "a",
    "confirming",
    "uncertain",
    "paused",
  ]);
  expect(v.matching).toBe(5);
  expect(
    buildListView(rows, "zzz", "all", 50).rows.map((r) => r.item.name),
  ).toEqual(["confirming", "uncertain"]);
});
