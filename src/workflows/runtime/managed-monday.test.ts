import { expect, test } from "bun:test";
import {
  MANAGED_MONDAY_ACTIONS,
  runManagedMondayAction,
  mondayGraphql,
} from "./managed-monday";
import {
  MANAGED_PIECE_ADAPTERS,
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
/** Every action of the pinned 0.4.0 bundle, in upstream's order. The engine
 * test checks this list against the installed package. */
const MONDAY_040_ACTIONS = [
  "monday_create_column", "monday_create_group", "monday_create_item", "monday_create_update",
  "monday_get_board_values", "monday_get_item_column_values", "monday_update_column_values_of_item",
  "monday_update_item_name", "monday_upload_file_to_column", "monday_add_teams_to_board",
  "monday_add_users_to_board", "monday_archive_board", "monday_create_board", "monday_delete_board",
  "monday_duplicate_board", "monday_get_board_activity_logs", "monday_list_board_views",
  "monday_list_boards", "monday_remove_board_subscribers", "monday_remove_teams_from_board",
  "monday_update_board_hierarchy", "monday_update_board", "monday_add_board_column", "monday_delete_column",
  "monday_get_column_type_schema", "monday_list_columns", "monday_update_column",
  "monday_append_markdown_to_doc", "monday_create_doc_block", "monday_create_doc", "monday_delete_doc_block",
  "monday_delete_doc", "monday_duplicate_doc", "monday_export_doc_as_markdown", "monday_get_doc_blocks",
  "monday_import_doc_from_html", "monday_list_docs", "monday_rename_doc", "monday_update_doc_block",
  "monday_get_assets", "monday_upload_file", "monday_create_folder", "monday_delete_folder",
  "monday_list_folders", "monday_update_folder", "monday_add_board_group", "monday_archive_group",
  "monday_delete_group", "monday_duplicate_group", "monday_list_groups", "monday_update_group",
  "monday_archive_item", "monday_change_column_value", "monday_change_item_position",
  "monday_change_simple_column_value", "monday_clear_item_updates", "monday_create_board_item",
  "monday_create_subitem", "monday_delete_item", "monday_duplicate_item", "monday_get_items",
  "monday_list_board_items", "monday_list_subitems", "monday_move_item_to_board",
  "monday_move_item_to_group", "monday_rename_item", "monday_search_items_by_column_values",
  "monday_set_item_column_values", "monday_update_assets_on_item", "monday_aggregate_board_data",
  "monday_create_or_get_tag", "monday_get_board_mute_settings", "monday_get_favorites", "monday_get_form",
  "monday_list_notifications", "monday_list_tags", "monday_search", "monday_send_notification",
  "monday_update_board_mute_settings", "monday_delete_update", "monday_edit_update", "monday_like_update",
  "monday_list_board_updates", "monday_list_item_updates", "monday_pin_update", "monday_post_item_update",
  "monday_unlike_update", "monday_unpin_update", "monday_get_account", "monday_get_me", "monday_list_teams",
  "monday_list_users", "monday_add_teams_to_workspace", "monday_add_users_to_workspace",
  "monday_create_workspace", "monday_delete_teams_from_workspace", "monday_delete_users_from_workspace",
  "monday_delete_workspace", "monday_list_workspaces", "monday_update_workspace",
];
const MONDAY = "@activepieces/piece-monday";
const SENDS = ["monday_create_update", "monday_post_item_update", "monday_edit_update", "monday_send_notification"];
const DELETES = ["monday_delete_item", "monday_archive_item", "monday_clear_item_updates", "monday_delete_update",
  "monday_delete_column", "monday_delete_group", "monday_archive_group", "monday_delete_board", "monday_archive_board",
  "monday_delete_doc", "monday_delete_doc_block", "monday_delete_folder", "monday_delete_workspace",
  "monday_remove_board_subscribers", "monday_remove_teams_from_board", "monday_delete_users_from_workspace",
  "monday_delete_teams_from_workspace"];
const SETTINGS = ["monday_add_users_to_board", "monday_add_teams_to_board", "monday_add_users_to_workspace",
  "monday_add_teams_to_workspace", "monday_update_board_mute_settings", "monday_create_board", "monday_duplicate_board",
  "monday_create_workspace", "monday_update_workspace", "monday_update_board_hierarchy", "monday_update_folder"];
const READ = /^monday_(get|list|search|export|aggregate)_|^monday_search$/;
test("the monday.com adapter names every action of the pinned bundle, each in the category it should have", () => {
  expect(MONDAY_040_ACTIONS).toHaveLength(100);
  const adapter = MANAGED_PIECE_ADAPTERS.find((a) => a.pieceName === MONDAY)!;
  expect((Object.values(adapter.categories).flat() as string[]).sort()).toEqual([...MONDAY_040_ACTIONS].sort());
  const expected = (name: string) => SENDS.includes(name) ? "send_message" : DELETES.includes(name) ? "delete_data"
    : SETTINGS.includes(name) ? "modify_settings" : READ.test(name) ? "read_data" : "write_data";
  for (const name of MONDAY_040_ACTIONS) {
    const resolved = resolveGovernedPieceAction(MONDAY, name)!;
    expect(`${name}: ${resolved.category} ${resolved.known}`).toBe(`${name}: ${expected(name)} true`);
    // A completion receipt for every change, never for a read.
    expect(`${name}: ${tracksPieceCompletion(MONDAY, name)}`).toBe(`${name}: ${expected(name) !== "read_data"}`);
  }
  for (const name of ["custom_api_call", "added_upstream_later"])
    expect(resolveGovernedPieceAction(MONDAY, name)).toMatchObject({ category: "modify_settings", known: false });
  // The managed connection runs a subset of the governed table.
  expect(MANAGED_MONDAY_ACTIONS).toHaveLength(5);
  for (const name of MANAGED_MONDAY_ACTIONS) expect(MONDAY_040_ACTIONS).toContain(name);
  expect(resolveGovernedPieceAction(MONDAY, "monday_get_item_column_values")?.category).toBe("read_data");
  expect(resolveGovernedPieceAction(MONDAY, "monday_create_update")?.category).toBe("send_message");
});
test("monday.com board, workspace and folder access changes narrow only by input", () => {
  const category = (action: string, input?: Record<string, unknown>) => resolveGovernedPieceAction(MONDAY, action, input)!.category;
  expect(category("monday_create_board")).toBe("modify_settings");
  expect(category("monday_create_board", { board_name: "Mine", board_kind: "private" })).toBe("write_data");
  expect(category("monday_create_board", { board_kind: "private", board_owner_ids: [] , board_subscriber_ids: [] })).toBe("write_data");
  expect(category("monday_create_board", { board_kind: "public" })).toBe("modify_settings");
  expect(category("monday_create_board", { board_kind: "share" })).toBe("modify_settings");
  expect(category("monday_create_board", { board_kind: "{{trigger.kind}}" })).toBe("modify_settings");
  expect(category("monday_create_board", { board_kind: "private", board_subscriber_ids: ["1"] })).toBe("modify_settings");
  expect(category("monday_create_board", { board_kind: "private", board_owner_ids: ["1"] })).toBe("modify_settings");
  expect(category("monday_duplicate_board", { board_id: "1" })).toBe("write_data");
  expect(category("monday_duplicate_board", { board_id: "1", keep_subscribers: false })).toBe("write_data");
  expect(category("monday_duplicate_board", { board_id: "1", keep_subscribers: true })).toBe("modify_settings");
  expect(category("monday_create_workspace", { name: "W", kind: "closed" })).toBe("write_data");
  expect(category("monday_create_workspace", { name: "W", kind: "open" })).toBe("modify_settings");
  expect(category("monday_create_workspace", { name: "W" })).toBe("modify_settings");
  expect(category("monday_update_workspace", { workspace_id: "1", name: "W" })).toBe("write_data");
  expect(category("monday_update_workspace", { workspace_id: "1", kind: "open" })).toBe("modify_settings");
  expect(category("monday_update_workspace", { workspace_id: "1", account_product_id: "2" })).toBe("modify_settings");
  expect(category("monday_update_board_hierarchy", { board_id: "1", folder_id: "2" })).toBe("write_data");
  expect(category("monday_update_board_hierarchy", { board_id: "1", workspace_id: "2" })).toBe("modify_settings");
  expect(category("monday_update_folder", { folder_id: "1", name: "F" })).toBe("write_data");
  expect(category("monday_update_folder", { folder_id: "1", workspace_id: "2" })).toBe("modify_settings");
  // A cut projection is never read: the worst case stands.
  const padded = Object.fromEntries(Array.from({ length: 41 }, (_, i) => ["a" + String(i).padStart(2, "0"), 1]));
  expect(category("monday_create_board", { ...padded, board_kind: "private" })).toBe("modify_settings");
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
