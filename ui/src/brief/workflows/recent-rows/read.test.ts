import { expect, test } from "bun:test";
import { readRecentWorkflows } from "./read";
const run = (over: Record<string, unknown> = {}) => ({ id: "run-a", flowId: "a", flowVersionId: "v-a", status: "FAILED", environment: "PRODUCTION", startTime: 42, created: 40, displayName: "Brief", ...over });
test("one request reads the recent runs and names; captured output is never forwarded", async () => {
  const urls: string[] = [];
  const state = await readRecentWorkflows(async url => { urls.push(url); return Response.json({ items: [run({ steps: { out: { secret: "SECRET-OUTPUT" } } })] }); });
  expect(urls).toEqual(["/api/workflows/recent-runs?limit=6"]);
  expect(state).toMatchObject({ status: "ready", data: [{ flowId: "a", versionId: "v-a", runId: "run-a", name: "Brief", status: "FAILED", result: "Run failed", at: 42 }] });
  expect(JSON.stringify(state)).not.toContain("SECRET-OUTPUT");
});
test("the request count does not grow with the number of workflows", async () => {
  let calls = 0;
  const items = Array.from({ length: 6 }, (_, i) => run({ id: `r${i}`, flowId: `f${i}`, startTime: 100 - i, displayName: `Flow ${i}` }));
  const state = await readRecentWorkflows(async () => { calls++; return Response.json({ items }); });
  expect(calls).toBe(1);
  expect(state).toMatchObject({ status: "ready" });
  expect((state as unknown as { data: { name: string }[] }).data.map(r => r.name)).toEqual(["Flow 0", "Flow 1", "Flow 2", "Flow 3", "Flow 4", "Flow 5"]);
});
test("a failed read is unavailable, not an empty list", async () => {
  expect(await readRecentWorkflows(async () => Response.json({}, { status: 503 }))).toMatchObject({ status: "unavailable" });
  expect(await readRecentWorkflows(async () => { throw new Error("offline"); })).toMatchObject({ status: "unavailable" });
});
test("no runs yet is empty", async () => {
  expect(await readRecentWorkflows(async () => Response.json({ items: [] }))).toEqual({ status: "empty" });
});
test("a malformed row is skipped and disclosed; a bare array is not read as a page", async () => {
  const state = await readRecentWorkflows(async () => Response.json({ items: [run(), run({ id: "", flowId: "b" }), run({ id: "r3", flowId: "c", environment: "STAGING" })] }));
  expect(state).toMatchObject({ status: "stale", data: [{ flowId: "a" }] });
  expect(await readRecentWorkflows(async () => Response.json([run()]))).toMatchObject({ status: "unavailable" });
  expect(await readRecentWorkflows(async () => Response.json({ items: [run({ id: "x", flowId: "y", environment: "NOPE" })] }))).toMatchObject({ status: "unavailable" });
});
