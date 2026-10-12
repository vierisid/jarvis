import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, closeDb } from "../../../../../src/vault/schema";
import { createEntity } from "../../../../../src/vault/entities";
import { createFact, getFact, queryFact } from "../../../../../src/vault/facts";
import { createFactDecisionRoutes } from "../../../../../src/vault/fact-routes";
import { memoryDetailHttpPort } from "./http";
import { fixtureDetail, makeMemoryDetailFixture } from "./fixtures";
import { memoryRows } from "../stream/fixtures";
import { MemoryDetailController } from "./controller";
import type { MemoryItem } from "../stream/model";
const signal = () => new AbortController().signal;
const id = "fixture-memory-0";
const response = (body: unknown, status = 200) =>
  Response.json(body, { status });
const mock = (
  fn: (url: string, init: RequestInit) => Response | Promise<Response>,
) => fn as unknown as typeof fetch;
const detail = fixtureDetail(memoryRows()[0]!);
test("detail reads are authenticated/no-store and never follow server-supplied URLs", async () => {
  const calls: string[] = [];
  const port = memoryDetailHttpPort(
    "scope",
    mock((url, init) => {
      calls.push(url);
      expect(init.credentials).toBe("same-origin");
      expect(init.cache).toBe("no-store");
      expect(init.signal).toBeTruthy();
      return response(
        url.startsWith("/api/vault")
          ? detail.fact
          : {
              state: "ready",
              data: {
                ...detail.item,
                detailHref: "https://evil.invalid",
                historyHref: "https://evil.invalid",
              },
            },
      );
    }),
  );
  expect((await port.read(id, signal())).state).toBe("ready");
  expect(calls).toEqual([
    `/api/brief/memory/${id}`,
    `/api/vault/facts/${id}`,
    `/api/brief/memory/${id}`,
  ]);
  expect((await port.read("../private", signal())).state).toBe("error");
  expect(calls).toHaveLength(3);
});
for (const [status, state] of [
  [401, "unavailable"],
  [403, "unavailable"],
  [404, "missing"],
  [410, "forgotten"],
  [409, "conflict"],
  [501, "unsupported"],
  [503, "unavailable"],
] as const)
  test(`detail HTTP ${status} is ${state}, never fixture data`, async () => {
    const port = memoryDetailHttpPort(
      "scope",
      mock(() => response({}, status)),
    );
    expect((await port.read(id, signal())).state).toBe(state);
  });
