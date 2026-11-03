import { expect, test } from "bun:test";
import {
  runManagedAirtableAction,
  managedAirtableIssue,
  airtableJson,
} from "./managed-airtable";
import {
  authorizePieceDispatch,
  executeAuthorizedPiece,
} from "./piece-effect-guard";
import {
  resolveGovernedPieceAction,
  tracksPieceCompletion,
} from "./piece-effects";
const base_id = "appAAAAAAAAAAAAAA",
  table_id_or_name = "tblAAAAAAAAAAAAAA",
  record_id = "recAAAAAAAAAAAAAA",
  fieldId = "fldAAAAAAAAAAAAAA";
const input = {
  base_id,
  table_id_or_name,
  record_id,
  auth: { secret_text: "PRIVATE", jarvis_managed: "airtable" },
  fields: { Name: "Hello" },
  search_field: fieldId,
  search_value: "Hello",
};
const record = {
  id: record_id,
  createdTime: "2026-10-28T10:00:00Z",
  fields: { Name: "Hello" },
};
const schema = {
  tables: [
    {
      id: table_id_or_name,
      name: "Tasks",
      fields: [
        { id: fieldId, name: "Name", type: "singleLineText" },
        { id: "fldBBBBBBBBBBBBBB", name: "Computed", type: "formula" },
      ],
      views: [],
    },
  ],
};
function transport(
  calls: Array<{ url: string; init?: RequestInit }>,
  reply: unknown = record,
) {
  return (async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(String(url).includes("/meta/bases/") ? schema : reply);
  }) as typeof fetch;
}
test("record writes use fixed endpoints, existing fields, typecast false and no retry", async () => {
  for (const action of ["create_record_ai", "update_record_ai"]) {
    const calls: any[] = [];
    expect(
      await runManagedAirtableAction(action, input, transport(calls)),
    ).toEqual(record);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(
      "https://api.airtable.com/v0/" +
        base_id +
        "/" +
        table_id_or_name +
        (action.includes("update") ? "/" + record_id : ""),
    );
    expect(JSON.parse(calls[1].init.body)).toEqual({
      fields: { [fieldId]: "Hello" },
      typecast: false,
    });
    expect(calls[1].init.redirect).toBe("error");
  }
  let writes = 0;
  await expect(
    runManagedAirtableAction("create_record_ai", input, (async (url) => {
      if (String(url).includes("/meta/")) return Response.json(schema);
      writes++;
      throw Error("PRIVATE");
    }) as typeof fetch),
  ).rejects.toThrow("did not confirm");
  expect(writes).toBe(1);
});
test("unsupported actions, invalid IDs, schema edits and computed fields fail before a write", async () => {
  expect(managedAirtableIssue("custom_api_call", input)).not.toBeNull();
  expect(
    managedAirtableIssue("get_record", { ...input, base_id: "../evil" }),
  ).not.toBeNull();
  for (const fields of [
    { Unknown: "bad" },
    { Computed: "bad" },
    { Name: { object: "bad" } },
  ]) {
    const calls: any[] = [];
    await expect(
      runManagedAirtableAction(
        "create_record_ai",
        { ...input, fields },
        transport(calls),
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  }
});
test("find uses escaped case-sensitive contains formula and consumes pagination", async () => {
  let page = 0;
  const calls: any[] = [];
  const request = (async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/meta/")) return Response.json(schema);
    page++;
    return Response.json({
      records: [record],
      ...(page === 1 ? { offset: "opaque/next" } : {}),
    });
  }) as typeof fetch;
  expect(
    await runManagedAirtableAction(
      "search_records",
      { ...input, search_value: 'x"),TRUE(),("' },
      request,
    ),
  ).toMatchObject({ count: 2, records: [record, record] });
  const first = new URL(calls[1].url);
  expect(first.searchParams.get("filterByFormula")).toBe(
    "FIND(" + JSON.stringify('x"),TRUE(),("') + ",{Name})",
  );
  expect(new URL(calls[2].url).searchParams.get("offset")).toBe("opaque/next");
});
test("rate limits and provider error bodies stay redacted and never retry", async () => {
  let calls = 0;
  await expect(
    airtableJson(base_id + "/" + table_id_or_name, "PRIVATE", {}, (async () => {
      calls++;
      return Response.json({ secret: "PRIVATE" }, { status: 429 });
    }) as unknown as typeof fetch),
  ).rejects.toThrow("rate limiting");
  expect(calls).toBe(1);
});
test("write authority includes secret-text credential digest and needs a receipt-capable daemon", async () => {
  const params = {
    apiUrl: "http://localhost",
    engineToken: "engine",
    piece: "@activepieces/piece-airtable",
    action: "create_record_ai",
    stepName: "create",
    executionPath: [],
    input,
  };
  let sent: any;
  await expect(
    authorizePieceDispatch({
      ...params,
      fetchImpl: (async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({ governed: true, dispatch: "authorized" });
      }) as typeof fetch,
    }),
  ).rejects.toThrow("receipt");
  expect(sent.credentialDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(sent)).not.toContain("PRIVATE");
  expect(
    await executeAuthorizedPiece(
      params,
      { governed: true, dispatch: "completed", result: record },
      async () => {
        throw Error("must not replay");
      },
    ),
  ).toEqual(record);
  expect(tracksPieceCompletion(params.piece, params.action)).toBe(true);
  expect(
    resolveGovernedPieceAction(params.piece, "search_records")?.category,
  ).toBe("read_data");
});
