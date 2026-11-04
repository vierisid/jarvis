import { expect, test } from "bun:test";
import {
  runManagedPipedriveAction as run,
  MANAGED_PIPEDRIVE_ACTIONS,
} from "./managed-pipedrive";
import {
  pipedriveInputSchema,
  pipedriveEngineProps,
} from "./managed-pipedrive-inputs";
import {
  resolveGovernedPieceAction,
} from "./piece-effects";
const piece = "@activepieces/piece-pipedrive";
const auth = {
  access_token: "PRIVATE_ACCESS",
  api_host: "sandbox.pipedrive.com",
  jarvis_managed: "pipedrive",
};
function fake(
  answer: unknown = {
    success: true,
    data: { id: 1, name: "Test", title: "Deal" },
  },
  status = 200,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const request = (async (url: any, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json(answer, { status });
  }) as typeof fetch;
  return { calls, request };
}
test("all eight qualified actions share engine/editor schemas and truthful authority", () => {
  for (const action of MANAGED_PIPEDRIVE_ACTIONS) {
    expect(pipedriveInputSchema(action)).not.toBeNull();
    expect(pipedriveEngineProps(piece, action, { auth })).not.toBeNull();
    const mutate = action.startsWith("create") || action.startsWith("update");
    expect(
      resolveGovernedPieceAction(piece, action, { name: "Test", title: "Deal" })
        ?.category,
    ).toBe(mutate ? "write_data" : "read_data");
  }
  expect(pipedriveEngineProps(piece, "delete-person", { auth })).toBeNull();
  expect(
    pipedriveEngineProps(piece, "create-person", {
      auth: { access_token: "manual" },
    }),
  ).toBeNull();
  expect(resolveGovernedPieceAction(piece, "find-person")?.category).toBe(
    "modify_settings",
  );
  expect(
    resolveGovernedPieceAction(piece, "update-person", { ownerId: 2 })
      ?.category,
  ).toBe("modify_settings");
  expect(
    resolveGovernedPieceAction(piece, "update-deal", { status: "deleted" })
      ?.category,
  ).toBe("delete_data");
});
test("search is read-only, encodes terms, flattens output and preserves cursor", async () => {
  const { request, calls } = fake({
    success: true,
    data: { items: [{ item: { id: 1, name: "A & B" }, result_score: 1 }] },
    additional_data: { next_cursor: "opaque+/=" },
  });
  expect(
    await run(
      "search-persons",
      {
        auth,
        term: "A & B",
        fields: ["email"],
        exactMatch: false,
        organizationId: "7",
        limit: 10,
      },
      request,
    ),
  ).toEqual({
    found: true,
    data: [{ id: 1, name: "A & B", result_score: 1 }],
    next_cursor: "opaque+/=",
  });
  const url = new URL(calls[0]!.url);
  expect(url.origin + url.pathname).toBe(
    "https://sandbox.pipedrive.com/api/v2/persons/search",
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    term: "A & B",
    fields: "email",
    limit: "10",
    exact_match: "false",
    organization_id: "7",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.init.method).toBe("GET");
  expect(calls[0]!.init.redirect).toBe("error");
  expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
    "Bearer PRIVATE_ACCESS",
  );
  expect(
    await run(
      "search-deals",
      { auth, term: "none" },
      fake({ success: true, data: { items: [] } }).request,
    ),
  ).toEqual({ found: false, data: [], next_cursor: null });
});
test("mutations map fields to v2; zeros are retained and blank fields preserve existing values", async () => {
  const { request, calls } = fake();
  await run(
    "update-person",
    {
      auth,
      personId: "1",
      name: "New",
      email: ["new@example.test"],
      phone: [],
      organizationId: "",
    },
    request,
  );
  expect(calls[0]!.init.method).toBe("PATCH");
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
    name: "New",
    emails: [{ value: "new@example.test", label: "work", primary: true }],
  });
  await run(
    "create-deal",
    {
      auth,
      title: "Deal",
      dealValue: 0,
      probability: 0,
      dealValueCurrency: "EUR",
      personId: 1,
      expectedCloseDate: "2028-02-29",
    },
    request,
  );
  expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
    title: "Deal",
    value: 0,
    probability: 0,
    currency: "EUR",
    person_id: 1,
    expected_close_date: "2028-02-29",
  });
});
const badInputs: Array<[string, Record<string, unknown>]> = [
  ["delete-person", { personId: 1 }],
  ["create-person", { name: "Test", ownerId: 9 }],
  ["update-person", { personId: 1, email: [] }],
  ["get-person", { personId: "1/../../users" }],
  ["get-deal", { dealId: 0 }],
  ["create-person", { name: "Test", email: ["bad"] }],
  ["search-deals", { term: "x" }],
  ["search-persons", { term: "ok", fields: ["custom_fields"] }],
  ["search-deals", { term: "ok", limit: 101 }],
  ["update-deal", { dealId: 1, status: "deleted" }],
  ["create-deal", { title: "Deal", expectedCloseDate: "2026-02-30" }],
  ["create-deal", { title: "Deal", probability: 101 }],
  [
    "get-deal",
    {
      dealId: 1,
      auth: { ...auth, api_host: "sandbox.pipedrive.com.evil.test" },
    },
  ],
];
for (const [action, input] of badInputs)
  test(
    "invalid " +
      action +
      " input stops before network: " +
      JSON.stringify(input),
    async () => {
      const { request, calls } = fake();
      await expect(run(action, { auth, ...input }, request)).rejects.toThrow();
      expect(calls).toHaveLength(0);
    },
  );
test("malformed responses are bounded, sanitized and never cause an automatic second write", async () => {
  for (const [answer, status] of [
    [{ error: "PRIVATE_ACCESS" }, 500],
    [{ success: false }, 200],
    [{ success: true, data: { id: 2, name: "Wrong target" } }, 200],
    [{ success: true, data: { id: 1, name: "x".repeat(1048576) } }, 200],
  ] as const) {
    const { request, calls } = fake(answer, status);
    const error = await run(
      "update-person",
      { auth, personId: 1, name: "New" },
      request,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("PRIVATE_ACCESS");
    expect(calls).toHaveLength(1);
  }
  let attempts = 0;
  await expect(
    run("create-deal", { auth, title: "Deal" }, (async () => {
      attempts++;
      throw Error("PRIVATE_ACCESS");
    }) as unknown as typeof fetch),
  ).rejects.toThrow("may already have changed");
  expect(attempts).toBe(1);
});
