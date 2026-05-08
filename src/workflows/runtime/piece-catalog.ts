/**
 * `PieceCatalog` -- canonical view of installed pieces (Jarvis-native + future
 * community vendored). Built once at daemon startup by spawning the engine
 * subprocess, sending EXTRACT_PIECE_METADATA for each discovered piece, and
 * caching the result keyed by the engine bundle's content hash.
 *
 * The catalog presents a structural shape compatible with the legacy
 * `JarvisPieceRegistry` (`{name, displayName, description, actions, triggers}`
 * with `inputSchema` per action/trigger) so the dashboard editor and the
 * NL-composer prompt builder can consume either source without surface-level
 * branching. The legacy class instance method is `list/get`; this module
 * mirrors the same.
 *
 * Until Phase K wires the engine into the daemon bootstrap proper, the
 * catalog is built on demand by callers that have an `EngineRuntime` in
 * hand (typically the daemon's startup). Tests can construct a catalog
 * directly from a list of `PieceCatalogEntry`.
 */

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
} from "../jarvis-pieces/types";

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
 */
export function discoverPieces(rootDirs: string[]): PieceDiscoveryEntry[] {
  const out: PieceDiscoveryEntry[] = [];
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
      out.push({ name: pkg.name, version: pkg.version, dir });
    }
  }
  return out;
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
   * Cache invalidation key -- typically the engine bundle's content hash.
   * Stored alongside the cached entries; mismatch forces a rebuild.
   */
  cacheKey?: string;
  /** projectId for the synthetic extraction sandbox. Default: DEFAULT_IDS.project. */
  projectId?: string;
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
 * piece, write the cache, and return a `PieceCatalog`. Idempotent: if a
 * matching cache already exists, no engine spawn happens.
 */
export async function buildPieceCatalog(
  opts: BuildCatalogOptions,
): Promise<PieceCatalog> {
  if (opts.cacheFile && opts.cacheKey) {
    const fromCache = readCachedCatalog(opts.cacheFile, opts.cacheKey);
    if (fromCache) return fromCache;
  }

  const discovered = discoverPieces(opts.pieceRoots);
  const projectId = opts.projectId ?? DEFAULT_IDS.project;
  const runId = "metadata-extract-" + SandboxRegistry.newSandboxId();

  const handle = await opts.runtime.acquire({ runId, projectId });
  const out: PieceCatalogEntry[] = [];
  try {
    for (const piece of discovered) {
      const meta = await handle.extractPieceMetadata({
        pieceName: piece.name,
        pieceVersion: piece.version,
      });
      out.push(metadataToCatalogEntry(meta));
    }
  } finally {
    await handle.release();
  }

  if (opts.cacheFile && opts.cacheKey) {
    mkdirSync(dirname(opts.cacheFile), { recursive: true });
    const payload: CacheFileShape = { cacheKey: opts.cacheKey, entries: out };
    writeFileSync(opts.cacheFile, JSON.stringify(payload, null, 2) + "\n");
  }
  return new PieceCatalog(out);
}

/* -------------------- conversion: upstream -> legacy shape ----------------- */

interface RawAction {
  name?: string;
  displayName?: string;
  description?: string;
  props?: Record<string, RawProp>;
}

interface RawProp {
  type?: string;
  displayName?: string;
  description?: string;
  required?: boolean;
  defaultValue?: unknown;
  options?: { options?: Array<{ value: unknown; label?: string; description?: string }> };
}

interface RawPiece {
  name?: string;
  displayName?: string;
  description?: string;
  actions?: Record<string, RawAction>;
  triggers?: Record<string, RawAction>;
}

/**
 * Convert an upstream `PieceMetadata` blob into the legacy `JarvisPiece`-style
 * `PieceCatalogEntry`. We intentionally accept `unknown` and downcast --
 * `PieceMetadata` carries large auth/i18n surfaces we don't need; pulling
 * the full type would drag in zod runtime + dependent types.
 */
export function metadataToCatalogEntry(meta: unknown): PieceCatalogEntry {
  const m = (meta ?? {}) as RawPiece;
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
  raw: RawAction,
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
    case "DATE_TIME":
    case "COLOR":
      return "string";
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

