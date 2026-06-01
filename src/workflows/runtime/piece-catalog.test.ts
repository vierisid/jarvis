/**
 * Tests for the PieceCatalog module:
 *   - Unit-level: discovery, conflict reporting, metadata->entry conversion,
 *     prop-type mapping, on-disk cache round-trip with key invalidation,
 *     timeout + per-piece failure isolation, content-hash cache key.
 *   - Engine-level (gated on JARVIS_TEST_ENGINE_BUILD=1): spawn the real
 *     engine, run EXTRACT_PIECE_METADATA against the seven vendored Jarvis
 *     pieces, assert every piece + every action/trigger is captured.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  PieceCatalog,
  buildPieceCatalog,
  computeCatalogCacheKey,
  discoverPieces,
  metadataToCatalogEntry,
  propsToInputSchema,
  readCachedCatalog,
  type CacheFileShape,
  type PieceLookup,
} from "./piece-catalog";
import { JarvisPieceRegistry } from "../jarvis-pieces/types";
import { CredentialResolver } from "../credentials/adapter";
import { SandboxApi } from "../sandbox-api/server";
import {
  buildEngineBundle,
  ENGINE_BUILD_PATHS,
  findCachedBundle,
} from "../runner/engine-runtime/build";
import { buildAllJarvisPieces } from "../runner/engine-runtime/build-pieces";
import { EngineRuntime, type EngineHandle } from "../runner/engine-runtime/engine-runtime";

/** Returns a fresh tmp dir under os.tmpdir() and a cleanup callback. */
function tmp(prefix: string): { path: string; cleanup: () => void } {
  const path = resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(path, { recursive: true });
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

describe("PieceCatalog (unit)", () => {
  test("PieceCatalog.list/get round-trips initial entries", () => {
    const catalog = new PieceCatalog([
      {
        name: "@jarvispieces/piece-jarvis-test",
        displayName: "Jarvis: Test",
        description: "test",
        actions: { echo: { name: "echo", displayName: "Echo", description: "" } },
      },
    ]);
    expect(catalog.list().length).toBe(1);
    expect(catalog.get("@jarvispieces/piece-jarvis-test")?.displayName).toBe("Jarvis: Test");
    expect(catalog.get("missing")).toBeNull();
  });

  test("metadataToCatalogEntry maps actions + triggers verbatim", () => {
    const entry = metadataToCatalogEntry({
      name: "@jarvispieces/piece-x",
      displayName: "X",
      description: "x desc",
      actions: {
        do_thing: {
          name: "do_thing",
          displayName: "Do Thing",
          description: "does",
          props: {
            goal: { type: "SHORT_TEXT", required: true, displayName: "Goal", placeholder: "what to do" },
          },
        },
      },
      triggers: {
        on_event: {
          name: "on_event",
          displayName: "On",
          description: "fires",
          props: {},
        },
      },
    });
    expect(entry.name).toBe("@jarvispieces/piece-x");
    const goal = entry.actions["do_thing"]?.inputSchema?.fields[0];
    expect(goal?.name).toBe("goal");
    expect(goal?.required).toBe(true);
    expect(goal?.placeholder).toBe("what to do");
    expect(entry.triggers?.["on_event"]?.displayName).toBe("On");
  });

  test("metadataToCatalogEntry attaches dynamicSampleData to jarvis-trigger:on_event", () => {
    // jarvis-trigger's on_event surfaces an envelope whose payload shape
    // varies with the configured eventType. The projection injects a
    // synthesized `dynamicSampleData` map sourced from the canonical
    // `WORKFLOW_EVENT_TYPES` registry so the picker + composer don't
    // each have to import the registry directly.
    const entry = metadataToCatalogEntry({
      name: "@jarvispieces/piece-jarvis-trigger",
      displayName: "Jarvis: Trigger",
      description: "",
      actions: {},
      triggers: {
        on_event: { name: "on_event", displayName: "On event", description: "", props: {} },
      },
    });
    const onEvent = entry.triggers?.["on_event"];
    expect(onEvent?.dynamicSampleData?.propName).toBe("eventType");
    const samples = onEvent?.dynamicSampleData?.samples ?? {};
    // Spot-check a representative event: the envelope is full (id +
    // eventType + payload + timestamp), and the payload mirrors the
    // registry's payloadExample.
    const clip = samples["observer.clipboard_changed"] as
      | { eventType?: string; payload?: { content?: string; length?: number }; timestamp?: number; id?: string }
      | undefined;
    expect(clip?.eventType).toBe("observer.clipboard_changed");
    expect(clip?.payload?.content).toBe("https://example.com");
    expect(clip?.payload?.length).toBe(19);
    expect(typeof clip?.timestamp).toBe("number");
    expect(typeof clip?.id).toBe("string");
  });

  test("metadataToCatalogEntry promotes on_event's eventType field to an enum populated from WORKFLOW_EVENT_TYPES", async () => {
    // The piece source declares `eventType` as ShortText because the
    // option list lives daemon-side, not in the piece bundle. The
    // projection upgrades it so the editor renders a real dropdown
    // (the `enum` widget). Options come from the canonical registry;
    // each option's `description` is the per-event prose used as the
    // <option title> hover.
    const entry = metadataToCatalogEntry({
      name: "@jarvispieces/piece-jarvis-trigger",
      displayName: "Jarvis: Trigger",
      description: "",
      actions: {},
      triggers: {
        on_event: {
          name: "on_event",
          displayName: "On event",
          description: "",
          // Mirrors how the engine sends it: required free-text string.
          props: {
            eventType: { type: "SHORT_TEXT", required: true, displayName: "Event type" },
            filter: { type: "JSON", required: false, displayName: "Filter" },
          },
        },
      },
    });
    const eventTypeField = entry.triggers?.["on_event"]?.inputSchema?.fields.find(
      (f) => f.name === "eventType",
    );
    expect(eventTypeField?.type).toBe("enum");
    const optionValues = eventTypeField?.options?.map((o) => o.value) ?? [];
    // Spot-check a few representative entries; full registry parity is
    // implicit because the option set is built directly from it.
    expect(optionValues).toContain("observer.clipboard_changed");
    expect(optionValues).toContain("observer.email_received");
    expect(optionValues).toContain("awareness.context_changed");
    expect(optionValues).toContain("commitment.due_soon");
    const { WORKFLOW_EVENT_TYPES } = await import("../runtime/event-types");
    expect(optionValues.length).toBe(WORKFLOW_EVENT_TYPES.length);
    const clipboardOption = eventTypeField?.options?.find((o) => o.value === "observer.clipboard_changed");
    expect(clipboardOption?.description).toMatch(/clipboard/i);
    // Group field is the source segment of the canonical id so the
    // editor can render <optgroup>s. Every event-type id is dotted,
    // so every option carries a group.
    expect(clipboardOption?.group).toBe("observer");
    const commitmentOption = eventTypeField?.options?.find((o) => o.value === "commitment.due_soon");
    expect(commitmentOption?.group).toBe("commitment");
    expect((eventTypeField?.options ?? []).every((o) => typeof o.group === "string" && o.group.length > 0)).toBe(true);
    // Unrelated field is untouched -- the upgrade is surgical.
    const filterField = entry.triggers?.["on_event"]?.inputSchema?.fields.find((f) => f.name === "filter");
    expect(filterField?.type).toBe("json");
  });

  test("metadataToCatalogEntry promotes run_workflow's `flow` field to flow_ref", () => {
    // The piece source declares `flow` as ShortText because the upstream
    // framework has no flow-ref concept. The projection upgrades it so
    // the editor renders a searchable workflow picker.
    const entry = metadataToCatalogEntry({
      name: "@jarvispieces/piece-jarvis-trigger",
      displayName: "Jarvis: Trigger",
      description: "",
      actions: {
        run_workflow: {
          name: "run_workflow",
          displayName: "Run another workflow",
          description: "",
          props: {
            flow: { type: "SHORT_TEXT", required: true, displayName: "Flow" },
            payload: { type: "JSON", required: false, displayName: "Payload" },
          },
        },
      },
      triggers: {},
    });
    const flowField = entry.actions["run_workflow"]?.inputSchema?.fields.find((f) => f.name === "flow");
    expect(flowField?.type).toBe("flow_ref");
    // Adjacent field is untouched -- the upgrade is surgical.
    const payloadField = entry.actions["run_workflow"]?.inputSchema?.fields.find((f) => f.name === "payload");
    expect(payloadField?.type).toBe("json");
  });

  test("metadataToCatalogEntry does NOT promote `flow` fields on unrelated pieces", () => {
    // A piece that happens to name a string field "flow" should NOT
    // be promoted to flow_ref. The promotion is keyed on the
    // (piece, action) pair, not on field name alone.
    const entry = metadataToCatalogEntry({
      name: "@some/other-piece",
      displayName: "Other",
      description: "",
      actions: {
        run_workflow: {
          name: "run_workflow",
          displayName: "Run",
          description: "",
          props: {
            flow: { type: "SHORT_TEXT", required: true, displayName: "Flow" },
          },
        },
      },
      triggers: {},
    });
    expect(entry.actions["run_workflow"]?.inputSchema?.fields[0]?.type).toBe("string");
  });

  test("metadataToCatalogEntry does NOT attach dynamicSampleData to unrelated pieces", () => {
    const entry = metadataToCatalogEntry({
      name: "@some/other-piece",
      displayName: "Other",
      description: "",
      actions: {},
      triggers: {
        on_event: { name: "on_event", displayName: "On event", description: "", props: {} },
      },
    });
    expect(entry.triggers?.["on_event"]?.dynamicSampleData).toBeUndefined();
  });

  test("propsToInputSchema maps every supported PropertyType", () => {
    const schema = propsToInputSchema({
      a_short: { type: "SHORT_TEXT", required: true, displayName: "A" },
      a_long: { type: "LONG_TEXT", required: false, displayName: "A long" },
      a_num: { type: "NUMBER", required: false, displayName: "Num", defaultValue: 25 },
      a_bool: { type: "CHECKBOX", required: false, displayName: "Bool" },
      a_dropdown: {
        type: "STATIC_DROPDOWN",
        required: false,
        displayName: "Drop",
        options: { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
      },
      a_multi: {
        type: "STATIC_MULTI_SELECT_DROPDOWN",
        required: false,
        displayName: "Multi",
        options: { options: [{ value: "x" }] },
      },
      a_json: { type: "JSON", required: false, displayName: "Json" },
      a_object: { type: "OBJECT", required: false, displayName: "Obj" },
      a_dt: { type: "DATE_TIME", required: false, displayName: "Dt" },
      a_md: { type: "MARKDOWN", required: false, displayName: "Md" },
      a_oauth: { type: "OAUTH2", required: false, displayName: "OAuth" },
    });
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]));
    expect(byName["a_short"]?.type).toBe("string");
    expect(byName["a_short"]?.required).toBe(true);
    expect(byName["a_long"]?.type).toBe("long_text");
    expect(byName["a_num"]?.type).toBe("number");
    expect(byName["a_num"]?.default).toBe(25);
    expect(byName["a_bool"]?.type).toBe("boolean");
    expect(byName["a_dropdown"]?.type).toBe("enum");
    expect(byName["a_dropdown"]?.options?.length).toBe(2);
    expect(byName["a_multi"]?.type).toBe("multi_enum");
    expect(byName["a_json"]?.type).toBe("json");
    expect(byName["a_object"]?.type).toBe("json");
    // DATE_TIME maps to its own type now -- legacy "string" was lossy.
    expect(byName["a_dt"]?.type).toBe("datetime");
    // Markdown + auth are non-input -- dropped from the schema.
    expect(byName["a_md"]).toBeUndefined();
    expect(byName["a_oauth"]).toBeUndefined();
  });

  test("propsToInputSchema falls back to 'json' on unknown types", () => {
    const schema = propsToInputSchema({
      mystery: { type: "FUTURE_TYPE", required: false, displayName: "M" },
    });
    expect(schema.fields[0]?.type).toBe("json");
  });

  test("propsToInputSchema propagates placeholder for text/number widgets", () => {
    const schema = propsToInputSchema({
      a: { type: "SHORT_TEXT", required: false, displayName: "A", placeholder: "hint" },
      b: { type: "NUMBER", required: false, displayName: "B", placeholder: "0" },
    });
    expect(schema.fields[0]?.placeholder).toBe("hint");
    expect(schema.fields[1]?.placeholder).toBe("0");
  });

  test("discoverPieces reads name/version from each direct subdir's package.json", () => {
    const { path: root, cleanup } = tmp("discover");
    mkdirSync(resolve(root, "alpha"), { recursive: true });
    mkdirSync(resolve(root, "beta"), { recursive: true });
    mkdirSync(resolve(root, "no-pkg"), { recursive: true });
    writeFileSync(
      resolve(root, "alpha/package.json"),
      JSON.stringify({ name: "@scope/piece-alpha", version: "0.0.1" }),
    );
    writeFileSync(
      resolve(root, "beta/package.json"),
      JSON.stringify({ name: "@scope/piece-beta", version: "0.0.2" }),
    );
    try {
      const { entries, conflicts } = discoverPieces([root]);
      expect(entries.length).toBe(2);
      expect(entries[0]?.name).toBe("@scope/piece-alpha");
      expect(entries[1]?.name).toBe("@scope/piece-beta");
      expect(conflicts).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("discoverPieces skips packages whose name doesn't match the piece-<id> convention", () => {
    // Regression for users installing a community piece via the Library
    // tab: bun also writes @activepieces/{shared,pieces-common,
    // pieces-framework} into the same scoped dir. These must NOT be
    // treated as pieces (the engine throws INTERNAL_ERROR trying to
    // extract metadata for them).
    const { path: root, cleanup } = tmp("discover-skip");
    for (const sub of ["piece-gmail", "shared", "pieces-common", "pieces-framework"]) {
      mkdirSync(resolve(root, sub), { recursive: true });
      writeFileSync(
        resolve(root, sub, "package.json"),
        JSON.stringify({
          name: sub === "piece-gmail" ? "@activepieces/piece-gmail" : `@activepieces/${sub}`,
          version: "1.0.0",
        }),
      );
    }
    try {
      const { entries } = discoverPieces([root]);
      expect(entries.map((e) => e.name)).toEqual(["@activepieces/piece-gmail"]);
    } finally {
      cleanup();
    }
  });

  test("discoverPieces dedupes by name across roots and reports conflicts", () => {
    const { path: a, cleanup: cleanupA } = tmp("discover-a");
    const { path: b, cleanup: cleanupB } = tmp("discover-b");
    mkdirSync(resolve(a, "dup"), { recursive: true });
    mkdirSync(resolve(b, "dup"), { recursive: true });
    writeFileSync(
      resolve(a, "dup/package.json"),
      JSON.stringify({ name: "@scope/piece-dup", version: "0.0.1" }),
    );
    writeFileSync(
      resolve(b, "dup/package.json"),
      JSON.stringify({ name: "@scope/piece-dup", version: "0.0.2" }),
    );
    try {
      const { entries, conflicts } = discoverPieces([a, b]);
      expect(entries.length).toBe(1);
      expect(entries[0]?.dir).toBe(resolve(a, "dup"));
      expect(conflicts.length).toBe(1);
      expect(conflicts[0]?.name).toBe("@scope/piece-dup");
      expect(conflicts[0]?.kept).toBe(resolve(a, "dup"));
      expect(conflicts[0]?.dropped).toBe(resolve(b, "dup"));
    } finally {
      cleanupA();
      cleanupB();
    }
  });

  test("discoverPieces tolerates missing roots and malformed package.json", () => {
    const { path: root, cleanup } = tmp("discover-bad");
    mkdirSync(resolve(root, "broken"), { recursive: true });
    writeFileSync(resolve(root, "broken/package.json"), "{not json}");
    try {
      const { entries, conflicts } = discoverPieces([root, "/does/not/exist"]);
      expect(entries).toEqual([]);
      expect(conflicts).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("computeCatalogCacheKey changes when bundle or piece source changes", () => {
    const { path: root, cleanup } = tmp("cache-key");
    const bundlePath = resolve(root, "engine.js");
    writeFileSync(bundlePath, "v1");
    mkdirSync(resolve(root, "pieces/p/dist/src"), { recursive: true });
    writeFileSync(
      resolve(root, "pieces/p/package.json"),
      JSON.stringify({ name: "@scope/piece-p", version: "0.0.1" }),
    );
    writeFileSync(resolve(root, "pieces/p/dist/src/index.js"), "v1");
    try {
      const k1 = computeCatalogCacheKey({ bundlePath, pieceRoots: [resolve(root, "pieces")] });
      // Bundle change -> new key.
      writeFileSync(bundlePath, "v2");
      const k2 = computeCatalogCacheKey({ bundlePath, pieceRoots: [resolve(root, "pieces")] });
      expect(k2).not.toBe(k1);
      // Piece source change without bundle change -> new key (the bug we fixed in review #2).
      writeFileSync(resolve(root, "pieces/p/dist/src/index.js"), "edited");
      const k3 = computeCatalogCacheKey({ bundlePath, pieceRoots: [resolve(root, "pieces")] });
      expect(k3).not.toBe(k2);
    } finally {
      cleanup();
    }
  });

  test("readCachedCatalog returns null when cacheKey doesn't match", () => {
    const { path: dir, cleanup } = tmp("cache-mismatch");
    const file = resolve(dir, "cache.json");
    const payload: CacheFileShape = {
      cacheKey: "v1",
      entries: [{ name: "p", displayName: "P", description: "", actions: {} }],
    };
    writeFileSync(file, JSON.stringify(payload));
    try {
      expect(readCachedCatalog(file, "v1")?.list().length).toBe(1);
      expect(readCachedCatalog(file, "v2")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("readCachedCatalog returns null when file is missing or malformed", () => {
    expect(readCachedCatalog("/no/such/path", "v1")).toBeNull();
    const { path: dir, cleanup } = tmp("cache-bad");
    const file = resolve(dir, "cache.json");
    writeFileSync(file, "{not json");
    try {
      expect(readCachedCatalog(file, "v1")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("buildPieceCatalog isolates per-piece failures, surfaces them, still returns the catalog", async () => {
    // Stub runtime: each `acquire()` returns a handle whose extractPieceMetadata
    // succeeds for "@scope/piece-ok" and throws for "@scope/piece-bad". buildPieceCatalog
    // should return a catalog with the OK piece + a failure for the bad one.
    const { path: root, cleanup } = tmp("build-isolate");
    for (const [sub, name] of [
      ["ok", "@scope/piece-ok"],
      ["bad", "@scope/piece-bad"],
    ] as const) {
      mkdirSync(resolve(root, sub), { recursive: true });
      writeFileSync(
        resolve(root, sub, "package.json"),
        JSON.stringify({ name, version: "0.0.1" }),
      );
    }
    const fakeHandle = {
      async extractPieceMetadata(o: { pieceName: string }) {
        if (o.pieceName === "@scope/piece-bad") throw new Error("boom");
        return {
          name: o.pieceName,
          displayName: "OK",
          description: "ok",
          actions: { ping: { name: "ping", displayName: "Ping", description: "", props: {} } },
        };
      },
      async release() { /* noop */ },
    } as unknown as EngineHandle;
    const fakeRuntime = {
      acquire: async () => fakeHandle,
    } as unknown as EngineRuntime;
    const reports: string[] = [];
    try {
      const { catalog, failures } = await buildPieceCatalog({
        runtime: fakeRuntime,
        pieceRoots: [root],
        reporter: (m) => reports.push(m),
      });
      expect(catalog.list().length).toBe(1);
      expect(catalog.get("@scope/piece-ok")?.displayName).toBe("OK");
      expect(failures.length).toBe(1);
      expect(failures[0]?.pieceName).toBe("@scope/piece-bad");
      expect(failures[0]?.reason).toContain("boom");
      expect(reports.some((r) => r.includes("@scope/piece-bad"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("buildPieceCatalog enforces per-piece timeout and surfaces the timeout reason", async () => {
    const { path: root, cleanup } = tmp("build-timeout");
    mkdirSync(resolve(root, "slow"), { recursive: true });
    writeFileSync(
      resolve(root, "slow/package.json"),
      JSON.stringify({ name: "@scope/piece-slow", version: "0.0.1" }),
    );
    const fakeHandle = {
      async extractPieceMetadata() {
        await new Promise((r) => setTimeout(r, 200));
        return { name: "@scope/piece-slow" };
      },
      async release() { /* noop */ },
    } as unknown as EngineHandle;
    const fakeRuntime = { acquire: async () => fakeHandle } as unknown as EngineRuntime;
    try {
      const { catalog, failures } = await buildPieceCatalog({
        runtime: fakeRuntime,
        pieceRoots: [root],
        pieceTimeoutMs: 25,
        reporter: () => {},
      });
      expect(catalog.list().length).toBe(0);
      expect(failures.length).toBe(1);
      expect(failures[0]?.reason).toContain("timed out");
    } finally {
      cleanup();
    }
  });

  test("buildPieceCatalog skips remaining pieces once the overall deadline is exceeded", async () => {
    const { path: root, cleanup } = tmp("build-overall");
    for (const sub of ["a", "b", "c"]) {
      mkdirSync(resolve(root, sub), { recursive: true });
      writeFileSync(
        resolve(root, sub, "package.json"),
        JSON.stringify({ name: `@scope/piece-${sub}`, version: "0.0.1" }),
      );
    }
    let calls = 0;
    const fakeHandle = {
      async extractPieceMetadata(o: { pieceName: string }) {
        calls++;
        await new Promise((r) => setTimeout(r, 80));
        return { name: o.pieceName };
      },
      async release() { /* noop */ },
    } as unknown as EngineHandle;
    const fakeRuntime = { acquire: async () => fakeHandle } as unknown as EngineRuntime;
    try {
      const { catalog, failures } = await buildPieceCatalog({
        runtime: fakeRuntime,
        pieceRoots: [root],
        pieceTimeoutMs: 1_000,
        overallTimeoutMs: 100,
        reporter: () => {},
      });
      // First piece extracts; deadline exceeded before the rest run.
      expect(catalog.list().length + failures.length).toBe(3);
      expect(catalog.list().length).toBeLessThan(3);
      expect(failures.some((f) => f.reason.includes("overall extraction deadline"))).toBe(true);
      expect(calls).toBeLessThan(3);
    } finally {
      cleanup();
    }
  });

  test("buildPieceCatalog does NOT write the cache file when failures are present", async () => {
    const { path: root, cleanup: cleanupRoot } = tmp("build-no-cache-on-fail");
    const { path: cacheDir, cleanup: cleanupCache } = tmp("cache-no-write");
    const cacheFile = resolve(cacheDir, "cache.json");
    mkdirSync(resolve(root, "bad"), { recursive: true });
    writeFileSync(
      resolve(root, "bad/package.json"),
      JSON.stringify({ name: "@scope/piece-bad", version: "0.0.1" }),
    );
    const fakeHandle = {
      async extractPieceMetadata() { throw new Error("boom"); },
      async release() {},
    } as unknown as EngineHandle;
    const fakeRuntime = { acquire: async () => fakeHandle } as unknown as EngineRuntime;
    try {
      await buildPieceCatalog({
        runtime: fakeRuntime,
        pieceRoots: [root],
        cacheFile,
        cacheKey: "v1",
        reporter: () => {},
      });
      // No cache file written -- failures should force a rebuild next boot.
      expect(existsSync(cacheFile)).toBe(false);
    } finally {
      cleanupRoot();
      cleanupCache();
    }
  });

  test("JarvisPieceRegistry structurally satisfies the PieceLookup interface", () => {
    // Compile-time + runtime check: assigning a JarvisPieceRegistry instance
    // to a PieceLookup variable must succeed, and calling list/get on it must
    // return shape-compatible values. Catches a regression if PieceLookup
    // tightens later (e.g., a required field is added).
    const reg = new JarvisPieceRegistry();
    reg.register({
      name: "p",
      displayName: "P",
      description: "p",
      actions: {
        a: {
          name: "a",
          displayName: "A",
          description: "",
          parseInput: (raw) => raw,
          execute: async () => ({}),
        },
      },
    });
    const lookup: PieceLookup = reg;
    const list = lookup.list();
    expect(list.length).toBe(1);
    expect(list[0]?.name).toBe("p");
    expect(list[0]?.actions["a"]?.displayName).toBe("A");
    expect(lookup.get("p")?.name).toBe("p");
    expect(lookup.get("missing")).toBeNull();
  });
});

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const initialCached = findCachedBundle();
const skipEngineTests =
  initialCached === null && !buildOptIn;
const piecesAlreadyBuilt = existsSync(
  resolve(
    ENGINE_BUILD_PATHS.VENDOR_PACKAGES,
    "pieces/jarvis/test/dist/src/index.js",
  ),
);
const skipE2eTests = skipEngineTests || (!piecesAlreadyBuilt && !buildOptIn);

describe("PieceCatalog (engine end-to-end)", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;

  beforeAll(async () => {
    api = new SandboxApi({
      services: { credentialResolver: new CredentialResolver() },
    });
    await api.start({ port: 0 });

    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    if (!piecesAlreadyBuilt && buildOptIn) await buildAllJarvisPieces();
    runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath });
  });

  afterAll(async () => {
    await api.stop();
  });

  test.skipIf(skipE2eTests)(
    "extracts metadata for every Jarvis-native piece via the real engine",
    async () => {
      const root = resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis");
      const { path: cacheDir, cleanup } = tmp("piece-catalog-e2e");
      const cacheFile = resolve(cacheDir, "cache.json");
      try {
        const { catalog, failures } = await buildPieceCatalog({
          runtime: runtime!,
          pieceRoots: [root],
          cacheFile,
          cacheKey: "test-v1",
          reporter: () => {},
        });
        expect(failures).toEqual([]);
        const names = catalog.list().map((e) => e.name).sort();
        expect(names).toContain("@jarvispieces/piece-jarvis-ask");
        expect(names).toContain("@jarvispieces/piece-jarvis-tool");
        expect(names).toContain("@jarvispieces/piece-jarvis-notify");
        expect(names).toContain("@jarvispieces/piece-jarvis-context");
        expect(names).toContain("@jarvispieces/piece-jarvis-agent");
        expect(names).toContain("@jarvispieces/piece-jarvis-trigger");
        expect(names).toContain("@jarvispieces/piece-jarvis-test");
        // ask: single action `ask` with at least the `prompt` field.
        const ask = catalog.get("@jarvispieces/piece-jarvis-ask");
        expect(ask?.actions["ask"]?.inputSchema?.fields.find((f) => f.name === "prompt")?.required).toBe(true);
        // trigger: piece has both an action and a trigger.
        const trigger = catalog.get("@jarvispieces/piece-jarvis-trigger");
        expect(Object.keys(trigger?.triggers ?? {})).toContain("on_event");
        expect(Object.keys(trigger?.actions ?? {})).toContain("run_workflow");
        // Cache file written + readable on second build (no engine spawn).
        const second = await buildPieceCatalog({
          runtime: runtime!,
          pieceRoots: [root],
          cacheFile,
          cacheKey: "test-v1",
          reporter: () => {},
        });
        expect(second.catalog.list().length).toBe(catalog.list().length);
      } finally {
        cleanup();
      }
    },
    60_000,
  );
});
