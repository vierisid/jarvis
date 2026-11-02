import { metadataToCatalogEntry } from "./piece-catalog";
import { expect, test } from "bun:test";
import {
  runManagedNotionAction,
  managedNotionIssue,
  notionJson,
} from "./managed-notion";
import {
  authorizePieceDispatch,
  executeAuthorizedPiece,
} from "./piece-effect-guard";
import { GOVERNED_PIECE_ADAPTERS, resolveGovernedPieceAction, tracksPieceCompletion } from "./piece-effects";
const id = "11111111-1111-4111-8111-111111111111",
  child = "22222222-2222-4222-8222-222222222222";
const input = {
  auth: { access_token: "PRIVATE", jarvis_managed: "notion" },
  pageId: id,
  block_id: id,
  title: "Notes",
  content: "Hello",
};
const page = (title = "Notes") => ({
  object: "page",
  id,
  url: "https://www.notion.so/" + id,
  properties: { title: { type: "title", title: [{ plain_text: title }] } },
});
const block = (id: string, nested = false) => ({
  object: "block",
  id,
  type: "paragraph",
  has_children: nested,
  paragraph: { rich_text: [{ type: "text", text: { content: "Hello" } }] },
});
const list = (
  results: unknown[],
  more = false,
  cursor: string | null = null,
) => ({ object: "list", results, has_more: more, next_cursor: cursor });
test("create and append use one fixed-origin request, plain text chunks and no write retries", async () => {
  for (const action of ["createPage", "append_to_page"]) {
    let calls = 0;
    await runManagedNotionAction(
      action,
      { ...input, content: "# " + "a".repeat(2000) },
      (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls++;
        expect(String(url)).toBe(
          "https://api.notion.com/v1/" +
            (action === "createPage" ? "pages" : "blocks/" + id + "/children"),
        );
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("Notion-Version")).toBe(
          "2026-03-11",
        );
        const body = JSON.parse(String(init?.body));
        expect(body.children).toHaveLength(2);
        expect(
          body.children[0].paragraph.rich_text[0].text.content.startsWith("# "),
        ).toBe(true);
        return Response.json(
          action === "createPage" ? page() : list([block(child), block(id)]),
        );
      }) as unknown as typeof fetch,
    );
    expect(calls).toBe(1);
  }
  let calls = 0;
  await expect(
    runManagedNotionAction("createPage", input, (async () => {
      calls++;
      throw Error("PRIVATE");
    }) as unknown as typeof fetch),
  ).rejects.toThrow("did not confirm");
  expect(calls).toBe(1);
});
test("unsupported actions, invalid IDs, markdown reads and oversized content fail before network", async () => {
  for (const [action, args] of [
    ["custom_api_call", input],
    ["archive_database_item", input],
    ["createPage", { ...input, pageId: "../evil" }],
    ["append_to_page", { ...input, content: "a".repeat(20001) }],
    ["notion_get_block_children", { ...input, markdown: true }],
    ["notion_get_block_children", { ...input, depth: 4 }],
  ] as const) {
    expect(managedNotionIssue(action, args)).not.toBeNull();
    await expect(
      runManagedNotionAction(action, args, (async () => {
        throw Error("MUST NOT CALL");
      }) as unknown as typeof fetch),
    ).rejects.not.toThrow("MUST NOT CALL");
  }
  expect(
    managedNotionIssue(
      "createPage",
      { ...input, pageId: "{{find.pages[0].id}}" },
      false,
    ),
  ).toBeNull();
  for (const path of [
    "https://evil.test",
    "../users/me",
    "pages#fragment",
    "blocks/../../children",
  ])
    await expect(notionJson(path, "PRIVATE")).rejects.toThrow(
      "Invalid Notion request",
    );
});
test("exact search follows later pages instead of treating the first partial matches as complete", async () => {
  let calls = 0;
  const result = await runManagedNotionAction(
    "find_page",
    { ...input, exact_match: true, limit: 1 },
    (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      if (calls === 1)
        return Response.json(
          list([page("Notes elsewhere")], true, "opaque/next"),
        );
      expect(body.start_cursor).toBe("opaque/next");
      return Response.json(list([page()]));
    }) as unknown as typeof fetch,
  );
  expect(result).toMatchObject({
    returned: 1,
    pages: [{ title: "Notes" }],
    summary: { hasMore: false },
  });
  expect(calls).toBe(2);
});
test("block reading follows pagination and depth without fetching beyond the requested depth", async () => {
  const paths: string[] = [];
  const result = await runManagedNotionAction(
    "notion_get_block_children",
    { ...input, depth: 2, markdown: false },
    (async (url: Parameters<typeof fetch>[0]) => {
      const u = new URL(String(url));
      paths.push(u.pathname);
      return Response.json(
        list([
          block(
            u.pathname.includes(child) ? id : child,
            !u.pathname.includes(child),
          ),
        ]),
      );
    }) as unknown as typeof fetch,
  );
  expect(paths).toHaveLength(2);
  expect(result).toMatchObject([{ id: child, children: [{ id }] }]);
});
test("rate limits, malformed replies, oversized bodies and partial append confirmations remain failures", async () => {
  for (const response of [
    Response.json({ secret: "PRIVATE" }, { status: 429 }),
    new Response("PRIVATE"),
    new Response("x".repeat(1048577)),
  ])
    await expect(
      notionJson(
        "search",
        "PRIVATE",
        {},
        (async () => response) as unknown as typeof fetch,
      ),
    ).rejects.not.toThrow("PRIVATE");
  await expect(
    runManagedNotionAction("append_to_page", input, (async () =>
      Response.json(list([]))) as unknown as typeof fetch),
  ).rejects.toThrow("did not confirm");
});
test("write authority records a credential digest, requires a receipt and never replays completed dispatch", async () => {
  const params = {
    apiUrl: "http://localhost",
    engineToken: "engine",
    piece: "@activepieces/piece-notion",
    action: "createPage",
    stepName: "create",
    executionPath: [],
    input,
  };
  let sent: any;
  await expect(
    authorizePieceDispatch({
      ...params,
      fetchImpl: (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({ governed: true, dispatch: "authorized" });
      }) as unknown as typeof fetch,
    }),
  ).rejects.toThrow("receipt");
  expect(sent.credentialDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(sent)).not.toContain("PRIVATE");
  expect(tracksPieceCompletion(params.piece, "append_to_page")).toBe(true);
  expect(
    await executeAuthorizedPiece(
      params,
      { governed: true, dispatch: "completed", result: page() },
      async () => {
        throw Error("must not replay");
      },
    ),
  ).toEqual(page());
});

