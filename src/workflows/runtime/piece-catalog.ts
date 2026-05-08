/**
 * `PieceCatalog` -- canonical view of installed pieces (Jarvis-native + future
 * community vendored). Built once at daemon startup by spawning the engine
 * subprocess, sending EXTRACT_PIECE_METADATA for each discovered piece, and
 * caching the result keyed by the engine bundle's content hash + each piece
 * source's content hash (so a piece edit followed by a build invalidates the
 * cache even if the engine bundle is unchanged).
 *
 * The catalog presents a structural shape compatible with the legacy
 * `JarvisPieceRegistry` (`{name, displayName, description, actions, triggers}`
 * with `inputSchema` per action/trigger) so the dashboard editor and the
 * NL-composer prompt builder can consume either source without surface-level
 * branching. Both sources satisfy the `PieceLookup` interface declared
 * below.
 *
 * Until Phase K wires the engine into the daemon bootstrap proper, the
 * catalog is built on demand by callers that have an `EngineRuntime` in
 * hand (typically the daemon's startup). Tests can construct a catalog
 * directly from a list of `PieceCatalogEntry`.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { EngineRuntime } from "../runner/engine-runtime/engine-runtime";
import { DEFAULT_IDS } from "../db/schema";
import { SandboxRegistry } from "../sandbox-api/sandbox-registry";
import type {
  PieceInputField,
  PieceInputSchema,
  PieceInputType,
} from "./piece-input";

export type { PieceInputField, PieceInputSchema, PieceInputType } from "./piece-input";

export interface PieceCatalogAction {
  name: string;
  displayName: string;
  description: string;
  inputSchema?: PieceInputSchema;
}

export type PieceCatalogTrigger = PieceCatalogAction;

export interface PieceCatalogEntry {
  /** Upstream package name -- e.g. `@jarvispieces/piece-jarvis-ask`. */
  name: string;
  displayName: string;
  description: string;
  actions: Record<string, PieceCatalogAction>;
  triggers?: Record<string, PieceCatalogTrigger>;
}

/**
 * Structural interface that both `PieceCatalog` and `JarvisPieceRegistry`
 * satisfy. Consumers (composer, workflow routes) take this so either source
 * works without further branching.
 */
export interface PieceLookup {
  list(): PieceCatalogEntry[];
  get(name: string): PieceCatalogEntry | null;
}

export class PieceCatalog implements PieceLookup {
  private readonly entries: Map<string, PieceCatalogEntry>;

  constructor(initial: PieceCatalogEntry[]) {
    this.entries = new Map();
    for (const e of initial) this.entries.set(e.name, e);
  }

  list(): PieceCatalogEntry[] {
    return Array.from(this.entries.values());
  }

  get(name: string): PieceCatalogEntry | null {
    return this.entries.get(name) ?? null;
  }
}

interface PieceDiscoveryEntry {
  name: string;
  version: string;
  dir: string;
}

/**
 * Walk each root directory and return its direct subdirs that have a
 * `package.json` with `name` + `version`. Order is alphabetical by piece
 * directory name, deterministic across runs.
 *
 * Dedupes by `name` across multiple roots: if the same piece name appears in
 * two roots (e.g., a half-migrated state where the old and new vendor trees
 * coexist), the first occurrence wins and the conflict is reported on the
 * returned `conflicts[]` so the caller can warn the user.
 */
export function discoverPieces(rootDirs: string[]): {
  entries: PieceDiscoveryEntry[];
  conflicts: Array<{ name: string; kept: string; dropped: string }>;
} {
  const entries: PieceDiscoveryEntry[] = [];
  const conflicts: Array<{ name: string; kept: string; dropped: string }> = [];
  const seen = new Map<string, PieceDiscoveryEntry>();
  for (const root of rootDirs) {
    if (!existsSync(root)) continue;
    for (const sub of readdirSync(root).sort()) {
      const dir = resolve(root, sub);
      let s;
      try {
        s = statSync(dir);
      } catch {
        continue;
      }
      if (!s.isDirectory()) continue;
      const pkgPath = resolve(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      let pkg: { name?: unknown; version?: unknown };
      try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      } catch {
        continue;
      }
      if (typeof pkg.name !== "string" || typeof pkg.version !== "string") continue;
      const existing = seen.get(pkg.name);
      if (existing) {
        conflicts.push({ name: pkg.name, kept: existing.dir, dropped: dir });
        continue;
      }
      const entry = { name: pkg.name, version: pkg.version, dir };
      seen.set(pkg.name, entry);
      entries.push(entry);
    }
  }
  return { entries, conflicts };
}

