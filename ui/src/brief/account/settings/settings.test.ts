import { test, expect } from "bun:test";
import {
  makeSettingsFixture,
  settingsEnvelope,
  type SettingsExample,
} from "./fixtures";
import { createSettingsPort } from "./adapter";
import {
  readSettings,
  readVoice,
  type SettingsRead,
  type VoiceSave,
} from "./model";
const signal = () => new AbortController().signal;
async function fixture(example: SettingsExample = "local") {
  const f = makeSettingsFixture(example);
  f.controller.setAccess(true);
  for (let i = 0; i < 100 && f.controller.snapshot().reading; i++)
    await Bun.sleep(1);
  expect(f.controller.snapshot().reading).toBe(false);
  return f;
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const next = "en-US-GuyNeural",
  third = "en-GB-SoniaNeural";
test("missing host is unsupported and never fabricates preferences", async () => {
  const p = createSettingsPort("scope");
  expect(await p.read(signal())).toEqual({ state: "unsupported" });
  expect(await p.saveVoice("a".repeat(64), next, signal())).toEqual({
    state: "unsupported",
  });
  expect(await p.replayTutorial()).toEqual({ state: "unavailable" });
});
test("strict F23 settings parsing rejects malformed or invented choices", () => {
  const f = makeSettingsFixture(),
    data = settingsEnvelope(f.current()).data;
  expect(readSettings(data)).toEqual(f.current());
  for (const patch of [
    { contractVersion: 2 },
    { checkIn: { state: "ready", choices: ["balanced"] } },
    { setup: { ...data.setup, providerSetup: "managed" } },
    { replay: ["setup"] },
    {
      voice: {
        ...data.voice,
        choices: [...data.voice.choices, data.voice.choices[0]],
      },
    },
    { voice: { ...data.voice, enabled: "yes" } },
    { voice: { ...data.voice, revision: "unversioned" } },
  ])
    expect(readSettings({ ...data, ...patch })).toBeNull();
  expect(
    readVoice({
      ...data.voice,
      choices: [{ id: "x", label: "x".repeat(301) }],
    }),
  ).toBeNull();
  f.controller.retire();
});
for (const example of ["local", "hosted"] as const)
  test(`${example} saves only the selected canonical voice`, async () => {
    const f = await fixture(example),
      c = f.controller,
      id = f.current().voice.choices[1]!.id,
      rev = f.current().voice.revision;
    await c.selectVoice(id);
    expect(f.writes).toEqual([{ revision: rev, voice: id }]);
    expect(c.snapshot().phase).toBe("saved");
    expect(c.value()).toBe(id);
    expect(c.snapshot().message).toBe("Voice saved and applied.");
    expect(f.current().checkIn.state).toBe("unavailable");
    c.retire();
  });
test("arbitrary or unchanged voices do not write", async () => {
  const f = await fixture();
  await f.controller.selectVoice("made-up");
  await f.controller.selectVoice(f.current().voice.voice!);
  expect(f.writes).toHaveLength(0);
  f.controller.retire();
});
for (const example of [
  "read-only",
  "voice-unavailable",
  "unavailable",
  "unsupported",
  "error",
] as const)
  test(`${example} cannot mutate voice`, async () => {
    const f = await fixture(example);
    await f.controller.selectVoice(next);
    expect(f.writes).toHaveLength(0);
    f.controller.retire();
  });
for (const example of ["restart-required", "apply-failure"] as const)
  test(`${example} distinguishes saved value from live application`, async () => {
    const f = await fixture(example);
    await f.controller.selectVoice(next);
    expect(f.controller.snapshot().phase).toBe("saved");
    expect(f.controller.snapshot().message).toContain(
      example === "restart-required"
        ? "Restart Jarvis"
        : "could not be applied",
    );
    await f.controller.save();
    expect(f.writes).toHaveLength(1);
    f.controller.retire();
  });
for (const example of ["save-failure", "lost-response"] as const)
  test(`${example} keeps the selection and only an explicit retry reconciles`, async () => {
    const f = await fixture(example),
      c = f.controller;
    await c.selectVoice(next);
    expect(c.snapshot().phase).toBe("unknown");
    expect(c.value()).toBe(next);
    await c.refresh();
    expect(f.writes).toHaveLength(1);
    f.recoverWrites();
    await c.save();
    expect(c.snapshot().phase).toBe("saved");
    expect(f.current().voice.voice).toBe(next);
    expect(f.writes).toHaveLength(example === "lost-response" ? 1 : 2);
    if (example === "lost-response")
      expect(c.snapshot().message).toContain("unconfirmed");
    c.retire();
  });
test("changed selection after a lost reply still reconciles the original attempt", async () => {
  const f = await fixture("lost-response"),
    c = f.controller;
  await c.selectVoice(next);
  f.recoverWrites();
  await c.selectVoice(third);
  expect(c.snapshot().phase).toBe("saved");
  expect(f.current().voice.voice).toBe(third);
  expect(f.writes).toHaveLength(2);
  c.retire();
});
test("unknown retry never overwrites an external correction", async () => {
  const f = await fixture("lost-response"),
    c = f.controller;
  await c.selectVoice(next);
  f.change(third);
  f.recoverWrites();
  await c.save();
  expect(c.snapshot().phase).toBe("conflict");
  expect(f.writes).toHaveLength(1);
  expect(f.current().voice.voice).toBe(third);
  await c.refresh(true);
  expect(c.snapshot().phase).toBe("clean");
  expect(c.value()).toBe(third);
  c.retire();
});
test("changed provider during reconciliation conflicts even if voice names match", async () => {
  const f = await fixture("lost-response"),
    c = f.controller;
  await c.selectVoice(next);
  const fresh = f.current();
  fresh.voice.provider = "different";
  f.port.read = async () => ({ state: "ready", data: fresh });
  await c.save();
  expect(c.snapshot().phase).toBe("conflict");
  expect(f.writes).toHaveLength(1);
  c.retire();
});
test("save supersedes a poll, blocks duplicate saves, and ignores a late old reply", async () => {
  const f = await fixture(),
    c = f.controller,
    old = f.current(),
    held = deferred<SettingsRead>();
  f.port.read = () => held.promise;
  const poll = c.refresh();
  const saving = c.selectVoice(next);
  await c.selectVoice(third);
  await saving;
  expect(c.snapshot().phase).toBe("saved");
  held.resolve({ state: "ready", data: old });
  await poll;
  expect(c.value()).toBe(next);
  expect(f.writes).toHaveLength(1);
  c.retire();
});
test("discard supersedes a pending poll and failed reload preserves the selection", async () => {
  const f = await fixture("save-failure"),
    c = f.controller;
  await c.selectVoice(next);
  const held = deferred<SettingsRead>();
  let reads = 0;
  f.port.read = () =>
    ++reads === 1 ? held.promise : Promise.resolve({ state: "error" });
  const poll = c.refresh();
  await c.refresh(true);
  expect(c.snapshot().availability).toBe("stale");
  expect(c.value()).toBe(next);
  held.resolve({ state: "ready", data: f.current() });
  await poll;
  expect(c.snapshot().availability).toBe("stale");
  c.retire();
});
test("read failure blocks mutations and permission loss purges old values", async () => {
  const f = await fixture(),
    c = f.controller;
  f.failReads(true);
  await c.refresh();
  expect(c.snapshot().availability).toBe("stale");
  await c.selectVoice(next);
  expect(f.writes).toHaveLength(0);
  f.port.read = async () => ({ state: "unavailable" });
  await c.refresh();
  expect(c.snapshot().base).toBeNull();
  expect(c.value()).toBe("");
  c.retire();
});
test("retiring a scope prevents late save and replay status from restoring values", async () => {
  const f = await fixture(),
    c = f.controller,
    held = deferred<VoiceSave>();
  f.port.saveVoice = () => held.promise;
  const save = c.selectVoice(next);
  c.retire();
  held.resolve({
    state: "confirmed",
    data: { ...f.current(), voice: { ...f.current().voice, voice: next } },
    application: "applied",
  });
  await save;
  expect(c.snapshot().base).toBeNull();
  expect(c.snapshot().phase).toBe("clean");
});
test("tutorial replay requires confirmation, preserves scope and cannot automatically repeat unknown results", async () => {
  const f = await fixture(),
    c = f.controller;
  c.requestReplay();
  await c.confirmReplay(false);
  expect(f.replays).toHaveLength(0);
  f.failReplay(true);
  c.requestReplay();
  await c.confirmReplay(true);
  await c.confirmReplay(true);
  expect(f.replays).toEqual(["tutorial"]);
  expect(c.snapshot().replay).toBe("unknown");
  c.requestReplay();
  await c.refresh();
  expect(c.snapshot().replay).toBe("unknown");
  expect(f.replays).toHaveLength(1);
  c.retire();
});
test("tutorial confirmation rechecks freshness and requires a new request after recovery", async () => {
  const f = await fixture(),
    c = f.controller;
  c.requestReplay();
  f.failReads(true);
  await c.refresh();
  expect(c.snapshot().availability).toBe("stale");
  await c.confirmReplay(true);
  expect(f.replays).toHaveLength(0);
  expect(c.snapshot().replay).toBe("idle");
  expect(c.snapshot().actionMessage).toContain("Refresh settings");
  f.failReads(false);
  await c.refresh();
  await c.confirmReplay(true);
  expect(f.replays).toHaveLength(0);
  c.requestReplay();
  await c.confirmReplay(true);
  expect(f.replays).toEqual(["tutorial"]);
  c.retire();
});
test("tutorial confirmation rechecks the latest supported replay scopes", async () => {
  const f = await fixture(),
    c = f.controller;
  c.requestReplay();
  f.port.read = async () => ({
    state: "ready",
    data: { ...f.current(), replay: ["profile"] },
  });
  await c.refresh();
  expect(c.snapshot().availability).toBe("ready");
  await c.confirmReplay(true);
  expect(f.replays).toHaveLength(0);
  expect(c.snapshot().replay).toBe("idle");
  c.retire();
});
test("unavailable/read-only tutorial and missing destinations do not execute", async () => {
  const f = await fixture("read-only"),
    c = f.controller;
  c.requestReplay();
  await c.confirmReplay(true);
  expect(f.replays).toHaveLength(0);
  (f.port.destinations as { authority: boolean }).authority = false;
  await c.navigate("authority");
  expect(f.destinations).toHaveLength(0);
  c.retire();
});
test("all explicit destinations use the host compatibility owner", async () => {
  const f = await fixture();
  for (const destination of [
    "authority",
    "connections",
    "voice-settings",
    "advanced-settings",
  ] as const)
    await f.controller.navigate(destination);
  expect(f.destinations).toEqual([
    "authority",
    "connections",
    "voice-settings",
    "advanced-settings",
  ]);
  expect(f.writes).toHaveLength(0);
  f.controller.retire();
});
test("bad save receipts/readbacks never claim success", async () => {
  const f = makeSettingsFixture();
  for (const response of [
    Response.json({
      saved: true,
      voice: { ...f.current().voice, voice: next },
      application: "guessed",
    }),
    Response.json({
      saved: true,
      voice: f.current().voice,
      application: "applied",
    }),
  ]) {
    f.host.request = async () => response;
    expect(
      await f.port.saveVoice(f.current().voice.revision, next, signal()),
    ).toEqual({ state: "unknown" });
  }
  f.controller.retire();
});
test("restart notice survives failed and recovered polling without resubmission", async () => {
  const f = await fixture("restart-required"),
    c = f.controller;
  await c.selectVoice(next);
  f.failReads(true);
  await c.refresh();
  expect(c.snapshot().availability).toBe("stale");
  f.failReads(false);
  await c.refresh();
  expect(c.snapshot().message).toContain("Restart Jarvis");
  await c.selectVoice(next);
  expect(f.writes).toHaveLength(1);
  f.change(third);
  await c.refresh();
  expect(c.snapshot().message).toBe("");
  c.retire();
});
test("late tutorial acknowledgment is discarded after scope revocation", async () => {
  const f = await fixture(),
    c = f.controller,
    held = deferred<{ state: "replayed" }>();
  f.port.replayTutorial = () => held.promise;
  c.requestReplay();
  const pending = c.confirmReplay(true);
  c.setAccess(false);
  held.resolve({ state: "replayed" });
  await pending;
  expect(c.snapshot().base).toBeNull();
  expect(c.snapshot().replay).toBe("idle");
  c.retire();
});
test("tutorial wrapper delegates only tutorial scope to the existing reset owner", async () => {
  const { replayExistingTutorial } = await import("./actions");
  const old = globalThis.fetch;
  const calls: { path: string; body: unknown }[] = [];
  try {
    globalThis.fetch = (async (input, init) => {
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({
        ok: true,
        scope: "tutorial",
        cleared: ["tutorial_completed_at"],
        client_cache_keys: [],
        message: "replayed",
      });
    }) as typeof fetch;
    expect(await replayExistingTutorial()).toEqual({ state: "replayed" });
    expect(calls).toEqual([
      { path: "/api/onboarding/reset", body: { scope: "tutorial" } },
    ]);
    globalThis.fetch = (async () =>
      new Response(null, { status: 503 })) as unknown as typeof fetch;
    expect(await replayExistingTutorial()).toEqual({ state: "unknown" });
  } finally {
    globalThis.fetch = old;
  }
});
