import { expect, test } from "bun:test";
import {
  MANAGED_TODOIST_ACTIONS,
  runManagedTodoistAction,
  todoistRequest,
} from "./managed-todoist";
import {
  resolveGovernedPieceAction,
  tracksPieceCompletion,
} from "./piece-effects";
const auth = { access_token: "TEST_ONLY", jarvis_managed: "todoist" };
const task = (extra: Record<string, unknown> = {}) => ({
  id: "task1",
  content: "Test task",
  description: "Details",
  project_id: "project1",
  section_id: null,
  parent_id: null,
  labels: [],
  priority: 1,
  checked: false,
  due: null,
  ...extra,
});
function mock(fn: (path: string, body: any) => unknown | Response) {
  const calls: Array<{ path: string; body: any; method: string }> = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    expect(u.origin).toBe("https://api.todoist.com");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer TEST_ONLY",
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      path: u.pathname + u.search,
      body,
      method: init?.method ?? "GET",
    });
    const result = fn(u.pathname + u.search, body);
    return result instanceof Response ? result : Response.json(result);
  }) as typeof fetch;
  return { calls, request };
}
test("four actions have read/write governance and write completion receipts", () => {
  expect(MANAGED_TODOIST_ACTIONS).toHaveLength(4);
  for (const action of MANAGED_TODOIST_ACTIONS) {
    expect(
      resolveGovernedPieceAction("@activepieces/piece-todoist", action)
        ?.category,
    ).toBe(action === "find_task" ? "read_data" : "write_data");
    expect(tracksPieceCompletion("@activepieces/piece-todoist", action)).toBe(
      action !== "find_task",
    );
  }
  expect(
    resolveGovernedPieceAction(
      "@activepieces/piece-todoist",
      "todoist_delete_task",
    )?.category,
  ).toBe("modify_settings");
});
test("find follows bounded cursor pages and matches the exact title", async () => {
  const m = mock((path) =>
    path.includes("cursor=")
      ? { results: [task()], next_cursor: null }
      : { results: [], next_cursor: "a+/=" },
  );
  expect(
    await runManagedTodoistAction(
      "find_task",
      { auth, name: "Test task", project_id: "project1" },
      m.request,
    ),
  ).toMatchObject({ id: "task1" });
  expect(m.calls).toHaveLength(2);
  expect(
    new URL("https://api.todoist.com" + m.calls[1]!.path).searchParams.get(
      "cursor",
    ),
  ).toBe("a+/=");
});
test("find refuses missing, ambiguous, repeated, malformed and incomplete pages", async () => {
  for (const response of [
    { results: [], next_cursor: null },
    { results: [task(), task({ id: "task2" })], next_cursor: null },
    { results: [task({ project_id: "other" })], next_cursor: null },
    { results: [task()], next_cursor: 12 },
  ]) {
    const m = mock(() => response);
    await expect(
      runManagedTodoistAction(
        "find_task",
        { auth, name: "Test task", project_id: "project1" },
        m.request,
      ),
    ).rejects.toThrow();
  }
  const repeated = mock(() => ({ results: [], next_cursor: "same" }));
  await expect(
    runManagedTodoistAction("find_task", { auth, name: "x" }, repeated.request),
  ).rejects.toThrow("repeated");
  expect(repeated.calls).toHaveLength(2);
  let page = 0;
  const endless = mock(() => ({ results: [], next_cursor: String(++page) }));
  await expect(
    runManagedTodoistAction("find_task", { auth, name: "x" }, endless.request),
  ).rejects.toThrow("500");
  expect(endless.calls).toHaveLength(5);
});
test("create uses explicit fields and verifies a section's project before writing", async () => {
  const m = mock((path, body) =>
    path.includes("sections/")
      ? { id: "section1", project_id: "project1" }
      : task({ ...body, section_id: "section1" }),
  );
  await runManagedTodoistAction(
    "create_task",
    {
      auth,
      content: "New task",
      project_id: "project1",
      section_id: "section1",
      priority: 4,
      labels: ["work"],
      due_date: "2026-10-30",
    },
    m.request,
  );
  expect(m.calls[1]!.body).toEqual({
    content: "New task",
    project_id: "project1",
    section_id: "section1",
    priority: 4,
    labels: ["work"],
    due_date: "2026-10-30",
  });
  const wrong = mock(() => ({ id: "section1", project_id: "other" }));
  await expect(
    runManagedTodoistAction(
      "create_task",
      { auth, content: "x", project_id: "project1", section_id: "section1" },
      wrong.request,
    ),
  ).rejects.toThrow("section");
  expect(wrong.calls).toHaveLength(1);
});
test("create defaults to Inbox; update preserves empty fields and uses verified ID", async () => {
  const m = mock((path, body) => task(body ?? {}));
  await runManagedTodoistAction(
    "create_task",
    { auth, content: "Inbox task" },
    m.request,
  );
  expect(m.calls[0]!.body).toEqual({ content: "Inbox task" });
  m.calls.length = 0;
  await runManagedTodoistAction(
    "update_task",
    { auth, task_id: "task1", content: "Renamed", description: "", labels: [] },
    m.request,
  );
  expect(m.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  expect(m.calls[1]!.body).toEqual({ content: "Renamed" });
  const wrong = mock(() => task({ id: "other" }));
  await expect(
    runManagedTodoistAction(
      "update_task",
      { auth, task_id: "task1", content: "x" },
      wrong.request,
    ),
  ).rejects.toThrow("requested");
  expect(wrong.calls).toHaveLength(1);
});
test("date-only, timezone-aware and natural dates remain distinct", async () => {
  for (const [due_date, key] of [
    ["2026-10-30", "due_date"],
    ["2026-10-30T15:00:00+02:00", "due_datetime"],
    ["every Monday", "due_string"],
  ]) {
    const m = mock(() => task());
    await runManagedTodoistAction(
      "create_task",
      { auth, content: "x", due_date },
      m.request,
    );
    expect(m.calls[0]!.body[key!]).toBe(due_date);
  }
});
test("completion distinguishes a recurring occurrence and never retries a mutation", async () => {
  for (const recurring of [false, true]) {
    const m = mock((path) =>
      path.endsWith("/close")
        ? new Response(null, { status: 204 })
        : task({
            due: recurring
              ? { date: "2026-10-30", string: "every day", is_recurring: true }
              : null,
          }),
    );
    expect(
      await runManagedTodoistAction(
        "mark_task_completed",
        { auth, task_id: "task1" },
        m.request,
      ),
    ).toEqual({
      success: true,
      task_id: "task1",
      completed: !recurring,
      recurrence_advanced: recurring,
    });
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  }
  let writes = 0;
  const m = mock((path) => {
    if (path.endsWith("/close")) {
      writes++;
      throw Error("Authorization: secret");
    }
    return task();
  });
  await expect(
    runManagedTodoistAction(
      "mark_task_completed",
      { auth, task_id: "task1" },
      m.request,
    ),
  ).rejects.toThrow("uncertain");
  expect(writes).toBe(1);
});
test("invalid inputs fail before network activity", async () => {
  const m = mock(() => {
    throw Error("should not call");
  });
  const cases: Array<[string, Record<string, unknown>]> = [
    ["create_task", { content: "" }],
    ["update_task", { task_id: "task1", description: "", labels: [] }],
    ["update_task", { task_id: "../other", content: "x" }],
    ["create_task", { content: "x", priority: 0 }],
    ["create_task", { content: "x", labels: "work" }],
    ["create_task", { content: "x", section_id: "s1" }],
    ["create_task", { content: "x", due_date: "2026-02-30" }],
    ["create_task", { content: "x", due_date: "2026-10-30T15:00:00" }],
    ["custom_api_call", { url: "https://evil.test" }],
    ["todoist_delete_task", { task_id: "task1" }],
  ];
  for (const [action, input] of cases)
    await expect(
      runManagedTodoistAction(action, { auth, ...input }, m.request),
    ).rejects.toThrow();
  expect(m.calls).toHaveLength(0);
});
test("provider failures and oversized replies are redacted", async () => {
  for (const status of [401, 403, 429, 500]) {
    const m = mock(() =>
      Response.json({ error: "private-provider-body" }, { status }),
    );
    try {
      await runManagedTodoistAction(
        "find_task",
        { auth, name: "x" },
        m.request,
      );
      throw Error("expected failure");
    } catch (e) {
      expect(String(e)).not.toContain("private-provider-body");
      expect(String(e)).not.toContain("TEST_ONLY");
    }
  }
  const m = mock(() => new Response("x".repeat(1048577)));
  await expect(
    todoistRequest("TEST_ONLY", "/tasks", m.request),
  ).rejects.toThrow("invalid response");
});