/**
 * Build a deterministic cache-invalidation key from the engine bundle and
 * every piece's compiled `dist/src/index.js`. An edit to any of those forces
 * a catalog rebuild even when the engine bundle is unchanged.
 *
 * We hash content (not mtime+size) because mtime resolution on common
 * filesystems is too coarse to detect successive writes within ~1ms (e.g.
 * dev loops where you edit and rebuild back-to-back, or tests). Reading and
 * hashing each bundle is O(bytes) but only happens at daemon startup and
 * cache-rebuild time -- the on-disk catalog cache absorbs the cost across
 * subsequent boots.
 */
export function computeCatalogCacheKey(opts: {
  bundlePath: string;
  pieceRoots: string[];
}): string {
  const h = createHash("sha256");
  h.update("bundle\0");
  hashFileContents(h, opts.bundlePath);
  const { entries } = discoverPieces(opts.pieceRoots);
  for (const e of entries) {
    h.update(`piece\0${e.name}\0${e.version}\0`);
    hashFileContents(h, resolve(e.dir, "dist/src/index.js"));
  }
  return h.digest("hex");
}

function hashFileContents(h: import("node:crypto").Hash, path: string): void {
  if (!existsSync(path)) {
    h.update("absent\n");
    return;
  }
  const buf = readFileSync(path);
  h.update(buf);
  h.update("\n");
}

/**
 * Per-extraction failure surfaced from `buildPieceCatalog`. The catalog still
 * boots with whichever pieces succeeded; failures are logged and returned so
 * the daemon can surface them in dashboards / logs.
 */
export interface PieceExtractionFailure {
  pieceName: string;
  pieceVersion: string;
  reason: string;
}

export interface BuildCatalogOptions {
  runtime: EngineRuntime;
  /**
   * Directories to scan for pieces. Each direct subdirectory with a
   * `package.json` is treated as one piece.
   */
  pieceRoots: string[];
  /**
   * Path to the on-disk cache file. When set together with `cacheKey`, the
   * builder reads from this file if `cacheKey` matches; on miss it extracts
   * fresh and writes back. Default: no caching.
   */
  cacheFile?: string;
  /**
   * Cache invalidation key -- typically `computeCatalogCacheKey({...})`.
   * Stored alongside the cached entries; mismatch forces a rebuild.
   */
  cacheKey?: string;
  /** projectId for the synthetic extraction sandbox. Default: DEFAULT_IDS.project. */
  projectId?: string;
  /**
   * Per-piece extraction deadline in ms. A piece that exceeds this is logged
   * as a failure and skipped; the rest of the catalog still builds. Default
   * 10 000 ms.
   */
  pieceTimeoutMs?: number;
  /**
   * Overall build deadline in ms. Once exceeded, no further pieces are
   * extracted; partial results are returned. Default 60 000 ms.
   */
  overallTimeoutMs?: number;
  /**
   * Optional reporter for `discoverPieces` conflicts and per-piece extraction
   * failures. Defaults to `console.warn`. Pass a noop in tests.
   */
  reporter?: (msg: string) => void;
}

export interface BuildCatalogResult {
  catalog: PieceCatalog;
  failures: PieceExtractionFailure[];
}

export interface CacheFileShape {
  cacheKey: string;
  entries: PieceCatalogEntry[];
}

/**
 * Read the cache file if `cacheKey` matches; otherwise return null. Exposed
 * separately from the full builder for tests + readability.
 */
export function readCachedCatalog(
  cacheFile: string,
  cacheKey: string,
): PieceCatalog | null {
  if (!existsSync(cacheFile)) return null;
  let cached: CacheFileShape;
  try {
    cached = JSON.parse(readFileSync(cacheFile, "utf8")) as CacheFileShape;
  } catch {
    return null;
  }
  if (cached.cacheKey !== cacheKey || !Array.isArray(cached.entries)) return null;
  return new PieceCatalog(cached.entries);
}

