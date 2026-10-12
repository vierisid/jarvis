import { test, expect } from "bun:test";
import { MemoryController } from "./controller";
import { makeMemoryFixture, memoryRows, FIXTURE_NOW } from "./fixtures";
import {
  EMPTY_FILTERS,
  queryFor,
  queryString,
  dateGroup,
  usageLabel,
  type MemoryPort,
  type MemoryRead,
  type MemoryQuery,
} from "./model";
const wait = () => new Promise((resolve) => setTimeout(resolve, 8));
function deferredPort() {
  const pending: {
    query: MemoryQuery;
    signal: AbortSignal;
    resolve: (read: MemoryRead) => void;
    reject: (reason: Error) => void;
  }[] = [];
  const port: MemoryPort = {
    source: "fixture",
    scopeId: "race",
    read: (query, signal) =>
      new Promise((resolve, reject) =>
        pending.push({ query, signal, resolve, reject }),
      ),
  };
  const controller = new MemoryController(port, () => FIXTURE_NOW);
  controller.setAccess(true);
  return { controller, pending };
}
const ready = (index = 0): MemoryRead => ({
  state: "ready",
  asOf: FIXTURE_NOW,
  data: {
    items: [memoryRows()[index]!],
    nextCursor: null,
    count: { total: 6, matched: 1, returned: 1 },
    usedIn: { state: "ready" },
  },
});
test("late success cannot overwrite a newer query; abort is not the only race guard", async () => {
  const { controller: c, pending } = deferredPort();
  c.setFilters({ search: "pilot" }, 0);
  await wait();
  expect(pending[0]!.signal.aborted).toBe(true);
  pending[1]!.resolve(ready(1));
  await wait();
  pending[0]!.resolve(ready(0));
  await wait();
  expect(c.snapshot().read).toEqual(ready(1));
  c.retire();
});
test("a query edit invalidates an old response during debounce and retains all filters", async () => {
  const { controller: c, pending } = deferredPort();
  c.setFilters(
    {
      search: "pilot",
      source: " Conversation ",
      usedIn: "run:fixture-follow-up",
      updated: "week",
    },
    30,
  );
  pending[0]!.resolve(ready());
  await wait();
  expect(c.snapshot().read.state).toBe("loading");
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(pending[1]!.query).toMatchObject({
    q: "pilot",
    source: " Conversation ",
    usedIn: "run:fixture-follow-up",
    updatedBefore: FIXTURE_NOW,
  });
  c.retire();
});
test("late rejection cannot replace newer filters or results", async () => {
  const { controller: c, pending } = deferredPort();
  c.setFilters({ source: "Meeting notes" }, 0);
  await wait();
  pending[1]!.resolve(ready(1));
  await wait();
  pending[0]!.reject(new Error("old"));
  await wait();
  expect(c.snapshot().read).toEqual(ready(1));
  c.retire();
});
test("revocation clears content and sensitive filters, ignores outstanding reads", async () => {
  const { controller: c, pending } = deferredPort();
  c.setFilters({ search: "private" }, 0);
  await wait();
  c.setAccess(false);
  pending[1]!.resolve(ready());
  await wait();
  expect(c.snapshot().read.state).toBe("unavailable");
  expect(c.snapshot().filters).toEqual(EMPTY_FILTERS);
  c.retire();
});
test("retirement notifies subscribers and cannot be reactivated", async () => {
  const { controller: c, pending } = deferredPort();
  let calls = 0;
  c.subscribe(() => calls++);
  c.retire();
  pending[0]!.resolve(ready());
  await wait();
  c.setAccess(true);
  await c.refresh();
  expect(calls).toBe(1);
  expect(c.snapshot().read.state).toBe("unavailable");
  expect(pending).toHaveLength(1);
});
test("server query finds a match beyond first page; no page-local search", async () => {
  const f = makeMemoryFixture("many");
  f.controller.setAccess(true);
  await wait();
  expect(
    "data" in f.controller.snapshot().read &&
      (f.controller.snapshot().read as any).data.items.length,
  ).toBe(50);
  f.controller.setFilters({ search: "needle" }, 0);
  await wait();
  const read = f.controller.snapshot().read;
  expect(read.state).toBe("ready");
  if (!("data" in read)) throw Error();
  expect(read.data.count).toEqual({ total: 123, matched: 1, returned: 1 });
  expect(read.data.items[0]!.factId).toBe("fixture-many-122");
  expect(f.requests.at(-1)).toMatchObject({ q: "needle", limit: 50 });
  f.controller.retire();
});
test("bounded continuation repeats filters and immutable Updated bounds; all rows reachable", async () => {
  const f = makeMemoryFixture("many");
  f.controller.setAccess(true);
  await wait();
  f.controller.setFilters({ updated: "week" }, 0);
  await wait();
  await f.controller.loadMore();
  await f.controller.loadMore();
  const read = f.controller.snapshot().read;
  if (!("data" in read)) throw Error();
  expect(read.data.items).toHaveLength(123);
  expect(read.data.nextCursor).toBeNull();
  expect(f.requests.at(-1)).toEqual({ ...f.requests[1]!, cursor: "100" });
  f.controller.retire();
});
test("combined filters preserve exact server counts and exclude selected-only usage", async () => {
  const f = makeMemoryFixture();
  f.controller.setAccess(true);
  await wait();
  f.controller.setFilters(
    {
      source: "Conversation",
      usedIn: "run:fixture-follow-up",
      updated: "week",
    },
    0,
  );
  await wait();
  const read = f.controller.snapshot().read;
  if (!("data" in read)) throw Error();
  expect(read.data.count.matched).toBe(2);
  expect(read.data.items.map((r) => r.factId)).toEqual([
    "fixture-memory-0",
    "fixture-memory-2",
  ]);
  f.controller.clear();
  await wait();
  expect(f.controller.snapshot().filters).toEqual(EMPTY_FILTERS);
  f.controller.retire();
});
test("continuation is single flight and late pagination cannot contaminate new search", async () => {
  const { controller: c, pending } = deferredPort();
  const page = ready() as Extract<MemoryRead, { data: unknown }>;
  page.data.count.matched = 2;
  page.data.nextCursor = "next";
  pending[0]!.resolve(page);
  await wait();
  void c.loadMore();
  void c.loadMore();
  expect(pending).toHaveLength(2);
  c.setFilters({ search: "pilot" }, 0);
  await wait();
  pending[2]!.resolve(ready(1));
  await wait();
  pending[1]!.resolve(ready(2));
  await wait();
  expect(c.snapshot().read).toEqual(ready(1));
  c.retire();
});
for (const state of ["stale", "unavailable", "unsupported", "error"] as const)
  test(`${state} clears cached rows without clearing applied filters`, async () => {
    const { controller: c, pending } = deferredPort();
    c.setFilters({ search: "emails", source: "Conversation" }, 0);
    await wait();
    const page = ready() as Extract<MemoryRead, { data: unknown }>;
    page.data.count.matched = 2;
    page.data.nextCursor = "next";
    pending[1]!.resolve(page);
    await wait();
    void c.loadMore();
    pending[2]!.resolve({ state, reason: "Fixture" });
    await wait();
    expect(c.snapshot().read).toEqual({ state, reason: "Fixture" });
    expect("data" in c.snapshot().read).toBe(false);
    expect(c.snapshot().filters).toMatchObject({
      search: "emails",
      source: "Conversation",
    });
    c.retire();
  });