test("a changing projection or mismatched canonical identity fails closed", async () => {
  let reads = 0;
  const changing = memoryDetailHttpPort(
    "scope",
    mock((url) =>
      response(
        url.startsWith("/api/vault")
          ? detail.fact
          : {
              state: "ready",
              data: { ...detail.item, revision: String(++reads) },
            },
      ),
    ),
  );
  expect((await changing.read(id, signal())).state).toBe("conflict");
  const mismatched = memoryDetailHttpPort(
    "scope",
    mock((url) =>
      response(
        url.startsWith("/api/vault")
          ? { ...detail.fact, scope: "another scope" }
          : { state: "ready", data: detail.item },
      ),
    ),
  );
  expect((await mismatched.read(id, signal())).state).toBe("error");
});
test("invalid or oversized history is rejected as a whole", async () => {
  for (const data of [
    Array(101).fill(detail.item),
    [{ ...detail.item, factId: "different" }],
    [{ ...detail.item, permissions: { canRead: false } }],
  ]) {
    const port = memoryDetailHttpPort(
      "scope",
      mock(() => response({ state: "ready", data })),
    );
    expect((await port.history(id, signal())).state).toBe("error");
  }
});
test("server canCorrect=false prevents using the existing legacy writer", async () => {
  let posts = 0;
  const port = memoryDetailHttpPort(
    "scope",
    mock((url, init) => {
      if (init.method === "POST") posts++;
      return response(
        url.startsWith("/api/vault")
          ? detail.fact
          : {
              state: "ready",
              data: {
                ...detail.item,
                permissions: { ...detail.item.permissions, canCorrect: false },
              },
            },
      );
    }),
  );
  expect(
    (
      await port.decide(
        {
          kind: "correct",
          factId: id,
          revision: detail.item.revision,
          object: "New",
          reason: "Checked",
        },
        signal(),
      )
    ).state,
  ).toBe("unavailable");
  expect(posts).toBe(0);
});
test("a stale edit revision stops before POST", async () => {
  let posts = 0;
  const port = memoryDetailHttpPort(
    "scope",
    mock((url, init) => {
      if (init.method === "POST") posts++;
      return response(
        url.startsWith("/api/vault")
          ? detail.fact
          : { state: "ready", data: detail.item },
      );
    }),
  );
  expect(
    (
      await port.decide(
        {
          kind: "confirm",
          factId: id,
          revision: "old",
          object: detail.fact.object,
          reason: "Checked",
        },
        signal(),
      )
    ).state,
  ).toBe("conflict");
  expect(posts).toBe(0);
});
test("Forget sends F19's exact prepared digest and explicit confirmation; request is not auto-retried", async () => {
  const fixture = makeMemoryDetailFixture();
  const prepared = await fixture.port.prepareForget(id, signal());
  if (prepared.state !== "ready") throw new Error("fixture prepare");
  let posts = 0;
  const port = memoryDetailHttpPort(
    "scope",
    mock(async (url, init) => {
      expect(url).toBe(`/api/brief/memory/${id}/forget`);
      if (init.method === "GET") return response(prepared);
      posts++;
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        requestId: "test-request",
        expectedRevision: prepared.revision,
        confirmed: true,
      });
      expect(init.cache).toBe("no-store");
      return response(await fixture.port.forget(id, body, signal()));
    }),
  );
  const p = await port.prepareForget(id, signal());
  expect(p.state).toBe("ready");
  expect(
    (
      await port.forget(
        id,
        {
          requestId: "test-request",
          expectedRevision: prepared.revision,
          confirmed: true,
        },
        signal(),
      )
    ).state,
  ).toBe("forgotten");
  expect(posts).toBe(1);
});
test("Forget revision conflict and ambiguous failure stay distinct", async () => {
  const command = {
    requestId: "req",
    expectedRevision: "a".repeat(64),
    confirmed: true as const,
  };
  const conflict = memoryDetailHttpPort(
    "scope",
    mock(() => response({ code: "revision_conflict" }, 409)),
  );
  expect((await conflict.forget(id, command, signal())).state).toBe("conflict");
  for (const fail of [
    () => response({}, 503),
    () => response({ state: "forgotten", receipt: { factId: "other" } }),
    () => {
      throw new Error("lost");
    },
  ]) {
    const port = memoryDetailHttpPort("scope", mock(fail));
    expect((await port.forget(id, command, signal())).state).toBe("unknown");
  }
});
// Real canonical correction routes and storage; the F17 projection is a deliberately injected test seam.
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "d26-memory-contract-"));
});
afterEach(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});
test("canonical correction survives restart and retains original provenance through supersession", async () => {
  const path = join(directory, "vault.db");
  initDatabase(path);
  const subject = createEntity("person", "D26 test owner").id;
  const old = createFact(subject, "preferred_editor", "Vim", {
    source: "llm_extraction",
    quote: "original evidence",
  });
  const routes = createFactDecisionRoutes();
  let postCount = 0;
  const item = (key: string): MemoryItem => {
    const fact = getFact(key)!;
    return {
      ...detail.item,
      factId: key,
      subjectId: subject,
      scope: fact.scope,
      status: fact.status,
      basis: fact.basis,
      sentence: `D26 test owner ${fact.predicate} ${fact.object}`,
      revision: JSON.stringify(fact),
      updatedAt: fact.verified_at ?? fact.created_at,
      validity: { from: fact.valid_from, to: fact.valid_to },
      supersededBy: fact.superseded_by,
      uses: [],
      sourceSummary: {
        labels: fact.evidence.map((e) => e.source ?? ""),
        evidenceCount: fact.evidence.length,
      },
    };
  };
  const port = memoryDetailHttpPort(
    "isolated-canonical",
    mock(async (url, init) => {
      if (url.startsWith("/api/brief/memory/"))
        return response({ state: "ready", data: item(url.split("/").at(-1)!) });
      const action = /\/facts\/([^/]+)\/(correct|confirm)$/.exec(url);
      if (action) {
        postCount++;
        const req = Object.assign(
          new Request(`http://isolated.test${url}`, {
            method: "POST",
            body: init.body,
          }),
          { params: { id: action[1]! } },
        );
        return routes[
          action[2] === "correct"
            ? "/api/vault/facts/:id/correct"
            : "/api/vault/facts/:id/confirm"
        ].POST(req);
      }
      return response(getFact(url.split("/").at(-1)!));
    }),
  );
  const controller = new MemoryDetailController(port, () => {});
  controller.setAccess(true);
  await controller.open(old.id);
  controller.begin("correct");
  controller.setDraft({ object: "Zed", reason: "Explicit owner correction" });
  await controller.save();
  const replacement = controller.snapshot().factId!;
  expect(replacement).not.toBe(old.id);
  expect(postCount).toBe(1);
  expect(queryFact("D26 test owner", "preferred_editor")?.object).toBe("Zed");
  expect(getFact(old.id)!.evidence[0]!.quote).toBe("original evidence");
  expect(getFact(old.id)!.superseded_by).toBe(replacement);
  closeDb();
  initDatabase(path);
  expect(
    getFact(replacement)!.evidence.some(
      (e) =>
        e.source_ref === `fact:${old.id}` &&
        e.quote === "Explicit owner correction",
    ),
  ).toBe(true);
  await controller.open(replacement);
  expect(controller.snapshot().read.state).toBe("ready");
  controller.retire();
});
