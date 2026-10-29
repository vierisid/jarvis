import { expect, test } from "bun:test";
import {
  MANAGED_MONDAY_ACTIONS,
  runManagedMondayAction,
  mondayGraphql,
} from "./managed-monday";
import {
  resolveGovernedPieceAction,
  tracksPieceCompletion,
} from "./piece-effects";
const auth = { secret_text: "TEST_ONLY", jarvis_managed: "monday" };
const columns = [
  { id: "text", type: "text" },
  { id: "notes", type: "long_text" },
  { id: "number", type: "numbers" },
  { id: "check", type: "checkbox" },
  { id: "date", type: "date" },
  {
    id: "status",
    type: "status",
    settings_str: JSON.stringify({ labels: { 0: "Working", 1: "Done" } }),
  },
  { id: "formula", type: "formula" },
];
const board = {
  id: "100",
  name: "Board",
  groups: [{ id: "topics", title: "Tasks" }],
  columns,
};
const item = (extra: any = {}) => ({
  id: "200",
  name: "Item",
  board: { id: "100" },
  column_values: [
    { id: "text", type: "text", text: "Hello", value: '"Hello"' },
  ],
  ...extra,
});
function mock(fn: (q: string, v: any) => any) {
  const calls: Array<{ q: string; v: any }> = [];
  const request = (async (url: any, init: any) => {
    expect(String(url)).toBe("https://api.monday.com/v2");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe("TEST_ONLY");
    expect(new Headers(init.headers).get("API-Version")).toBe("2026-07");
    const { query: q, variables: v } = JSON.parse(init.body);
    calls.push({ q, v });
    const value = fn(q, v);
    return value instanceof Response ? value : Response.json({ data: value });
  }) as typeof fetch;
  return { calls, request };
}
const normal = (q: string, v: any) =>
  q.includes("JarvisBoard")
    ? { boards: [board] }
    : q.includes("JarvisItem")
      ? { items: [item()] }
      : q.includes("JarvisCreateUpdate")
        ? { create_update: { id: "300" } }
        : q.includes("JarvisCreateItem")
          ? { create_item: item({ name: v.name }) }
          : {
              change_multiple_column_values: item({
                name: JSON.parse(v.values).name ?? "Item",
              }),
            };