for (const change of ["duplicate", "count", "order", "permission"] as const)
  test(`rejects ${change} violation instead of showing a partial vault`, async () => {
    const { controller: c, pending } = deferredPort();
    const page = ready() as Extract<MemoryRead, { data: unknown }>;
    page.data.count.matched = 2;
    page.data.nextCursor = "next";
    pending[0]!.resolve(page);
    await wait();
    void c.loadMore();
    const next = ready(change === "duplicate" ? 0 : 1) as Extract<
      MemoryRead,
      { data: unknown }
    >;
    next.data.count.matched = 2;
    if (change === "count") next.data.count.total++;
    if (change === "order") next.data.items[0]!.updatedAt += 1;
    if (change === "permission")
      next.data.items[0]!.permissions.canRead = false;
    pending[1]!.resolve(next);
    await wait();
    expect(c.snapshot().read.state).toBe("error");
    c.retire();
  });
test("no match, empty vault and missing provider are distinct", async () => {
  const f = makeMemoryFixture();
  f.controller.setAccess(true);
  await wait();
  f.controller.setFilters({ search: "missing" }, 0);
  await wait();
  const read = f.controller.snapshot().read;
  expect(read.state).toBe("empty");
  if ("data" in read) expect(read.data.count.total).toBe(6);
  f.controller.retire();
  const empty = makeMemoryFixture("empty");
  empty.controller.setAccess(true);
  await wait();
  expect((empty.controller.snapshot().read as any).data.count.total).toBe(0);
  empty.controller.retire();
});
test("exact whitespace labels roundtrip and special characters are URL encoded", () => {
  const source = " \tSource & name\n ";
  const query = queryFor(
    { ...EMPTY_FILTERS, source, search: "a%_", usedIn: "run:id:two words" },
    FIXTURE_NOW,
  );
  const params = new URLSearchParams(queryString(query));
  expect(params.get("source")).toBe(source);
  expect(params.get("q")).toBe("a%_");
  expect(params.get("usedIn")).toBe("run:id:two words");
});
test("query limits and invalid identities fail before network access", () => {
  for (const filters of [
    { search: "a".repeat(257) },
    { source: " " },
    { usedIn: "workflow:foo" },
    { usedIn: "run:../a" },
    { usedIn: "run:.." },
  ])
    expect(() =>
      queryFor({ ...EMPTY_FILTERS, ...filters }, FIXTURE_NOW),
    ).toThrow();
});
test("date groups use calendar boundaries and usage never claims reliance", () => {
  expect(dateGroup(FIXTURE_NOW, FIXTURE_NOW)).toBe("Today");
  expect(dateGroup(FIXTURE_NOW - 86400000, FIXTURE_NOW)).toBe("Yesterday");
  expect(usageLabel(memoryRows()[4]!)).toBe("Selected only · not supplied");
  expect(usageLabel({ ...memoryRows()[0]!, uses: [] })).toBe(
    "No retained use recorded",
  );
  expect(usageLabel({ ...memoryRows()[0]!, uses: null })).toBe(
    "Usage unavailable",
  );
});
