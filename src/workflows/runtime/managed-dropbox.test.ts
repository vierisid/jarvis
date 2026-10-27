import { expect, test } from "bun:test";
import { runManagedDropboxAction } from "./managed-dropbox";
import {
  tracksPieceCompletion,
  resolveGovernedPieceAction,
} from "./piece-effects";
const auth = {
  access_token: "TOKEN",
  home_namespace_id: "123",
  jarvis_managed: "dropbox",
};
test("folder creation makes one request with a fixed host, no redirects and a home root", async () => {
  let calls = 0;
  const request = (async (url: string, init: RequestInit) => {
    calls++;
    expect(url).toBe("https://api.dropboxapi.com/2/files/create_folder_v2");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("Dropbox-API-Path-Root")).toBe(
      '{".tag":"home"}',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      path: "/Example",
      autorename: false,
    });
    return Response.json({
      metadata: { ".tag": "folder", id: "id:1", name: "Example" },
    });
  }) as unknown as typeof fetch;
  expect(
    await runManagedDropboxAction(
      "create_new_dropbox_folder",
      { auth, path: "/Example" },
      request,
    ),
  ).toHaveProperty("metadata");
  expect(calls).toBe(1);
  expect(
    tracksPieceCompletion(
      "@activepieces/piece-dropbox",
      "create_new_dropbox_folder",
    ),
  ).toBe(true);
  expect(
    resolveGovernedPieceAction("@activepieces/piece-dropbox", "search_dropbox")
      ?.category,
  ).toBe("read_data");
});
test("unsupported operations, invalid paths and filters are rejected before transport", async () => {
  const request = (async () => {
    throw new Error("transport reached");
  }) as unknown as typeof fetch;
  for (const [action, input] of [
    ["custom_api_call", {}],
    ["delete_dropbox_file", {}],
    ["create_new_dropbox_folder", { path: "https://evil.test" }],
    ["search_dropbox", { query: "a" }],
    ["search_dropbox", { query: "abc", file_status: "deleted" }],
  ] as const)
    await expect(
      runManagedDropboxAction(action, { auth, ...input }, request),
    ).rejects.not.toThrow("transport reached");
});
test("provider errors never echo credentials and writes are never retried", async () => {
  let calls = 0;
  await expect(
    runManagedDropboxAction(
      "create_new_dropbox_folder",
      { auth, path: "/Example" },
      (async () => {
        calls++;
        return Response.json({ echo: "TOKEN" }, { status: 503 });
      }) as unknown as typeof fetch,
    ),
  ).rejects.toThrow("did not confirm");
  expect(calls).toBe(1);
});

test("search forwards sorting and normalizes the home root without widening file-name search", async () => {
  const request = (async (_url: string, init: RequestInit) => {
    expect(JSON.parse(String(init.body))).toEqual({
      query: "Example",
      options: {
        path: "",
        max_results: 100,
        filename_only: true,
        file_status: "active",
        order_by: "modified_time",
      },
    });
    return Response.json({ matches: [], has_more: true, cursor: "next" });
  }) as unknown as typeof fetch;
  expect(
    await runManagedDropboxAction(
      "search_dropbox",
      { auth, query: "Example", path: "/", order_by: "modified_time" },
      request,
    ),
  ).toEqual({ matches: [], has_more: true, cursor: "next" });
});
