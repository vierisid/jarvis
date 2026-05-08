/**
 * Tests for the PieceCatalog module:
 *   - Unit-level: discovery, metadata-> entry conversion, prop-type mapping,
 *     on-disk cache round-trip with key invalidation.
 *   - Engine-level (gated on JARVIS_TEST_ENGINE_BUILD=1): spawn the real
 *     engine, run EXTRACT_PIECE_METADATA against the seven vendored Jarvis
 *     pieces, assert every piece + every action/trigger is captured.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PieceCatalog,
  buildPieceCatalog,
  discoverPieces,
  metadataToCatalogEntry,
  propsToInputSchema,
  readCachedCatalog,
  type CacheFileShape,
} from "./piece-catalog";
import { CredentialResolver } from "../credentials/adapter";
import { SandboxApi } from "../sandbox-api/server";
import {
  buildEngineBundle,
  ENGINE_BUILD_PATHS,
  findCachedBundle,
} from "../runner/engine-runtime/build";
import { buildAllJarvisPieces } from "../runner/engine-runtime/build-pieces";
import { EngineRuntime } from "../runner/engine-runtime/engine-runtime";

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
          props: { goal: { type: "SHORT_TEXT", required: true, displayName: "Goal" } },
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
    expect(entry.actions["do_thing"]?.inputSchema?.fields[0]?.name).toBe("goal");
    expect(entry.actions["do_thing"]?.inputSchema?.fields[0]?.required).toBe(true);
    expect(entry.triggers?.["on_event"]?.displayName).toBe("On");
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
    expect(byName["a_dt"]?.type).toBe("string");
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

  test("discoverPieces reads name/version from each direct subdir's package.json", () => {
    const root = resolve(process.cwd(), `tmp-test-discover-${Date.now()}`);
    mkdirSync(resolve(root, "alpha"), { recursive: true });
    mkdirSync(resolve(root, "beta"), { recursive: true });
    mkdirSync(resolve(root, "no-pkg"), { recursive: true });
    writeFileSync(
      resolve(root, "alpha/package.json"),
      JSON.stringify({ name: "@scope/alpha", version: "0.0.1" }),
    );
    writeFileSync(
      resolve(root, "beta/package.json"),
      JSON.stringify({ name: "@scope/beta", version: "0.0.2" }),
    );
    try {
      const found = discoverPieces([root]);
      expect(found.length).toBe(2);
      expect(found[0]?.name).toBe("@scope/alpha");
      expect(found[1]?.name).toBe("@scope/beta");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discoverPieces tolerates missing roots and malformed package.json", () => {
    const root = resolve(process.cwd(), `tmp-test-discover-bad-${Date.now()}`);
    mkdirSync(resolve(root, "broken"), { recursive: true });
    writeFileSync(resolve(root, "broken/package.json"), "{not json}");
    try {
      const found = discoverPieces([root, "/does/not/exist"]);
      expect(found).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("readCachedCatalog returns null when cacheKey doesn't match", () => {
    const file = resolve(process.cwd(), `tmp-test-cache-mismatch-${Date.now()}.json`);
    const payload: CacheFileShape = {
      cacheKey: "v1",
      entries: [{ name: "p", displayName: "P", description: "", actions: {} }],
    };
    writeFileSync(file, JSON.stringify(payload));
    try {
      expect(readCachedCatalog(file, "v1")?.list().length).toBe(1);
      expect(readCachedCatalog(file, "v2")).toBeNull();
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("readCachedCatalog returns null when file is missing or malformed", () => {
    expect(readCachedCatalog("/no/such/path", "v1")).toBeNull();
    const file = resolve(process.cwd(), `tmp-test-cache-bad-${Date.now()}.json`);
    writeFileSync(file, "{not json");
    try {
      expect(readCachedCatalog(file, "v1")).toBeNull();
    } finally {
      rmSync(file, { force: true });
    }
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
      const cacheFile = resolve(
        process.cwd(),
        `tmp-test-piece-cache-${Date.now()}.json`,
      );
      try {
        const catalog = await buildPieceCatalog({
          runtime: runtime!,
          pieceRoots: [root],
          cacheFile,
          cacheKey: "test-v1",
        });
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
        // Cache file written + readable.
        const second = await buildPieceCatalog({
          runtime: runtime!,
          pieceRoots: [root],
          cacheFile,
          cacheKey: "test-v1",
        });
        expect(second.list().length).toBe(catalog.list().length);
      } finally {
        rmSync(cacheFile, { force: true });
      }
    },
    60_000,
  );
});
