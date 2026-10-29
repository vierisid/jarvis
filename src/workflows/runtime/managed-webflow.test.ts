import { describe, expect, test } from "bun:test";
import {
  MANAGED_WEBFLOW_ACTIONS,
  runManagedWebflowAction,
  WEBFLOW_RESPONSE_LIMIT,
} from "./managed-webflow";
import { executeAuthorizedPiece } from "./piece-effect-guard";
const site = "a".repeat(24),
  collection = "b".repeat(24),
  id = "c".repeat(24),
  locale = "d".repeat(24);
const schema = {
  id: collection,
  fields: [
    {
      slug: "name",
      displayName: "Name",
      type: "PlainText",
      isRequired: true,
      isEditable: true,
    },
    {
      slug: "slug",
      displayName: "Slug",
      type: "PlainText",
      isRequired: true,
      isEditable: true,
    },
    {
      slug: "featured",
      displayName: "Featured",
      type: "Switch",
      isRequired: false,
      isEditable: true,
    },
    {
      slug: "price",
      displayName: "Price",
      type: "Number",
      isRequired: false,
      isEditable: true,
    },
    {
      slug: "image",
      displayName: "Image",
      type: "Image",
      isRequired: false,
      isEditable: true,
    },
  ],
};
const sample = {
  id,
  cmsLocaleId: locale,
  isDraft: true,
  isArchived: false,
  fieldData: { name: "Draft", slug: "draft" },
  lastPublished: null,
};
const input = {
  auth: {
    jarvis_managed: "webflow",
    access_token: "SECRET-TOKEN",
    webflow_site_ids: [site],
  },
  site_id: site,
  collection_id: collection,
  collection_item_id: id,
  collection_fields: {
    name: "New draft",
    slug: "new-draft",
    featured: false,
    price: 0,
  },
  field_name: "name",
  field_value: "Draft",
  max_results: 20,
};
function fixture(
  override?: (url: URL, init: RequestInit) => Response | undefined,
) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const request = (async (raw: unknown, init: RequestInit) => {
    const url = new URL(String(raw));
    calls.push({ url, init });
    expect(url.origin).toBe("https://api.webflow.com");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeDefined();
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer SECRET-TOKEN",
    );
    const changed = override?.(url, init);
    if (changed) return changed;
    if (url.pathname.endsWith("/collections") && init.method === "GET")
      return Response.json({
        collections: [{ id: collection, displayName: "Articles" }],
      });
    if (url.pathname === "/v2/sites/" + site)
      return Response.json({
        id: site,
        locales: { primary: { cmsLocaleId: locale } },
      });
    if (url.pathname === "/v2/collections/" + collection)
      return Response.json(schema);
    if (url.pathname.endsWith("/items") && init.method === "GET")
      return Response.json({
        items: [sample],
        pagination: { offset: 0, limit: 100, total: 1 },
      });
    if (init.method !== "GET") {
      const body = JSON.parse(String(init.body));
      expect(body.isDraft).toBe(true);
      expect(body.isArchived).toBe(false);
      expect(body.cmsLocaleId).toBe(locale);
      return Response.json({ ...sample, fieldData: body.fieldData });
    }
    return Response.json(sample);
  }) as typeof fetch;
  return { calls, request };
}
describe("managed Webflow v2 CMS", () => {
  for (const action of MANAGED_WEBFLOW_ACTIONS)
    test(
      action + " uses fixed v2 paths and documented CMS outputs",
      async () => {
        const f = fixture(),
          result: any = await runManagedWebflowAction(action, input, f.request);
        expect(
          action === "find_collection_item" ? result.result[0].id : result.id,
        ).toBe(id);
        expect(f.calls.filter((c) => c.init.method !== "GET")).toHaveLength(
          action.startsWith("get") || action.startsWith("find") ? 0 : 1,
        );
        expect(f.calls.some((c) => /live|publish/.test(c.url.pathname))).toBe(
          false,
        );
        if (action === "create_collection_item")
          expect(result.fieldData).toEqual(input.collection_fields);
      },
    );
  test("authorization refusal never dispatches", async () => {
    let invoked = false;
    await expect(
      executeAuthorizedPiece(
        {
          piece: "@activepieces/piece-webflow",
          action: "create_collection_item",
          input,
        } as any,
        { governed: true, dispatch: "held" } as any,
        async () => {
          invoked = true;
        },
      ),
    ).rejects.toThrow("authorization");
    expect(invoked).toBe(false);
  });
  for (const changes of [
    { site_id: "../sites" },
    { collection_id: "https://evil.test" },
    { auth: { ...input.auth, webflow_site_ids: [] } },
    { is_draft: false },
    { is_archived: true },
    { max_results: 0 },
  ])
    test(
      "rejects invalid input before provider access " + JSON.stringify(changes),
      async () => {
        const f = fixture();
        await expect(
          runManagedWebflowAction(
            "max_results" in changes
              ? "find_collection_item"
              : "create_collection_item",
            { ...input, ...changes },
            f.request,
          ),
        ).rejects.toThrow();
        expect(f.calls).toHaveLength(0);
      },
    );
  for (const action of [
    "delete_collection_item",
    "fulfill_order",
    "custom_api_call",
    "new_form_submission",
  ])
    test("blocks " + action, async () => {
      const f = fixture();
      await expect(
        runManagedWebflowAction(action, input, f.request),
      ).rejects.toThrow("not enabled");
      expect(f.calls).toHaveLength(0);
    });
  test("refuses another site's collection", async () => {
    const f = fixture((url) =>
      url.pathname.endsWith("/collections")
        ? Response.json({ collections: [] })
        : undefined,
    );
    await expect(
      runManagedWebflowAction("create_collection_item", input, f.request),
    ).rejects.toThrow("selected Webflow site");
    expect(f.calls).toHaveLength(1);
  });
  for (const changes of [
    { isDraft: false },
    { isArchived: true },
    { cmsLocaleId: "e".repeat(24) },
    { id: "e".repeat(24) },
  ])
    test(
      "does not update an ineligible item " + JSON.stringify(changes),
      async () => {
        const f = fixture((url, init) =>
          url.pathname.endsWith("/items/" + id) && init.method === "GET"
            ? Response.json({ ...sample, ...changes })
            : undefined,
        );
        await expect(
          runManagedWebflowAction("update_collection_item", input, f.request),
        ).rejects.toThrow();
        expect(f.calls.every((c) => c.init.method === "GET")).toBe(true);
      },
    );
  for (const fields of [
    { name: "Draft" },
    { name: "Draft", slug: "draft", image: "https://elsewhere.test/a.png" },
    { name: "Draft", slug: "draft", featured: "false" },
    { name: "Draft", slug: "draft", price: Infinity },
    { unknown: "field" },
  ])
    test(
      "validates CMS schema before writes " + JSON.stringify(fields),
      async () => {
        const f = fixture();
        await expect(
          runManagedWebflowAction(
            "create_collection_item",
            { ...input, collection_fields: fields },
            f.request,
          ),
        ).rejects.toThrow();
        expect(f.calls.every((c) => c.init.method === "GET")).toBe(true);
      },
    );
  test("find paginates and preserves the result wrapper", async () => {
    const f = fixture((url) =>
      url.pathname.endsWith("/items")
        ? Response.json({
            items: [
              {
                ...sample,
                id:
                  url.searchParams.get("offset") === "0" ? "e".repeat(24) : id,
                fieldData: {
                  name:
                    url.searchParams.get("offset") === "0" ? "Other" : "Draft",
                  slug: "draft",
                },
              },
            ],
            pagination: {
              offset: Number(url.searchParams.get("offset")),
              total: 2,
            },
          })
        : undefined,
    );
    expect(
      await runManagedWebflowAction("find_collection_item", input, f.request),
    ).toEqual({ success: true, result: [sample] });
    expect(f.calls.at(-1)!.url.searchParams.get("offset")).toBe("1");
  });
  test("find errors instead of presenting a partial scan as complete", async () => {
    const f = fixture((url) =>
      url.pathname.endsWith("/items")
        ? Response.json({
            items: Array.from({ length: 100 }, (_, n) => ({
              ...sample,
              id: (Number(url.searchParams.get("offset")) + n)
                .toString(16)
                .padStart(24, "0"),
              fieldData: { name: "Other", slug: "other" },
            })),
            pagination: {
              offset: Number(url.searchParams.get("offset")),
              total: 1001,
            },
          })
        : undefined,
    );
    await expect(
      runManagedWebflowAction("find_collection_item", input, f.request),
    ).rejects.toThrow("1,000");
  });
  for (const status of [401, 403, 429, 503])
    test("safe error for HTTP " + status, async () => {
      const f = fixture(() =>
        Response.json({ error: "SECRET-TOKEN" }, { status }),
      );
      const e = await runManagedWebflowAction(
        "get_collection_item",
        input,
        f.request,
      ).catch((e) => e);
      expect(e).toBeInstanceOf(Error);
      expect(String(e)).not.toContain("SECRET");
      expect(f.calls).toHaveLength(1);
    });
  test("uncertain create is never retried and tells the user to check", async () => {
    const f = fixture((_url, init) => {
      if (init.method === "POST") throw Error("SECRET-TOKEN");
      return undefined;
    });
    await expect(
      runManagedWebflowAction("create_collection_item", input, f.request),
    ).rejects.toThrow("may already have changed");
    expect(f.calls.filter((c) => c.init.method === "POST")).toHaveLength(1);
  });
  test("response body cap fails safely", async () => {
    const f = fixture(
      () => new Response(" ".repeat(WEBFLOW_RESPONSE_LIMIT + 1)),
    );
    await expect(
      runManagedWebflowAction("get_collection_item", input, f.request),
    ).rejects.toThrow("2 MiB");
  });
});