/**
 * Spawn an engine subprocess, run EXTRACT_PIECE_METADATA for each discovered
 * piece (with a per-piece + overall deadline), write the cache, and return a
 * `{catalog, failures}` pair. Idempotent: if a matching cache already exists,
 * no engine spawn happens and `failures` is empty.
 *
 * Per-piece failures (timeout, engine error, extraction throw) are caught,
 * logged via `reporter`, and surfaced on `failures[]`. The catalog still
 * boots with whichever pieces succeeded; the daemon can log/UI-display the
 * failures without blocking startup.
 */
export async function buildPieceCatalog(
  opts: BuildCatalogOptions,
): Promise<BuildCatalogResult> {
  const reporter = opts.reporter ?? ((m) => console.warn(`[piece-catalog] ${m}`));
  const pieceTimeoutMs = opts.pieceTimeoutMs ?? 10_000;
  const overallTimeoutMs = opts.overallTimeoutMs ?? 60_000;

  if (opts.cacheFile && opts.cacheKey) {
    const fromCache = readCachedCatalog(opts.cacheFile, opts.cacheKey);
    if (fromCache) return { catalog: fromCache, failures: [] };
  }

  const { entries: discovered, conflicts } = discoverPieces(opts.pieceRoots);
  for (const c of conflicts) {
    reporter(
      `duplicate piece "${c.name}": kept ${c.kept}, dropped ${c.dropped}`,
    );
  }

  const projectId = opts.projectId ?? DEFAULT_IDS.project;
  const runId = "metadata-extract-" + SandboxRegistry.newSandboxId();

  const handle = await opts.runtime.acquire({ runId, projectId });
  const out: PieceCatalogEntry[] = [];
  const failures: PieceExtractionFailure[] = [];
  const overallDeadline = Date.now() + overallTimeoutMs;
  try {
    for (const piece of discovered) {
      if (Date.now() > overallDeadline) {
        const pending = discovered.length - out.length - failures.length;
        if (pending > 0) {
          reporter(
            `overall extraction deadline (${overallTimeoutMs}ms) exceeded; ${pending} piece(s) skipped`,
          );
          for (const skipped of discovered.slice(out.length + failures.length)) {
            failures.push({
              pieceName: skipped.name,
              pieceVersion: skipped.version,
              reason: "overall extraction deadline exceeded",
            });
          }
        }
        break;
      }
      try {
        const meta = await withTimeout(
          handle.extractPieceMetadata({
            pieceName: piece.name,
            pieceVersion: piece.version,
          }),
          pieceTimeoutMs,
          `extract ${piece.name}@${piece.version} timed out after ${pieceTimeoutMs}ms`,
        );
        out.push(metadataToCatalogEntry(meta));
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        failures.push({
          pieceName: piece.name,
          pieceVersion: piece.version,
          reason,
        });
        reporter(`extract ${piece.name}@${piece.version} failed: ${reason}`);
      }
    }
  } finally {
    await handle.release();
  }

  if (opts.cacheFile && opts.cacheKey && failures.length === 0) {
    mkdirSync(dirname(opts.cacheFile), { recursive: true });
    const payload: CacheFileShape = { cacheKey: opts.cacheKey, entries: out };
    writeFileSync(opts.cacheFile, JSON.stringify(payload, null, 2) + "\n");
  }
  return { catalog: new PieceCatalog(out), failures };
}

/** Race a promise against a timeout; rejects with `message` on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ]);
}

/* -------------------- conversion: upstream -> legacy shape ----------------- */

/**
 * Loose structural shape for upstream's `PieceMetadata`. We avoid the upstream
 * type directly because pulling it drags in zod runtime + auth/i18n surfaces
 * we don't need; the shape below is what we actually consume.
 */
export interface RawPieceMetadata {
  name?: string;
  displayName?: string;
  description?: string;
  actions?: Record<string, RawActionOrTrigger>;
  triggers?: Record<string, RawActionOrTrigger>;
}

export interface RawActionOrTrigger {
  name?: string;
  displayName?: string;
  description?: string;
  props?: Record<string, RawProp>;
}

export interface RawProp {
  type?: string;
  displayName?: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: unknown;
  options?: { options?: Array<{ value: unknown; label?: string; description?: string }> };
}