test("multiple auth methods retain a connection picker and ordinary single-method pieces are unchanged", () => {
  const projected = metadataToCatalogEntry({
    name: "@activepieces/piece-notion",
    auth: [
      { type: "NO_AUTH" },
      { type: "OAUTH2", displayName: "Connection" },
      { type: "CUSTOM_AUTH" },
    ],
    actions: {},
  });
  expect(projected.auth).toEqual({ type: "OAUTH2", displayName: "Connection" });
  expect(
    metadataToCatalogEntry({
      name: "test",
      auth: { type: "SECRET_TEXT" },
      actions: {},
    }).auth?.type,
  ).toBe("SECRET_TEXT");
  expect(
    metadataToCatalogEntry({
      name: "test",
      auth: [{ type: "NO_AUTH" }],
      actions: {},
    }).auth,
  ).toBeUndefined();
});

const NOTION = "@activepieces/piece-notion";
/** Every action of the pinned @activepieces/piece-notion 0.8.1 bundle, keyed by
 * the `classification` upstream gives it. The engine test checks the installed
 * package against the adapter too. */
const NOTION_081_BY_UPSTREAM: Record<string, string[]> = {
  SEARCH: ["list_databases", "notion-find-database-item", "list_database_pages", "find_page", "notion_search",
    "notion_list_users", "notion_query_database", "notion_find_database_item"],
  READ: ["getPageOrBlockChildren", "retrieve_database", "get_page_comments", "notion_get_page",
    "notion_get_block_children", "notion_get_page_comments", "notion_get_user", "notion_get_database"],
  WRITE: ["create_database_item", "update_database_item", "createPage", "append_to_page", "restore_database_item",
    "add_comment", "notion_create_page", "notion_move_page", "notion_append_to_page", "notion_update_block",
    "notion_add_comment", "notion_create_database", "notion_create_database_item", "notion_update_database_item",
    "notion_restore_database_item"],
  DESTRUCTIVE: ["archive_database_item", "notion_archive_page", "notion_delete_block",
    "notion_update_database_schema", "notion_archive_database_item"],
};
/** Where Jarvis departs from upstream's label: comments notify people, and a move changes the page's sharing. */
const SENDS = ["add_comment", "notion_add_comment"];
const MOVES = ["notion_move_page"];
const expectedCategory = (upstream: string, name: string) =>
  SENDS.includes(name) ? "send_message" : MOVES.includes(name) ? "delete_data"
    : upstream === "READ" || upstream === "SEARCH" ? "read_data" : upstream === "DESTRUCTIVE" ? "delete_data" : "write_data";
