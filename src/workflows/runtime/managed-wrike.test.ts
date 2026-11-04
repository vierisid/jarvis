import { expect, test } from "bun:test";
import {
  runManagedWrikeAction,
  managedWrikeInput,
  wrikeFolderPage,
} from "./managed-wrike";
import {
  wrikeInputSchema,
  wrikeEngineProps,
  isWrikeReference,
} from "./managed-wrike-inputs";
import {
  resolveGovernedPieceAction,
  tracksPieceCompletion,
  wrikeTaskCategory,
} from "./piece-effects";
const piece = "@activepieces/piece-wrike";
const auth = {
  jarvis_managed: "wrike",
  access_token: "PRIVATE",
  api_host: "app-eu.wrike.com",
};
const task = { kind: "tasks", data: [{ id: "TASK1", title: "Example" }] };
function fixture(body: unknown = task, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const request = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json(body, { status });
  }) as typeof fetch;
  return { calls, request };
}
test("folder search uses the regional folder endpoint, bounded page and cursor", async () => {
  const f = fixture({ ...task, nextPageToken: "NEXT" });
  expect(
    await runManagedWrikeAction(
      "find_task",
      {
        auth,
        folderId: "FOLDER1",
        title: "Example",
        status: "Active",
        nextPageToken: "PREV",
      },
      f.request,
    ),
  ).toEqual({ ...task, nextPageToken: "NEXT" });
  const url = new URL(f.calls[0]!.url);
  expect(url.origin + url.pathname).toBe(
    "https://app-eu.wrike.com/api/v4/folders/FOLDER1/tasks",
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    title: "Example",
    status: '["Active"]',
    pageSize: "100",
    nextPageToken: "PREV",
  });
  expect(f.calls[0]!.init?.redirect).toBe("error");
});
test.each(["www.wrike.com", "app-us2.wrike.com", "app-eu.wrike.com"])(
  "task read stays on grant region %s",
  async (host) => {
    const f = fixture();
    await runManagedWrikeAction(
      "find_task",
      { auth: { ...auth, api_host: host }, taskId: "TASK1" },
      f.request,
    );
    expect(f.calls[0]!.url).toBe("https://" + host + "/api/v4/tasks/TASK1");
  },
);
test.each(["create_task", "update_task"])(
  "%s sends one form-encoded write",
  async (action) => {
    const f = fixture();
    await runManagedWrikeAction(
      action,
      {
        auth,
        ...(action === "create_task"
          ? { folderId: "FOLDER1" }
          : { taskId: "TASK1" }),
        title: "A & B",
        description: "Line 1\nLine 2",
        status: "Completed",
        importance: "High",
      },
      f.request,
    );
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.init?.method).toBe(
      action === "create_task" ? "POST" : "PUT",
    );
    expect(
      Object.fromEntries(new URLSearchParams(String(f.calls[0]!.init?.body))),
    ).toEqual({
      title: "A & B",
      description: "Line 1\nLine 2",
      status: "Completed",
      importance: "High",
    });
  },
);
test.each(["tasks", "folders"])(
  "comment on %s is plain text and governed as sending",
  async (entityType) => {
    const f = fixture({
      kind: "comments",
      data: [{ id: "COMMENT1", text: "<b>hi</b>" }],
    });
    await runManagedWrikeAction(
      "add_comment",
      { auth, entityType, entityId: "ENTITY1", text: "<b>hi</b>" },
      f.request,
    );
    expect(f.calls[0]!.url).toEndWith("/" + entityType + "/ENTITY1/comments");
    expect(
      new URLSearchParams(String(f.calls[0]!.init?.body)).get("plainText"),
    ).toBe("true");
    expect(resolveGovernedPieceAction(piece, "add_comment")?.category).toBe(
      "send_message",
    );
    expect(tracksPieceCompletion(piece, "add_comment")).toBe(true);
  },
);
test.each([
  ["find_task", { taskId: "https://evil.test" }],
  ["find_task", { taskId: "TASK1", title: "ignored" }],
  ["find_task", { pageSize: 101 }],
  ["find_task", { pageSize: 0 }],
  ["find_task", { importance: "Critical" }],
  ["find_task", { sortField: "StartDate" }],
  ["update_task", { taskId: "TASK1" }],
  ["create_task", { folderId: "FOLDER1", title: "" }],
  [
    "create_task",
    { folderId: "FOLDER1", title: "x", assignees: [{ userId: "U" }] },
  ],
  ["add_comment", { entityType: "users", entityId: "U", text: "x" }],
  ["custom_api_call", {}],
  ["new_task", {}],
])("invalid or unsupported %s input never sends", async (action, input) => {
  const f = fixture();
  await expect(
    runManagedWrikeAction(String(action), { auth, ...input }, f.request),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
test.each([
  "evil.test",
  "www.wrike.com.evil.test",
  "www.wrike.com:443",
  "https://www.wrike.com",
  "127.0.0.1",
])("reject host %s before exposing token", async (api_host) => {
  const f = fixture();
  await expect(
    runManagedWrikeAction(
      "find_task",
      { auth: { ...auth, api_host }, taskId: "TASK1" },
      f.request,
    ),
  ).rejects.toThrow("Reconnect");
  expect(f.calls).toHaveLength(0);
});
test.each([401, 403, 429, 500])(
  "HTTP %s does not echo provider body or retry",
  async (status) => {
    const f = fixture({ error: "PRIVATE" }, status);
    const error = await runManagedWrikeAction(
      "update_task",
      { auth, taskId: "TASK1", title: "x" },
      f.request,
    ).then(
      () => null,
      (error) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("PRIVATE");
    expect(f.calls).toHaveLength(1);
  },
);
test("ambiguous write is not retried", async () => {
  let calls = 0;
  const request = (async () => {
    calls++;
    throw Error("PRIVATE");
  }) as unknown as typeof fetch;
  await expect(
    runManagedWrikeAction(
      "create_task",
      { auth, folderId: "FOLDER1", title: "x" },
      request,
    ),
  ).rejects.toThrow("uncertain");
  expect(calls).toBe(1);
});
test.each([
  { kind: "tasks", data: [{ id: "OTHER", title: "x" }] },
  { kind: "accounts", data: [] },
  { error: "PRIVATE" },
  { kind: "tasks", data: [] },
])("invalid response is rejected", async (body) => {
  await expect(
    runManagedWrikeAction(
      "find_task",
      { auth, taskId: "TASK1" },
      fixture(body).request,
    ),
  ).rejects.toThrow("invalid response");
});
test("input contract is scoped to managed credentials", () => {
  expect(managedWrikeInput({ auth })).toEqual({ auth });
  expect(managedWrikeInput({ auth: { access_token: "x" } })).toBeNull();
  expect(isWrikeReference(piece, "{{connections.jarvis:wrike}}")).toBe(true);
  expect(
    wrikeEngineProps(piece, "create_task", { auth })?.folderId.required,
  ).toBe(true);
  expect(
    wrikeEngineProps(piece, "create_task", { auth: { access_token: "x" } }),
  ).toBeNull();
  expect(
    wrikeInputSchema("create_task")!.fields.map((f) => f.name),
  ).not.toContain("assignees");
  expect(
    wrikeInputSchema("add_comment")!.fields.find((f) => f.name === "text")
      ?.required,
  ).toBe(true);
});

test("folder picker searches descendants and pages without losing the account region", async () => {
  const f = fixture({
    kind: "folders",
    data: [{ id: "FOLDER1", title: "Sandbox" }],
    nextPageToken: "MORE",
  });
  expect(await wrikeFolderPage(auth, "Sand", "PREV", f.request)).toEqual({
    options: [{ value: "FOLDER1", label: "Sandbox (FOLDER1)" }],
    next_cursor: "MORE",
  });
  const url = new URL(f.calls[0]!.url);
  expect(url.origin + url.pathname).toBe(
    "https://app-eu.wrike.com/api/v4/folders",
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    title: "Sand",
    descendants: "true",
    deleted: "false",
    pageSize: "100",
    nextPageToken: "PREV",
  });
});

test("explicit comment formatting is preserved instead of ignored", async () => {
  const f = fixture({
    kind: "comments",
    data: [{ id: "C", text: "<b>hello</b>" }],
  });
  await runManagedWrikeAction(
    "add_comment",
    {
      auth,
      entityType: "tasks",
      entityId: "TASK1",
      text: "<b>hello</b>",
      plainText: false,
    },
    f.request,
  );
  expect(
    new URLSearchParams(String(f.calls[0]!.init?.body)).get("plainText"),
  ).toBe("false");
});
test("task lookup accepts the editor's upstream default page size", async () => {
  const f = fixture();
  await runManagedWrikeAction(
    "find_task",
    { auth, taskId: "TASK1", pageSize: 100 },
    f.request,
  );
  expect(f.calls[0]!.url).toBe("https://app-eu.wrike.com/api/v4/tasks/TASK1");
});

test("manual task assignments receive the access-change category", () => {
  expect(wrikeTaskCategory({ assignees: [{ userId: "USER1" }] })).toBe(
    "modify_settings",
  );
  expect(wrikeTaskCategory({ assignees: "{{users}}" })).toBe("modify_settings");
  expect(wrikeTaskCategory({ assignees: [] })).toBe("write_data");
  expect(wrikeTaskCategory({ title: "Task" })).toBe("write_data");
});

test.each(["create_task", "update_task"])("%s takes the access-change category without a complete input", (action) => {
  expect(resolveGovernedPieceAction(piece, action)?.category).toBe("modify_settings");
  expect(resolveGovernedPieceAction(piece, action, { omittedFields: 1 })?.category).toBe("modify_settings");
  expect(resolveGovernedPieceAction(piece, action, { title: "Task" })?.category).toBe("write_data");
  expect(resolveGovernedPieceAction(piece, action, { assignees: [{ userId: "USER1" }] })?.category).toBe("modify_settings");
});