/** Convert an upstream `PieceMetadata` blob into the legacy `JarvisPiece`-style entry. */
export function metadataToCatalogEntry(meta: RawPieceMetadata | unknown): PieceCatalogEntry {
  const m = (meta ?? {}) as RawPieceMetadata;
  const name = typeof m.name === "string" ? m.name : "";
  const displayName = typeof m.displayName === "string" ? m.displayName : name;
  const description = typeof m.description === "string" ? m.description : "";
  const actions: Record<string, PieceCatalogAction> = {};
  if (m.actions) {
    for (const [key, raw] of Object.entries(m.actions)) {
      actions[key] = rawActionToCatalogAction(key, raw);
    }
  }
  const out: PieceCatalogEntry = { name, displayName, description, actions };
  if (m.triggers) {
    const triggers: Record<string, PieceCatalogTrigger> = {};
    for (const [key, raw] of Object.entries(m.triggers)) {
      triggers[key] = rawActionToCatalogAction(key, raw);
    }
    out.triggers = triggers;
  }
  return out;
}

function rawActionToCatalogAction(
  fallbackName: string,
  raw: RawActionOrTrigger,
): PieceCatalogAction {
  const out: PieceCatalogAction = {
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : fallbackName,
    displayName: typeof raw.displayName === "string" ? raw.displayName : fallbackName,
    description: typeof raw.description === "string" ? raw.description : "",
  };
  if (raw.props) {
    out.inputSchema = propsToInputSchema(raw.props);
  }
  return out;
}

/** Map upstream `PiecePropertyMap` -> legacy `PieceInputSchema`. */
export function propsToInputSchema(
  props: Record<string, RawProp>,
): PieceInputSchema {
  const fields: PieceInputField[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const mapped = mapProp(name, prop);
    if (mapped) fields.push(mapped);
  }
  return { fields };
}

function mapProp(name: string, prop: RawProp): PieceInputField | null {
  const type = mapPropType(prop.type);
  if (type === null) return null; // auth fields, markdown -- not user inputs
  const out: PieceInputField = {
    name,
    label:
      typeof prop.displayName === "string" && prop.displayName.length > 0
        ? prop.displayName
        : name,
    type,
    required: prop.required === true,
  };
  if (typeof prop.description === "string" && prop.description.length > 0) {
    out.description = prop.description;
  }
  if (typeof prop.placeholder === "string" && prop.placeholder.length > 0) {
    out.placeholder = prop.placeholder;
  }
  if (prop.defaultValue !== undefined) out.default = prop.defaultValue;
  if (
    (type === "enum" || type === "multi_enum") &&
    prop.options &&
    Array.isArray(prop.options.options)
  ) {
    const opts: Array<{ value: string; label: string; description?: string }> = [];
    for (const o of prop.options.options) {
      if (o == null) continue;
      const value =
        typeof o.value === "string" || typeof o.value === "number" || typeof o.value === "boolean"
          ? String(o.value)
          : "";
      if (value.length === 0) continue;
      const opt: { value: string; label: string; description?: string } = {
        value,
        label: typeof o.label === "string" ? o.label : value,
      };
      if (typeof o.description === "string" && o.description.length > 0) opt.description = o.description;
      opts.push(opt);
    }
    if (opts.length > 0) out.options = opts;
  }
  return out;
}

/**
 * Map an upstream `PropertyType` to our `PieceInputType`. Returns `null` for
 * properties that aren't user-fillable inputs (auth, markdown display blocks)
 * so the caller drops them from the schema.
 */
function mapPropType(t: string | undefined): PieceInputType | null {
  switch (t) {
    case "SHORT_TEXT":
    case "COLOR":
      return "string";
    case "DATE_TIME":
      return "datetime";
    case "LONG_TEXT":
      return "long_text";
    case "NUMBER":
      return "number";
    case "CHECKBOX":
      return "boolean";
    case "STATIC_DROPDOWN":
    case "DROPDOWN":
      return "enum";
    case "STATIC_MULTI_SELECT_DROPDOWN":
    case "MULTI_SELECT_DROPDOWN":
      return "multi_enum";
    case "JSON":
    case "OBJECT":
    case "ARRAY":
    case "FILE":
    case "DYNAMIC":
    case "CUSTOM":
      return "json";
    case "MARKDOWN":
    case "OAUTH2":
    case "SECRET_TEXT":
    case "BASIC_AUTH":
    case "CUSTOM_AUTH":
      return null;
    default:
      // Unknown type -- accept as raw JSON so the field still exists in the
      // catalog and the dashboard can render a fallback editor.
      return "json";
  }
}