test("the Notion adapter names every action of the pinned bundle, each in the category it should have", () => {
  const all = Object.values(NOTION_081_BY_UPSTREAM).flat();
  expect(all).toHaveLength(36);
  const adapter = GOVERNED_PIECE_ADAPTERS.find((a) => a.pieceName === NOTION)!;
  expect((Object.values(adapter.categories).flat() as string[]).filter((n) => n !== "custom_api_call").sort()).toEqual([...all].sort());
  const table = Object.fromEntries(Object.entries(NOTION_081_BY_UPSTREAM).flatMap(([upstream, names]) =>
    names.map((name) => [name, expectedCategory(upstream, name)])));
  expect(Object.fromEntries(all.map((name) => [name, resolveGovernedPieceAction(NOTION, name)!.category as string]))).toEqual(table);
  expect(all.filter((name) => !resolveGovernedPieceAction(NOTION, name)!.known)).toEqual([]);
  expect(resolveGovernedPieceAction(NOTION, "custom_api_call")).toMatchObject({ category: "delete_data" });
  expect(resolveGovernedPieceAction(NOTION, "added_upstream_later")).toMatchObject({ category: "delete_data", known: false });
  // A completion receipt for every change, never for a read or a custom call that may be one.
  for (const name of all)
    expect(`${name}: ${tracksPieceCompletion(NOTION, name)}`).toBe(`${name}: ${table[name] !== "read_data"}`);
  expect(tracksPieceCompletion(NOTION, "custom_api_call")).toBe(false);
});
test("archive or restore page narrows to a write only for an explicit restore", () => {
  const category = (input?: Record<string, unknown>) => resolveGovernedPieceAction(NOTION, "notion_archive_page", input)!.category;
  expect(category()).toBe("delete_data");
  expect(category({ page_id: id, archived: true })).toBe("delete_data");
  expect(category({ page_id: id, archived: "{{trigger.archived}}" })).toBe("delete_data");
  expect(category({ page_id: id, archived: false })).toBe("write_data");
});
test("pages from API 2026-03-11 (in_trash, no archived) keep the advertised archived field", async () => {
  const current = { ...page(), in_trash: false, created_time: "2026-10-28T10:00:00.000Z" };
  const request = (async () => Response.json(list([current]))) as unknown as typeof fetch;
  const found: any = await runManagedNotionAction("find_page", { ...input, title: "Notes" }, request);
  expect(found.pages[0].archived).toBe(false);
  const created: any = await runManagedNotionAction("createPage", input,
    (async () => Response.json({ ...current, in_trash: true })) as unknown as typeof fetch);
  expect(created.archived).toBe(true);
});
