import { expect, test } from "bun:test";
import { createProfilePort } from "./adapter";
import { ProfileController } from "./controller";
import {
  makeProfileFixture,
  profileEnvelope,
  type ProfileExample,
} from "./fixtures";
import {
  PROFILE_FIELDS,
  readSnapshot,
  type ProfileRead,
  type ProfileSave,
} from "./model";
const signal = () => new AbortController().signal;
async function idle(c: ProfileController) {
  for (let i = 0; i < 100 && c.snapshot().reading; i++) await Bun.sleep(1);
  expect(c.snapshot().reading).toBe(false);
}
async function fixture(example: ProfileExample = "ready") {
  const f = makeProfileFixture(example);
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

test("missing F23 host stays unsupported without fabricated profile values", async () => {
  const p = createProfilePort("scope");
  expect(await p.read(signal())).toEqual({ state: "unsupported" });
  expect(
    await p.save("0".repeat(64), { company: "Example" }, signal()),
  ).toEqual({ state: "unsupported" });
});
test("all six mappings must be explicit and sign-in identity never aliases assistant context", () => {
  const f = makeProfileFixture(),
    data = profileEnvelope(f.current()).data;
  expect(readSnapshot(data)).toEqual(f.current());
  expect(PROFILE_FIELDS).toHaveLength(6);
  expect(readSnapshot({ ...data, contractVersion: 2 })).toBeNull();
  expect(readSnapshot({ ...data, fields: data.fields.slice(1) })).toBeNull();
  expect(
    readSnapshot({
      ...data,
      fields: data.fields.map((field) =>
        field.id === "full_name"
          ? { ...field, questionId: "preferred_name" }
          : field,
      ),
    }),
  ).toBeNull();
  expect(readSnapshot({ ...data, questions: [] })).toBeNull();
  expect(
    readSnapshot({
      ...data,
      profile: { revision: "unversioned", answers: {} },
    }),
  ).toBeNull();
  expect(
    readSnapshot({
      ...data,
      profile: { ...data.profile, answers: { company: 4 } },
    }),
  ).toBeNull();
  f.controller.retire();
});
for (const field of PROFILE_FIELDS.flatMap((f) =>
  f.questionId ? [f.questionId] : [],
))
  test(`${field} writes only its canonical ID and preserves unrelated answers`, async () => {
    const f = await fixture(),
      c = f.controller,
      revision = f.current().revision;
    c.edit(field, "  An intentional value\nwith context  ");
    await c.save();
    expect(f.writes).toEqual([
      { revision, answers: { [field]: "An intentional value\nwith context" } },
    ]);
    expect(c.snapshot().phase).toBe("saved");
    expect(f.current().answers.interests).toBe("Walking and astronomy");
    c.edit(field, "   ");
    await c.save();
    expect(f.current().answers[field]).toBeUndefined();
    expect(f.writes.at(-1)?.answers).toEqual({ [field]: null });
    c.retire();
  });
test("identity, unknown fields and oversized values cannot be sent to F23", async () => {
  const f = await fixture(),
    revision = f.current().revision;
  for (const patch of [
    { full_name: "Account name" },
    { voice: "voice" },
    { company: "x".repeat(4001) },
    {},
  ])
    expect(await f.port.save(revision, patch as any, signal())).toEqual({
      state: "invalid",
    });
  f.controller.edit("company", "x".repeat(4001));
  await f.controller.save();
  expect(f.controller.value("company")).toHaveLength(4001);
  expect(f.controller.snapshot().phase).toBe("error");
  expect(f.writes).toHaveLength(0);
  f.controller.retire();
});
test("dirty polls preserve draft and its comparison revision", async () => {
  const f = await fixture(),
    c = f.controller,
    before = f.current();
  c.edit("company", "Local draft");
  f.change({ company: "External" });
  await c.refresh();
  expect(c.value("company")).toBe("Local draft");
  expect(c.snapshot().base).toEqual(before);
  await c.save();
  expect(c.snapshot().phase).toBe("conflict");
  expect(f.current().answers.company).toBe("External");
  await c.save();
  expect(f.writes).toHaveLength(1);
  c.retire();
});
test("typing during a pending poll cannot lose the edit or advance its revision", async () => {
  const f = await fixture(),
    c = f.controller,
    before = f.current(),
    held = deferred<ProfileRead>();
  f.port.read = () => held.promise;
  const read = c.refresh();
  c.edit("company", "Typed while reading");
  f.change({ company: "External" });
  held.resolve({ state: "ready", data: f.current() });
  await read;
  expect(c.snapshot().base).toEqual(before);
  expect(c.value("company")).toBe("Typed while reading");
  c.retire();
});
test("edits during save survive, including a return to the pre-save value", async () => {
  const f = await fixture(),
    c = f.controller,
    before = f.current(),
    held = deferred<ProfileSave>();
  f.port.save = () => held.promise;
  c.edit("company", "Submitted");
  const save = c.save();
  c.edit("company", before.answers.company!);
  c.edit("current_projects", "New typing");
  await c.save();
  held.resolve({
    state: "confirmed",
    data: {
      revision: "a".repeat(64),
      answers: { ...before.answers, company: "Submitted" },
    },
  });
  await save;
  expect(c.snapshot().phase).toBe("dirty");
  expect(c.value("company")).toBe(before.answers.company!);
  expect(c.value("current_projects")).toBe("New typing");
  expect(c.snapshot().base?.answers.company).toBe("Submitted");
  c.retire();
});
test("late poll after confirmed save cannot restore an old revision", async () => {
  const f = await fixture(),
    c = f.controller,
    old = f.current(),
    held = deferred<ProfileRead>();
  f.port.read = () => held.promise;
  const poll = c.refresh();
  c.edit("company", "Saved value");
  await c.save();
  const saved = c.snapshot().base;
  held.resolve({ state: "ready", data: old });
  await poll;
  expect(c.snapshot().phase).toBe("saved");
  expect(c.snapshot().base).toEqual(saved);
  c.retire();
});
for (const example of ["save-failure", "lost-response"] as const)
  test(`${example} keeps drafts; only explicit retry reconciles and saves`, async () => {
    const f = await fixture(example),
      c = f.controller;
    c.edit("company", "Intended value");
    await c.save();
    expect(c.snapshot().phase).toBe("unknown");
    expect(c.value("company")).toBe("Intended value");
    await c.refresh();
    expect(c.snapshot().phase).toBe("unknown");
    expect(f.writes).toHaveLength(1);
    f.recoverWrites();
    await c.save();
    expect(c.snapshot().phase).toBe("saved");
    expect(f.writes).toHaveLength(2);
    expect(f.current().answers.company).toBe("Intended value");
    c.retire();
  });
test("uncertain retry never overwrites an intervening correction", async () => {
  const f = await fixture("lost-response"),
    c = f.controller;
  c.edit("company", "Submitted");
  await c.save();
  f.change({ company: "Corrected elsewhere" });
  f.recoverWrites();
  await c.save();
  expect(c.snapshot().phase).toBe("conflict");
  expect(c.value("company")).toBe("Submitted");
  expect(f.writes).toHaveLength(1);
  c.retire();
});
test("lost acknowledgment retry preserves unrelated concurrent answers", async () => {
  const f = await fixture("lost-response"),
    c = f.controller;
  c.edit("company", "Submitted");
  await c.save();
  f.change({ interests: "New interests" });
  f.recoverWrites();
  await c.save();
  expect(c.snapshot().phase).toBe("saved");
  expect(f.current().answers.interests).toBe("New interests");
  expect(Object.keys(f.writes.at(-1)!.answers)).toEqual(["company"]);
  c.retire();
});
test("cancel requires confirmation; failed discard reload never loses the draft", async () => {
  const f = await fixture(),
    c = f.controller;
  c.edit("company", "Keep me");
  c.cancel();
  expect(c.snapshot().prompt).toBe("cancel");
  await c.resolvePrompt(false);
  expect(c.value("company")).toBe("Keep me");
  f.failReads(true);
  c.cancel();
  await c.resolvePrompt(true);
  expect(c.snapshot().availability).toBe("stale");
  expect(c.value("company")).toBe("Keep me");
  f.failReads(false);
  await c.refresh();
  c.cancel();
  await c.resolvePrompt(true);
  expect(c.value("company")).toBe(f.current().answers.company!);
  expect(c.snapshot().phase).toBe("clean");
  expect(f.writes).toHaveLength(0);
  c.retire();
});
test("discard reload locks local editing until its canonical read completes", async () => {
  const f = await fixture(),
    c = f.controller,
    held = deferred<ProfileRead>();
  c.edit("company", "Discard me");
  f.port.read = () => held.promise;
  c.cancel();
  const discard = c.resolvePrompt(true);
  c.edit("company", "Cannot type into disabled discard");
  expect(c.editable()).toBe(false);
  held.resolve({ state: "ready", data: f.current() });
  await discard;
  expect(c.value("company")).toBe(f.current().answers.company!);
  c.retire();
});
test("navigation can stay or explicitly discard, with no write", async () => {
  const f = await fixture(),
    c = f.controller;
  c.edit("company", "Draft");
  const stay = c.requestLeave();
  await c.resolvePrompt(false);
  expect(await stay).toBe(false);
  expect(c.value("company")).toBe("Draft");
  const leave = c.requestLeave();
  await c.resolvePrompt(true);
  expect(await leave).toBe(true);
  expect(c.hasEdits()).toBe(false);
  expect(f.writes).toHaveLength(0);
  c.retire();
});
test("save in flight blocks departure and cancellation", async () => {
  const f = await fixture(),
    c = f.controller,
    held = deferred<ProfileSave>();
  c.edit("company", "Pending");
  f.port.save = () => held.promise;
  const save = c.save();
  expect(await c.requestLeave()).toBe(false);
  c.cancel();
  expect(c.snapshot().prompt).toBeNull();
  held.resolve({ state: "unknown" });
  await save;
  expect(c.value("company")).toBe("Pending");
  c.retire();
});
test("scope loss cancels a leave prompt and prevents late read/save restoration", async () => {
  const f = await fixture(),
    c = f.controller,
    held = deferred<ProfileSave>();
  c.edit("company", "Pending");
  const leave = c.requestLeave();
  c.setAccess(false);
  expect(await leave).toBe(false);
  expect(c.snapshot().base).toBeNull();
  c.setAccess(true);
  await idle(c);
  c.edit("company", "Late save");
  f.port.save = () => held.promise;
  const save = c.save();
  c.retire();
  held.resolve({
    state: "confirmed",
    data: { ...f.current(), answers: { company: "Late save" } },
  });
  await save;
  expect(c.snapshot().base).toBeNull();
  expect(c.snapshot().draft).toEqual({});
});
for (const example of [
  "read-only",
  "unavailable",
  "unsupported",
  "error",
] as const)
  test(`${example} cannot write`, async () => {
    const f = await fixture(example);
    f.controller.edit("company", "Denied");
    await f.controller.save();
    expect(f.writes).toHaveLength(0);
    f.controller.retire();
  });
test("read failures retain stale drafts; permission loss purges them", async () => {
  const f = await fixture(),
    c = f.controller;
  c.edit("company", "Draft");
  f.failReads(true);
  await c.refresh();
  expect(c.snapshot().availability).toBe("stale");
  expect(c.value("company")).toBe("Draft");
  await c.save();
  expect(f.writes).toHaveLength(0);
  f.host.request = async () => new Response(null, { status: 403 });
  await c.refresh();
  expect(c.snapshot().draft).toEqual({});
  expect(c.snapshot().base).toBeNull();
  c.retire();
});
test("bad acknowledgment, mismatched readback and forged port confirmation never say Saved", async () => {
  for (const mode of ["receipt", "readback", "port"] as const) {
    const f = await fixture(),
      c = f.controller,
      request = f.host.request;
    if (mode === "port")
      f.port.save = async () => ({ state: "confirmed", data: f.current() });
    else
      f.host.request = async (...args) => {
        const response = await request(...args);
        if (args[1].method === "PATCH") {
          if (mode === "receipt")
            return Response.json({ profile: f.current() });
          f.change({ company: "Mismatch" });
        }
        return response;
      };
    c.edit("company", "Intended");
    await c.save();
    expect(c.snapshot().phase).toBe("unknown");
    expect(c.value("company")).toBe("Intended");
    c.retire();
  }
});
