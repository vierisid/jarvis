import { expect, test } from "bun:test";
import {
  MANAGED_LINEAR_ACTIONS,
  runManagedLinearAction as run,
} from "./managed-linear";
import {
  resolveGovernedPieceAction,
  tracksPieceCompletion,
} from "./piece-effects";
const team = "22222222-2222-4222-8222-222222222222",
  iid = "11111111-1111-4111-8111-111111111111";
const auth = { secret_text: "PRIVATE", jarvis_managed: "linear" };
const item = {
  id: iid,
  identifier: "ENG-1",
  title: "Task",
  description: null,
  url: "https://linear.app/jarvis/issue/ENG-1",
  priority: 2,
  team: { id: team, name: "Engineering", key: "ENG" },
};
const json = (data: unknown) =>
  (async () => Response.json({ data })) as unknown as typeof fetch;
test("five qualified actions have governance and writes have completion receipts", () => {
  for (const a of MANAGED_LINEAR_ACTIONS) {
    const write = /create|update/.test(a);
    expect(
      resolveGovernedPieceAction("@activepieces/piece-linear", a),
    ).toMatchObject({
      known: true,
      category: write ? "write_data" : "read_data",
    });
    expect(tracksPieceCompletion("@activepieces/piece-linear", a)).toBe(write);
  }
});
test("bounded search uses GraphQL variables, OAuth and opaque pagination", async () => {
  const result = await run(
    "linear_search_issues",
    {
      auth,
      term: 'quote"query',
      limit: 100,
      cursor: "opaque+/=",
      team_id: team,
      include_comments: true,
    },
    (async (u: string | URL | Request, i?: RequestInit) => {
      expect(String(u)).toBe("https://api.linear.app/graphql");
      expect(i?.redirect).toBe("error");
      expect(new Headers(i?.headers).get("authorization")).toBe(
        "Bearer PRIVATE",
      );
      const body = JSON.parse(String(i?.body));
      expect(body.query).not.toContain('quote"query');
      expect(body.variables).toEqual({
        term: 'quote"query',
        first: 100,
        after: "opaque+/=",
        includeComments: true,
        includeArchived: false,
        filter: { team: { id: { eq: team } } },
      });
      return Response.json({
        data: {
          searchIssues: {
            nodes: [item],
            totalCount: 3,
            pageInfo: { hasNextPage: true, endCursor: "next" },
          },
        },
      });
    }) as unknown as typeof fetch,
  );
  expect(result).toMatchObject({
    items: [{ id: iid, team_id: team }],
    count: 1,
    has_next_page: true,
    end_cursor: "next",
  });
});
test("update resolves issue keys, checks team and sends only reviewed provided fields", async () => {
  const calls: any[] = [];
  const result = await run(
    "linear_update_issue",
    {
      auth,
      team_id: team,
      issue_id: "eng-1",
      title: "Changed",
      priority_id: 0,
      labels: [],
      url: "https://evil.test",
    },
    (async (_u: string | URL | Request, i?: RequestInit) => {
      const body = JSON.parse(String(i?.body));
      calls.push(body);
      return Response.json({
        data: body.query.startsWith("query")
          ? { issue: item }
          : {
              issueUpdate: {
                success: true,
                lastSyncId: 1,
                issue: { ...item, title: "Changed", priority: 0 },
              },
            },
      });
    }) as unknown as typeof fetch,
  );
  expect(calls[0].variables).toEqual({ id: "ENG-1" });
  expect(calls[1].variables).toEqual({
    id: iid,
    input: { title: "Changed", priority: 0 },
  });
  expect(result).toMatchObject({ success: true, issue: { title: "Changed" } });
});
test("bad fields and unsupported actions fail before dispatch", async () => {
  let calls = 0;
  const request = (async () => {
    calls++;
    return Response.json({});
  }) as unknown as typeof fetch;
  for (const [action, fields] of [
    ["linear_delete_issue", {}],
    ["linear_get_issue", { issue_id: "https://evil.test" }],
    ["linear_search_issues", { term: "x", limit: 101 }],
    ["linear_search_issues", { term: "x", include_comments: "true" }],
    ["linear_create_issue", { title: "x", team_id: team, priority_id: 5 }],
    [
      "linear_create_issue",
      { title: "x", team_id: team, due_date: "2026-02-30" },
    ],
    ["linear_update_issue", { issue_id: iid, team_id: team }],
    [
      "linear_create_comment",
      { issue_id: iid, team_id: team, body: "x", user_id: iid },
    ],
  ] as const)
    await expect(run(action, { auth, ...fields }, request)).rejects.toThrow();
  expect(calls).toBe(0);
});
test("team mismatch never writes", async () => {
  let calls = 0;
  await expect(
    run(
      "linear_update_issue",
      { auth, team_id: team, issue_id: iid, title: "x" },
      (async () => {
        calls++;
        return Response.json({
          data: {
            issue: {
              ...item,
              team: {
                ...item.team,
                id: "33333333-3333-4333-8333-333333333333",
              },
            },
          },
        });
      }) as unknown as typeof fetch,
    ),
  ).rejects.toThrow("selected team");
  expect(calls).toBe(1);
});
test("GraphQL partial success, errors, malformed and oversized pages are redacted failures", async () => {
  for (const v of [
    { data: { issue: item }, errors: [{ message: "PRIVATE" }] },
    { data: { issue: item }, errors: {} },
    { data: { issue: { ...item, id: team } } },
    { data: { issue: item }, padding: "x".repeat(1048576) },
    {},
  ])
    await expect(
      run("linear_get_issue", { auth, issue_id: iid }, (async () =>
        Response.json(v)) as unknown as typeof fetch),
    ).rejects.not.toThrow("PRIVATE");
  await expect(
    run(
      "linear_search_issues",
      { auth, term: "x" },
      json({
        searchIssues: {
          nodes: [item],
          totalCount: 1,
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      }),
    ),
  ).rejects.toThrow();
});
test("failed or uncertain writes are never retried or leaked", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await expect(
      run(
        "linear_create_issue",
        { auth, team_id: team, title: "x" },
        (async () => {
          calls++;
          return new Response("PRIVATE", { status });
        }) as unknown as typeof fetch,
      ),
    ).rejects.not.toThrow("PRIVATE");
    expect(calls).toBe(1);
  }
  let calls = 0;
  await expect(
    run(
      "linear_create_issue",
      { auth, team_id: team, title: "x" },
      (async () => {
        calls++;
        throw Error("PRIVATE");
      }) as unknown as typeof fetch,
    ),
  ).rejects.toThrow("uncertain");
  expect(calls).toBe(1);
  await expect(
    run(
      "linear_create_issue",
      { auth, team_id: team, title: "x" },
      json({ issueCreate: { success: false, lastSyncId: 1, issue: item } }),
    ),
  ).rejects.toThrow("did not confirm");
});
