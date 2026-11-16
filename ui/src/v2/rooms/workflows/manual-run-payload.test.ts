import { afterEach, expect, test } from "bun:test";
import { askManualRunPayload } from "./manual-run-payload";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const manual = (fields: string[]) => ({ name: "trigger", type: "EMPTY", displayName: "Manual", valid: true,
  settings: { input: Object.fromEntries(fields.map((f) => [f, ""])) } });
function detail(body: unknown, seen: string[] = []): void {
  globalThis.fetch = (async (url: string) => { seen.push(String(url)); return Response.json(body); }) as unknown as typeof fetch;
}

// With no InputHost mounted the prompt answers null at once, which stands in
// for "the person was asked and cancelled" without a DOM.
test("asks for the published version's fields, which is the version the run route starts", async () => {
  const seen: string[] = [];
  detail({ published: { trigger: manual(["customer"]) }, latestDraft: { trigger: manual([]) } }, seen);
  expect(await askManualRunPayload("flow/1")).toBeNull();
  expect(seen).toEqual(["/api/workflows/flow%2F1"]);
});

test("a draft's fields are not asked for while a published version without them runs", async () => {
  detail({ published: { trigger: manual([]) }, latestDraft: { trigger: manual(["customer"]) } });
  expect(await askManualRunPayload("flow-1")).toEqual({});
});

test("falls back to the latest draft when nothing is published", async () => {
  detail({ published: null, latestDraft: { trigger: manual(["customer"]) } });
  expect(await askManualRunPayload("flow-1")).toBeNull();
});

test("an unreadable flow starts as before, with no payload", async () => {
  globalThis.fetch = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
  expect(await askManualRunPayload("flow-1")).toEqual({});
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect(await askManualRunPayload("flow-1")).toEqual({});
});
