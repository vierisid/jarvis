import { expect, test } from "bun:test";
import { memoryRows } from "./fixtures";
import { validPage } from "./model";

const page = () => ({
  items: [memoryRows()[0]!],
  count: { total: 1, matched: 1, returned: 1 },
  nextCursor: null as string | null,
  usedIn: { state: "ready" },
});

test("accepts a well-formed page", () => {
  expect(validPage(page(), { limit: 50 })).toBe(true);
});

for (const broken of [
  "permission",
  "count",
  "duplicate",
  "limit",
  "scope",
  "basis",
  "uses",
  "superseded",
  "cursor",
] as const)
  test(`rejects a page with a ${broken} violation as a whole`, () => {
    const body: any = page();
    const row = body.items[0];
    if (broken === "permission") row.permissions.canRead = false;
    if (broken === "count") body.count.returned = 2;
    if (broken === "duplicate") {
      body.items.push(row);
      body.count = { total: 2, matched: 2, returned: 2 };
    }
    if (broken === "limit") {
      body.items = memoryRows().slice(0, 3);
      body.count = { total: 3, matched: 3, returned: 3 };
    }
    if (broken === "scope") delete row.scope;
    if (broken === "basis") row.basis = "verified outcome";
    if (broken === "uses") row.uses[0].factId = "another-fact";
    if (broken === "superseded") row.status = "superseded";
    if (broken === "cursor") {
      body.items = [];
      body.count = { total: 1, matched: 0, returned: 0 };
      body.nextCursor = "next";
    }
    expect(validPage(body, { limit: broken === "limit" ? 2 : 50 })).toBe(false);
  });
