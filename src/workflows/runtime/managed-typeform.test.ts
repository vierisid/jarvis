import { expect, test } from "bun:test";
import {
  runManagedTypeformAction,
  MANAGED_TYPEFORM_ACTIONS,
} from "./managed-typeform";
import {
  resolveGovernedPieceAction,
  tracksPieceCompletion,
} from "./piece-effects";
const auth = { jarvis_managed: "typeform", access_token: "PRIVATE" };
const page = { total_items: 1, page_count: 1, items: [{ id: "form1" }] };
test("all four actions are reads with no write receipts", () => {
  for (const a of MANAGED_TYPEFORM_ACTIONS) {
    expect(
      resolveGovernedPieceAction("@activepieces/piece-typeform", a),
    ).toMatchObject({ known: true, category: "read_data" });
    expect(tracksPieceCompletion("@activepieces/piece-typeform", a)).toBe(
      false,
    );
  }
});
test("bounded pagination and exact optional filters", async () => {
  let target = "";
  const fetcher = (async (u: string | URL | Request, i?: RequestInit) => {
    target = String(u);
    expect(i?.method).toBe("GET");
    expect(i?.redirect).toBe("error");
    return Response.json(page);
  }) as unknown as typeof fetch;
  expect(
    await runManagedTypeformAction(
      "list_forms",
      {
        auth,
        page: 2,
        pageSize: 100,
        search: "team",
        workspace: "w1",
        sortBy: "created_at",
        orderBy: "asc",
      },
      fetcher,
    ),
  ).toEqual(page);
  expect(new URL(target).searchParams.get("workspace_id")).toBe("w1");
  expect(new URL(target).searchParams.get("page")).toBe("2");
});
test("response region comes from a verified form link, including legacy EU", async () => {
  const urls: string[] = [];
  const f = (async (u: string | URL | Request) => {
    urls.push(String(u));
    return Response.json(
      urls.length === 1
        ? {
            id: "form1",
            title: "Form",
            _links: {
              responses: "https://api.eu.typeform.com/forms/form1/responses",
            },
          }
        : { total_items: 0, page_count: 0, items: [] },
    );
  }) as unknown as typeof fetch;
  expect(
    await runManagedTypeformAction(
      "list_responses",
      {
        auth,
        form_id: "form1",
        after: "response1",
        since: "2026-10-01T00:00:00Z",
        responseType: "completed",
      },
      f,
    ),
  ).toMatchObject({ items: [] });
  expect(urls[1]).toStartWith(
    "https://api.eu.typeform.com/forms/form1/responses?",
  );
  expect(new URL(urls[1]!).searchParams.get("after")).toBe("response1");
});
test("untrusted response links never receive a token", async () => {
  for (const url of [
    "https://evil.test/forms/f/responses",
    "https://api.typeform.com.evil.test/forms/f/responses",
    "https://api.typeform.com/forms/other/responses",
    "https://api.typeform.eu/forms/f/responses",
  ]) {
    let calls = 0;
    await expect(
      runManagedTypeformAction(
        "list_responses",
        { auth, form_id: "f" },
        (async () => {
          calls++;
          return Response.json({
            id: "f",
            title: "Form",
            _links: { responses: url },
          });
        }) as unknown as typeof fetch,
      ),
    ).rejects.toThrow("not supported");
    expect(calls).toBe(1);
  }
});
test("unsupported actions, IDs and filter types fail before dispatch", async () => {
  let calls = 0;
  const f = (async () => {
    calls++;
    return Response.json(page);
  }) as unknown as typeof fetch;
  for (const [action, input] of [
    ["create_form", {}],
    ["get_form", { form_id: "../x" }],
    ["list_forms", { pageSize: 0 }],
    ["list_forms", { page: "2" }],
    ["list_responses", { form_id: "f", before: "a", after: "b" }],
    ["list_responses", { form_id: "f", responseType: "invalid" }],
    ["list_responses", { form_id: "f", since: "invalid" }],
  ] as const)
    await expect(
      runManagedTypeformAction(action, { auth, ...input }, f),
    ).rejects.toThrow();
  expect(calls).toBe(0);
});
test("provider failures are redacted and never retried", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await expect(
      runManagedTypeformAction("list_forms", { auth }, (async () => {
        calls++;
        return new Response("PRIVATE", { status });
      }) as unknown as typeof fetch),
    ).rejects.not.toThrow("PRIVATE");
    expect(calls).toBe(1);
  }
});
test("invalid or oversized pages cannot masquerade as success", async () => {
  for (const value of [
    [],
    {},
    { items: [], total_items: "1", page_count: 1 },
    { ...page, huge: "x".repeat(1048576) },
  ])
    await expect(
      runManagedTypeformAction("list_forms", { auth }, (async () =>
        Response.json(value)) as unknown as typeof fetch),
    ).rejects.toThrow();
});
