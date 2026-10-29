import { expect, test } from "bun:test";
import {
  figmaFileKey,
  runManagedFigmaAction,
  FIGMA_RESPONSE_LIMIT,
  managedFigmaInput,
} from "./managed-figma";
const auth = { access_token: "PRIVATE_ACCESS", jarvis_managed: "figma" };
const file = {
  name: "Design",
  version: "1234567890123456789",
  lastModified: "2026-10-29T12:00:00Z",
  document: { id: "0:0", type: "DOCUMENT", name: "Document", children: [] },
};
const comment = {
  id: "1234567890123456789",
  file_key: "FileKey123",
  message: "Feedback",
  created_at: "2026-10-29T12:00:00Z",
  user: { id: "42", handle: "Designer" },
};
test("file links, node URLs and branch URLs resolve without following user URLs", () => {
  for (const value of [
    "FileKey123",
    " https://www.figma.com/design/FileKey123/Name?node-id=1-2 ",
    "https://figma.com/file/MainKey/branch/FileKey123/Name",
  ])
    expect(figmaFileKey(value)).toBe("FileKey123");
  for (const value of [
    "",
    null,
    "../me",
    "https://evil.test/design/FileKey123/x",
    "http://figma.com/file/FileKey123",
    "https://figma.com:444/file/FileKey123",
    "https://owner@figma.com/file/FileKey123",
    "https://figma.com/file/a%2Fb/x",
    "https://figma.com/oauth/FileKey123",
  ])
    expect(() => figmaFileKey(value)).toThrow();
});
test("three fixed endpoints preserve upstream wrappers, full document and comment identity", async () => {
  const calls: any[] = [];
  const request = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(
      url.endsWith("/comments")
        ? init.method === "POST"
          ? comment
          : { comments: [comment] }
        : file,
    );
  }) as unknown as typeof fetch;
  expect(
    await runManagedFigmaAction(
      "get_file",
      { auth, file_key: "https://www.figma.com/design/FileKey123/Name" },
      request,
    ),
  ).toEqual({ success: true, response_body: file });
  expect(
    await runManagedFigmaAction(
      "get_comments",
      { auth, file_key: "FileKey123" },
      request,
    ),
  ).toEqual({ success: true, response_body: { comments: [comment] } });
  expect(
    await runManagedFigmaAction(
      "post_comment",
      { auth, file_key: "FileKey123", message: "Feedback" },
      request,
    ),
  ).toEqual({
    success: true,
    request_body: { message: "Feedback" },
    response_body: comment,
  });
  expect(calls.map((c) => [c.init.method, c.url])).toEqual([
    ["GET", "https://api.figma.com/v1/files/FileKey123"],
    ["GET", "https://api.figma.com/v1/files/FileKey123/comments"],
    ["POST", "https://api.figma.com/v1/files/FileKey123/comments"],
  ]);
  expect(
    calls.every(
      (c) =>
        c.init.redirect === "error" &&
        new Headers(c.init.headers).get("authorization") ===
          "Bearer PRIVATE_ACCESS",
    ),
  ).toBe(true);
  expect(JSON.parse(calls[2].init.body)).toEqual({ message: "Feedback" });
  expect(managedFigmaInput("@activepieces/piece-figma", { auth })).toBe(true);
  expect(managedFigmaInput("@activepieces/piece-http", { auth })).toBe(false);
});
test("invalid inputs, unknown operations and foreign comment responses are refused", async () => {
  const noCall = (async () => {
    throw Error("UNEXPECTED_CALL");
  }) as unknown as typeof fetch;
  for (const [action, input] of [
    ["post_comment", { message: " " }],
    ["post_comment", { message: "x".repeat(10001) }],
    ["custom_api_call", {}],
    ["get_file", { file_key: "../me" }],
  ] as const)
    await expect(
      runManagedFigmaAction(
        action,
        { auth, file_key: "FileKey123", ...input },
        noCall,
      ),
    ).rejects.not.toThrow("UNEXPECTED_CALL");
  for (const result of [
    { ...comment, file_key: "OtherFile" },
    { ...comment, id: 1234 },
    { ...comment, message: "Changed" },
    { error: "PRIVATE_ACCESS" },
  ])
    await expect(
      runManagedFigmaAction(
        "post_comment",
        { auth, file_key: "FileKey123", message: "Feedback" },
        (async () => Response.json(result)) as unknown as typeof fetch,
      ),
    ).rejects.toThrow("invalid or oversized");
});
test("failed/uncertain writes never retry or leak provider errors", async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    let calls = 0;
    const request = (async () => {
      calls++;
      return Response.json({ error: "PRIVATE_ACCESS SECRET" }, { status });
    }) as unknown as typeof fetch;
    try {
      await runManagedFigmaAction(
        "post_comment",
        { auth, file_key: "FileKey123", message: "Feedback" },
        request,
      );
      throw Error("expected failure");
    } catch (error) {
      expect(String(error)).not.toMatch(/PRIVATE_ACCESS|SECRET/);
      if (status >= 500)
        expect(String(error)).toContain("may already have been posted");
    }
    expect(calls).toBe(1);
  }
  await expect(
    runManagedFigmaAction(
      "post_comment",
      { auth, file_key: "FileKey123", message: "Feedback" },
      (async () => {
        throw Error("PRIVATE_ACCESS");
      }) as unknown as typeof fetch,
    ),
  ).rejects.toThrow("may already have been posted");
});
test("large or malformed reads fail explicitly; empty comments remain valid", async () => {
  for (const value of [
    { ...file, document: {} },
    { ...file, version: 1234 },
    { ...file, padding: "x".repeat(FIGMA_RESPONSE_LIMIT) },
  ])
    await expect(
      runManagedFigmaAction(
        "get_file",
        { auth, file_key: "FileKey123" },
        (async () => Response.json(value)) as unknown as typeof fetch,
      ),
    ).rejects.toThrow("invalid or oversized");
  expect(
    await runManagedFigmaAction(
      "get_comments",
      { auth, file_key: "FileKey123" },
      (async () => Response.json({ comments: [] })) as unknown as typeof fetch,
    ),
  ).toEqual({ success: true, response_body: { comments: [] } });
});
