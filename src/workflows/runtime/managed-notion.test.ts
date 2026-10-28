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
import { tracksPieceCompletion } from "./piece-effects";
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
