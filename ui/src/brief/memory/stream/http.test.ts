import { test, expect } from "bun:test";
import { memoryHttpPort } from "./http";
import { memoryRows } from "./fixtures";
const page = () => ({
  state: "ready",
  asOf: 123,
  data: {
    items: [memoryRows()[0]],
    count: { total: 1, matched: 1, returned: 1 },
    nextCursor: null,
    usedIn: { state: "ready" },
  },
});
const request = (response: Response) =>
  (async () => response) as unknown as typeof fetch;
test("GET uses authenticated no-store query, preserves opaque cursor and exact source", async () => {
  const calls: [unknown, RequestInit | undefined][] = [];
  const port = memoryHttpPort("scope", (async (url, init) => {
    calls.push([url, init]);
    return Response.json(page());
  }) as typeof fetch);
  const signal = new AbortController().signal;
  expect(
    (
      await port.read(
        {
          limit: 50,
          source: " \tA&B\n",
          usedIn: "run:run 1",
          q: "%_*",
          cursor: "a+b/c=",
          updatedFrom: 1,
          updatedBefore: 2,
        },
        signal,
      )
    ).state,
  ).toBe("ready");
  const [url, init] = calls[0]!;
  expect(String(url).startsWith("/api/brief/memory?")).toBe(true);
  expect(
    new URL(String(url), "http://fixture").searchParams.get("source"),
  ).toBe(" \tA&B\n");
  expect(
    new URL(String(url), "http://fixture").searchParams.get("cursor"),
  ).toBe("a+b/c=");
  expect(init).toMatchObject({
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
});
for (const [status, state] of [
  [401, "unavailable"],
  [403, "unavailable"],
  [404, "unsupported"],
  [501, "unsupported"],
  [409, "stale"],
  [503, "unavailable"],
  [500, "error"],
  [400, "error"],
] as const)
  test(`HTTP ${status} becomes ${state} without exposing error body or old content`, async () => {
    const read = await memoryHttpPort(
      "scope",
      request(new Response("private server trace", { status })),
    ).read({ limit: 50 }, new AbortController().signal);
    expect(read.state).toBe(state);
    expect("data" in read).toBe(false);
    expect(JSON.stringify(read)).not.toContain("private");
  });
for (const broken of [
  "permission",
  "count",
  "duplicate",
  "empty",
  "limit",
  "scope",
  "basis",
  "uses",
] as const)
  test(`rejects malformed ${broken} response`, async () => {
    const body = page();
    const row = body.data.items[0]!;
    if (broken === "permission") row.permissions.canRead = false;
    if (broken === "count") body.data.count.returned = 2;
    if (broken === "duplicate") {
      body.data.items.push(row);
      body.data.count = { total: 2, matched: 2, returned: 2 };
    }
    if (broken === "empty") body.state = "empty";
    if (broken === "limit") body.data.items = Array(101).fill(row);
    if (broken === "scope") delete (row as any).scope;
    if (broken === "basis") (row as any).basis = "verified outcome";
    if (broken === "uses") row.uses![0]!.factId = "another-fact";
    const read = await memoryHttpPort(
      "scope",
      request(Response.json(body)),
    ).read({ limit: 50 }, new AbortController().signal);
    expect(read.state).toBe("error");
  });
test("does not convert thrown network errors to empty", async () => {
  const port = memoryHttpPort("scope", (async () => {
    throw Error("offline");
  }) as unknown as typeof fetch);
  expect(
    port.read({ limit: 50 }, new AbortController().signal),
  ).rejects.toThrow("offline");
});
