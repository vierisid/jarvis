import { expect, test } from "bun:test";
import { readWorkflowPages } from "./pages";
const flow = (n: number) => ({ flowId: `f${n}`, revision: `r${n}` });
/** A server that holds `total` workflows and answers by limit and cursor, as /api/brief/workflows does. */
function server(total: number) {
  const urls: string[] = [];
  const get = async (path: string) => {
    urls.push(path);
    const params = new URL(path, "http://x").searchParams, limit = Number(params.get("limit")), after = params.get("cursor");
    const start = after === null ? 0 : Number(after), rows = Array.from({ length: Math.min(limit, total - start) }, (_, i) => start + i);
    const next = start + rows.length < total ? String(start + rows.length) : null;
    return { state: rows.length ? "ready" : "empty", asOf: 1, data: { scopeId: "s", items: rows.map(flow), removals: [], slots: rows.map(n => ({ flowId: `f${n}`, position: n })), nextCursor: next } };
  };
  return { get, urls };
}
test("a list of 2,500 workflows is read as 13 pages and joined whole, in order", async () => {
  const { get, urls } = server(2500);
  const result = await readWorkflowPages(get);
  expect(urls).toHaveLength(13); expect(urls.every(u => u.includes("limit=200"))).toBe(true);
  expect(result.state).toBe("ready"); expect(result.data!.items).toHaveLength(2500);
  expect((result.data!.items as { flowId: string }[]).map(i => i.flowId)).toEqual(Array.from({ length: 2500 }, (_, i) => `f${i}`));
});
test("an empty list is empty", async () => { expect((await readWorkflowPages(server(0).get)).state).toBe("empty"); });
test("a failed page fails the whole read instead of returning a partial list", async () => {
  const { get } = server(500); let calls = 0;
  await expect(readWorkflowPages(async path => { if (++calls === 2) return { state: "unavailable" }; return get(path); })).rejects.toThrow("unavailable");
});
test("a repeated cursor, a repeated workflow or a changed scope is a failed read", async () => {
  const loop = async () => ({ state: "ready", data: { scopeId: "s", items: [], removals: [], slots: [], nextCursor: "7" } });
  await expect(readWorkflowPages(loop)).rejects.toThrow("repeated a page");
  let n = 0;
  const repeat = async () => ({ state: "ready", data: { scopeId: "s", items: [flow(1)], removals: [], slots: [{ flowId: "f1", position: 1 }], nextCursor: `c${n++}` } });
  await expect(readWorkflowPages(repeat)).rejects.toThrow("repeated a workflow");
  let m = 0;
  const scope = async () => ({ state: "ready", data: { scopeId: `s${m}`, items: [flow(m)], removals: [], slots: [{ flowId: `f${m}`, position: m++ }], nextCursor: `c${m}` } });
  await expect(readWorkflowPages(scope)).rejects.toThrow("changed scope");
});
