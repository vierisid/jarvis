import { expect, test } from "bun:test";
import { buildListView, matchesQuery } from "./list-view";
import type { ManagementSlot } from "./controller";

const slot = (
  name: string,
  over: Partial<ManagementSlot["item"]> = {},
  removed = false,
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
  expect(buildListView(rows, "", "off", 10).rows.map((r) => r.item.name)).toEqual(
    ["b", "d"],
  );
  expect(buildListView(rows, "", "setup", 10).matching).toBe(1);
  const paged = buildListView(rows, "", "on", 2);
  expect(paged.matching).toBe(3);
  expect(paged.total).toBe(4);
  expect(paged.rows.map((r) => r.item.name)).toEqual(["a", "c", "d"]);
});