test("five operations have explicit read/write governance and completion receipts", () => {
  expect(MANAGED_MONDAY_ACTIONS).toHaveLength(5);
  for (const name of MANAGED_MONDAY_ACTIONS) {
    const read = name === "monday_get_item_column_values";
    expect(
      resolveGovernedPieceAction("@activepieces/piece-monday", name)?.category,
    ).toBe(read ? "read_data" : "write_data");
    expect(tracksPieceCompletion("@activepieces/piece-monday", name)).toBe(
      !read,
    );
  }
  expect(
    resolveGovernedPieceAction(
      "@activepieces/piece-monday",
      "monday_create_column",
    )?.category,
  ).toBe("modify_settings");
});
test("read verifies board and ID and exposes column text under column IDs", async () => {
  const m = mock(normal);
  expect(
    await runManagedMondayAction(
      "monday_get_item_column_values",
      { auth, board_id: "100", item_id: "200" },
      m.request,
    ),
  ).toEqual({ id: "200", name: "Item", text: "Hello" });
  expect(m.calls).toHaveLength(1);
  for (const bad of [item({ board: { id: "999" } }), item({ id: "999" })]) {
    const m = mock(() => ({ items: [bad] }));
    await expect(
      runManagedMondayAction(
        "monday_create_update",
        { auth, board_id: "100", item_id: "200", body: "Hi" },
        m.request,
      ),
    ).rejects.toThrow();
    expect(m.calls).toHaveLength(1);
  }
});
test("create validates group and columns, sends variables, never changes the board schema", async () => {
  const m = mock(normal);
  expect(
    await runManagedMondayAction(
      "monday_create_item",
      {
        auth,
        board_id: "100",
        group_id: "topics",
        item_name: 'Quote " here',
        column_values: { text: "Hello" },
      },
      m.request,
    ),
  ).toEqual({ data: { create_item: { id: "200" } } });
  expect(m.calls[1]!.v).toEqual({
    board: "100",
    group: "topics",
    name: 'Quote " here',
    values: '{"text":"Hello"}',
  });
  expect(m.calls[1]!.q).toContain("create_labels_if_missing: false");
  for (const fields of [
    { group_id: "wrong" },
    { column_values: { missing: "x" } },
    { column_values: { formula: 2 } },
    { column_values: { status: "New label" } },
  ]) {
    const m = mock(normal);
    await expect(
      runManagedMondayAction(
        "monday_create_item",
        { auth, board_id: "100", item_name: "Hi", ...fields },
        m.request,
      ),
    ).rejects.toThrow();
    expect(m.calls.every((c) => c.q.startsWith("query"))).toBe(true);
  }
});
test("column conversion preserves false and zero and confirms returned values", async () => {
  const raw = {
    text: "Hello",
    notes: "Details",
    number: 0,
    check: false,
    date: "2026-10-30",
    status: "Done",
  };
  const expected = {
    text: "Hello",
    notes: { text: "Details" },
    number: "0",
    check: { checked: "false" },
    date: { date: "2026-10-30" },
    status: { index: 1 },
  };
  const m = mock((q, v) =>
    q.includes("JarvisChangeColumns")
      ? {
          change_multiple_column_values: item({
            column_values: Object.entries(expected).map(([id, value]) => ({
              id,
              type: columns.find((c) => c.id === id)!.type,
              text: "Displayed",
              value: JSON.stringify(
                id === "check" ? { checked: false } : value,
              ),
            })),
          }),
        }
      : normal(q, v),
  );
  await runManagedMondayAction(
    "monday_update_column_values_of_item",
    { auth, board_id: "100", item_id: "200", column_values: raw },
    m.request,
  );
  expect(JSON.parse(m.calls[2]!.v.values)).toEqual(expected);
  expect(m.calls.filter((c) => c.q.startsWith("mutation"))).toHaveLength(1);
  const noop = mock(normal);
  await expect(
    runManagedMondayAction(
      "monday_update_column_values_of_item",
      {
        auth,
        board_id: "100",
        item_id: "200",
        column_values: { text: "Different" },
      },
      noop.request,
    ),
  ).rejects.toThrow("confirm");
});
test("rename leaves other values alone and comments escape HTML once", async () => {
  const m = mock(normal);
  await runManagedMondayAction(
    "monday_update_item_name",
    { auth, board_id: "100", item_id: "200", name: "New name" },
    m.request,
  );
  expect(m.calls[2]!.v.values).toBe('{"name":"New name"}');
  const c = mock(normal);
  expect(
    await runManagedMondayAction(
      "monday_create_update",
      { auth, board_id: "100", item_id: "200", body: "Hi <script>&\nnext" },
      c.request,
    ),
  ).toEqual({ data: { create_update: { id: "300" } } });
  expect(c.calls[1]!.v).toEqual({
    item: "200",
    body: "Hi &lt;script&gt;&amp;<br>next",
  });
});
test("invalid inputs fail before any request", async () => {
  const m = mock(() => {
    throw Error("should not call");
  });
  const cases: Array<[string, any]> = [
    ["monday_create_column", {}],
    ["monday_create_item", { item_name: "" }],
    ["monday_create_item", { item_name: "x", board_id: "../x" }],
    ["monday_create_item", { item_name: "x", create_labels_if_missing: true }],
    [
      "monday_create_item",
      { item_name: "x", column_values: { name: "hidden" } },
    ],
    [
      "monday_create_item",
      { item_name: "x", column_values: { text: { nested: true } } },
    ],
    [
      "monday_update_column_values_of_item",
      { item_id: "200", column_values: { text: "", date: null } },
    ],
    ["monday_create_update", { item_id: "200", body: "" }],
    ["monday_get_item_column_values", { item_id: 200 }],
    ["monday_get_item_column_values", { item_id: "200", column_ids: "text" }],
  ];
  for (const [action, input] of cases)
    await expect(
      runManagedMondayAction(
        action,
        { auth, board_id: "100", ...input },
        m.request,
      ),
    ).rejects.toThrow();
  expect(m.calls).toHaveLength(0);
});
test("dates and column types are checked before mutations", async () => {
  for (const value of [
    { date: "2026-02-30" },
    { number: "12" },
    { check: "false" },
    { text: true },
  ]) {
    const m = mock(normal);
    await expect(
      runManagedMondayAction(
        "monday_update_column_values_of_item",
        { auth, board_id: "100", item_id: "200", column_values: value },
        m.request,
      ),
    ).rejects.toThrow();
    expect(m.calls.every((c) => c.q.startsWith("query"))).toBe(true);
  }
});
test("partial GraphQL failures, oversized bodies and HTTP errors never become success", async () => {
  for (const result of [
    Response.json({
      data: { items: [item()] },
      errors: [{ message: "PRIVATE" }],
    }),
    Response.json({ errors: [] }),
    new Response("x".repeat(1048577)),
    ...[401, 403, 429, 500].map((status) =>
      Response.json({ secret: "PRIVATE" }, { status }),
    ),
  ]) {
    const m = mock(() => result);
    try {
      await runManagedMondayAction(
        "monday_get_item_column_values",
        { auth, board_id: "100", item_id: "200" },
        m.request,
      );
      throw Error("expected failure");
    } catch (e) {
      expect(String(e)).not.toContain("PRIVATE");
      expect(String(e)).not.toContain("TEST_ONLY");
    }
  }
});
test("uncertain mutation executes once and asks to inspect the item", async () => {
  let writes = 0;
  const m = mock((q, v) => {
    if (q.startsWith("mutation")) {
      writes++;
      throw Error("secret transport failure");
    }
    return normal(q, v);
  });
  await expect(
    runManagedMondayAction(
      "monday_create_item",
      { auth, board_id: "100", item_name: "New" },
      m.request,
    ),
  ).rejects.toThrow("uncertain");
  expect(writes).toBe(1);
});

test("managed schema changes are isolated from manual tokens and unknown actions", async () => {
  const { mondayEngineProps, mondayInputSchema } =
    await import("./managed-monday-inputs");
  expect(
    mondayEngineProps("@activepieces/piece-monday", "monday_create_item", {
      auth: { secret_text: "manual" },
    }),
  ).toBeNull();
  expect(
    mondayEngineProps("@activepieces/piece-monday", "monday_create_column", {
      auth,
    }),
  ).toBeNull();
  const props = mondayEngineProps(
    "@activepieces/piece-monday",
    "monday_create_item",
    { auth },
  )!;
  expect(props.workspace_id).toBeUndefined();
  expect(props.column_values.type).toBe("JSON");
  expect(
    mondayInputSchema("monday_create_update")!.fields.find(
      (f) => f.name === "board_id",
    )?.required,
  ).toBe(true);
});
