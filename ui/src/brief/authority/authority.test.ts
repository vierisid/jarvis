import { expect, test } from "bun:test";
import { AuthorityEngine } from "../../../../src/authority/engine";
import { createAuthorityPort } from "./adapter";
import { AuthorityController } from "./controller";
import {
  ACTION_CATEGORIES,
  changedValues,
  readSettings,
  type AuthoritySettings,
  type ReadResult,
} from "./model";
import { makeAuthorityFixture, type AuthorityExample } from "./fixtures";

const signal = () => new AbortController().signal;
async function idle(c: AuthorityController) {
  for (let i = 0; i < 100 && c.snapshot().reading; i++) await Bun.sleep(1);
  expect(c.snapshot().reading).toBe(false);
}
async function fixture(example: AuthorityExample = "ready") {
  const f = makeAuthorityFixture(example);
  f.controller.setAccess(true);
  await idle(f.controller);
  return f;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("missing host is unsupported and cannot fabricate default settings", async () => {
  const p = createAuthorityPort("scope");
  expect(await p.read(signal())).toEqual({ state: "unsupported" });
  expect(p.canWrite).toBe(false);
  expect(await p.navigate("emergency-controls", signal())).toEqual({
    state: "unavailable",
  });
});
for (const level of [0, 11, 2.5, NaN, "3", null])
  test(`invalid level ${level} does not become a plausible default`, () => {
    expect(
      readSettings({
        default_level: level,
        governed_categories: [],
        emergency_state: "normal",
      }),
    ).toBeNull();
  });
test("canonical public fields are validated without leaking advanced config or dropping additive categories", () => {
  const input = {
    default_level: 3,
    governed_categories: ["send_email", "future_category"],
    emergency_state: "normal",
    secrets: "private",
  };
  expect(readSettings(input)).toEqual({
    default_level: 3,
    governed_categories: input.governed_categories,
    emergency_state: "normal",
  });
  expect(
    readSettings({
      ...input,
      governed_categories: ["send_email", "send_email"],
    }),
  ).toBeNull();
  expect(readSettings({ ...input, emergency_state: "anything" })).toBeNull();
  expect(ACTION_CATEGORIES).toHaveLength(13);
});
test("save sends only changed canonical fields, preserves additive governed values, and reload restores them", async () => {
  const f = await fixture(),
    c = f.controller;
  f.change({ governed_categories: ["send_email", "future_category"] });
  await c.refresh();
  c.toggle("send_email", false);
  await c.save();
  expect(f.writes).toEqual([{ governed_categories: ["future_category"] }]);
  expect(c.snapshot().phase).toBe("saved");
  c.setLevel(9);
  await c.save();
  expect(f.writes.at(-1)).toEqual({ default_level: 9 });
  const restored = new AuthorityController(f.port);
  restored.setAccess(true);
  await idle(restored);
  expect(restored.snapshot().draft?.default_level).toBe(9);
  expect(restored.snapshot().draft?.governed_categories).toEqual([
    "future_category",
  ]);
  c.retire();
  restored.retire();
});
for (const category of ACTION_CATEGORIES)
  test(`turning ${category} off changes category membership, not policy`, async () => {
    const f = await fixture(),
      c = f.controller;
    c.toggle(category, true);
    await c.save();
    c.toggle(category, false);
    await c.save();
    expect(f.current().governed_categories).not.toContain(category);
    expect(f.current().default_level).toBe(3);
    expect(
      f.writes.every((p) =>
        Object.keys(p as object).every((k) => k === "governed_categories"),
      ),
    ).toBe(true);
    c.retire();
  });
test("canonical engine still denies a low-level ungoverned action and honors advanced deny overrides", () => {
  const config = {
    default_level: 1,
    governed_categories: [],
    overrides: [],
    context_rules: [],
    learning: { enabled: false, suggest_threshold: 3 },
    emergency_state: "normal" as const,
  };
  const p = {
    agentId: "fixture",
    agentRoleId: "fixture",
    agentAuthorityLevel: 1,
    toolName: "delete",
    toolCategory: "fixture",
    actionCategory: "delete_data" as const,
    temporaryGrants: new Map(),
  };
  expect(new AuthorityEngine(config).checkAuthority(p).allowed).toBe(false);
  expect(
    new AuthorityEngine({
      ...config,
      default_level: 10,
      overrides: [{ action: "delete_data", allowed: false }],
    }).checkAuthority(p).allowed,
  ).toBe(false);
});
test("editing and polling never imply a save or overwrite the draft", async () => {
  const f = await fixture(),
    c = f.controller;
  c.setLevel(7);
  f.change({ default_level: 8 });
  await c.refresh();
  expect(c.snapshot().draft?.default_level).toBe(7);
  expect(c.snapshot().saved?.default_level).toBe(3);
  expect(f.writes).toHaveLength(0);
  expect(c.snapshot().phase).toBe("dirty");
  await c.refresh(true);
  expect(c.snapshot().draft?.default_level).toBe(8);
  expect(c.snapshot().phase).toBe("clean");
  c.retire();
});
test("external changes to an edited field produce conflict before posting", async () => {
  const f = await fixture("conflict"),
    c = f.controller;
  c.setLevel(6);
  await c.save();
  await c.save();
  expect(c.snapshot().phase).toBe("conflict");
  expect(c.snapshot().draft?.default_level).toBe(6);
  expect(f.writes).toHaveLength(0);
  expect(c.editable()).toBe(false);
  await c.refresh(true);
  expect(c.snapshot().draft?.default_level).toBe(10);
  c.retire();
});
test("unrelated changes are preserved by a partial save and appear in its canonical readback", async () => {
  const f = await fixture(),
    c = f.controller;
  c.setLevel(6);
  f.change({ governed_categories: ["delete_data"] });
  await c.save();
  expect(c.snapshot().phase).toBe("saved");
  expect(c.snapshot().draft?.governed_categories).toEqual(["delete_data"]);
  expect(f.writes).toEqual([{ default_level: 6 }]);
  c.retire();
});
for (const example of ["save-failure", "lost-response"] as const)
  test(`${example} never appears saved and cannot silently retry`, async () => {
    const f = await fixture(example),
      c = f.controller;
    c.setLevel(8);
    await c.save();
    await c.save();
    expect(c.snapshot().phase).toBe("unknown");
    expect(f.writes).toHaveLength(1);
    expect(c.snapshot().draft?.default_level).toBe(8);
    expect(c.snapshot().saved?.default_level).toBe(3);
    await c.refresh(true);
    expect(c.snapshot().phase).toBe("clean");
    expect(c.snapshot().message).toContain("previous save was not confirmed");
    expect(c.snapshot().draft?.default_level).toBe(
      example === "lost-response" ? 8 : 3,
    );
    c.retire();
  });
test("positive acknowledgment alone is insufficient; duplicate save waits for fresh readback", async () => {
  const f = await fixture(),
    c = f.controller,
    read = f.host.request,
    held = deferred<Response>();
  let posted = false;
  f.host.request = async (url, init) => {
    if (posted && init.method === "GET") return held.promise;
    const response = await read(url, init);
    if (init.method === "POST") posted = true;
    return response;
  };
  c.setLevel(7);
  const save = c.save();
  for (let i = 0; i < 100 && !posted; i++) await Bun.sleep(1);
  await c.save();
  expect(c.snapshot().phase).toBe("saving");
  expect(f.writes).toHaveLength(1);
  held.resolve(Response.json(f.current()));
  await save;
  expect(c.snapshot().phase).toBe("saved");
  c.retire();
});
test("mismatched canonical readback never reports success", async () => {
  const f = await fixture(),
    c = f.controller,
    read = f.host.request;
  f.host.request = async (...args) => {
    const response = await read(...args);
    if (args[1].method === "POST") f.change({ default_level: 4 });
    return response;
  };
  c.setLevel(7);
  await c.save();
  expect(c.snapshot().phase).toBe("unknown");
  c.retire();
});
for (const example of [
  "read-only",
  "error",
  "unavailable",
  "unsupported",
] as const)
  test(`${example} cannot write settings`, async () => {
    const f = await fixture(example),
      c = f.controller;
    c.setLevel(10);
    c.toggle("send_email", false);
    await c.save();
    expect(f.writes).toHaveLength(0);
    expect(c.editable()).toBe(false);
    c.retire();
  });
test("failed refresh retains stale context with disabled controls; denied access purges it", async () => {
  const f = await fixture(),
    c = f.controller;
  f.failReads(true);
  await c.refresh();
  expect(c.snapshot().availability).toBe("stale");
  expect(c.snapshot().draft?.default_level).toBe(3);
  expect(c.editable()).toBe(false);
  f.failReads(false);
  await c.refresh();
  expect(c.editable()).toBe(true);
  f.host.request = async () => new Response(null, { status: 403 });
  await c.refresh();
  expect(c.snapshot().draft).toBeNull();
  expect(c.snapshot().saved).toBeNull();
  c.retire();
});
test("retiring during the preflight prevents the write and drops late data", async () => {
  const f = await fixture(),
    c = f.controller,
    held = deferred<Response>();
  f.host.request = () => held.promise;
  c.setLevel(10);
  const save = c.save();
  c.retire();
  held.resolve(Response.json(f.current()));
  await save;
  expect(f.writes).toHaveLength(0);
  expect(c.snapshot().saved).toBeNull();
  expect(c.snapshot().availability).toBe("unavailable");
});
test("late reads after scope loss cannot restore settings", async () => {
  const f = makeAuthorityFixture(),
    held = deferred<ReadResult>();
  f.port.read = () => held.promise;
  const c = new AuthorityController(f.port);
  c.setAccess(true);
  c.setAccess(false);
  held.resolve({ state: "ready", data: f.current() });
  await Bun.sleep(1);
  expect(c.snapshot().saved).toBeNull();
  c.retire();
});
test("advanced and emergency destinations remain reachable during uncertain saves and honor cancellation", async () => {
  const f = await fixture("lost-response"),
    c = f.controller;
  c.setLevel(5);
  await c.save();
  await c.navigate("advanced-authority");
  await c.navigate("emergency-controls");
  expect(f.navigations).toEqual(["advanced-authority", "emergency-controls"]);
  const pending = c.navigate("emergency-controls");
  c.retire();
  await pending;
  expect(f.navigations).toHaveLength(2);
});
test("a forged port confirmation cannot mark another level saved", async () => {
  const f = await fixture(),
    c = f.controller;
  f.port.save = async () => ({ state: "confirmed", data: f.current() });
  c.setLevel(9);
  await c.save();
  expect(c.snapshot().phase).toBe("unknown");
  c.retire();
});
