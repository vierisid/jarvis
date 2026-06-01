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
import { WORKFLOW_EVENT_TYPES } from "./event-types";

export type { PieceInputField, PieceInputSchema, PieceInputType } from "./piece-input";

/**
 * Piece-name + trigger-name pair for jarvis-trigger:on_event. Hoisted so
 * the dynamic-sample injector and the composer prompt agree on the key.
 */
export const JARVIS_ON_EVENT_TRIGGER = {
  piece: "@jarvispieces/piece-jarvis-trigger",
  trigger: "on_event",
} as const;

export interface PieceCatalogAction {
  name: string;
  displayName: string;
  description: string;
  inputSchema?: PieceInputSchema;
  /**
   * Optional declared output sample: the same JSON shape the action returns
   * on a successful run. Surfaced by the piece author via
   * `createAction({ outputSample: ... })` (Jarvis extension to upstream AP).
   * The visual editor's variable picker falls back to this when no captured
   * sample data exists for the step. Leave undefined for dynamic-output
   * actions (HTTP request, SQL, LLM with parseJson).
   */
  outputSample?: unknown;
}

export interface PieceCatalogTrigger extends PieceCatalogAction {
  /**
   * Triggers declare their sample shape natively in upstream AP via
   * `createTrigger({ sampleData })`. The catalog surfaces it under the same
   * name. Independent of `outputSample` so we don't lose either source
   * during a round-trip.
   */
  sampleData?: unknown;
  /**
   * Output sample varies with a single input property. Some triggers
   * have an envelope whose effective shape depends on a config value:
   * jarvis-trigger `on_event` is the canonical case (the `payload`
   * sub-object changes structure with the `eventType` prop). The picker
   * and the composer prompt read this to surface the right shape per
   * configured value instead of a single static example.
   *
   * `propName` is the input prop whose value selects a sample;
   * `samples` maps each known value to the matching full output sample
   * (envelope included, not just the variable part). Falls back to
   * `sampleData` when the prop is unset or its value isn't in the map.
   *
   * KNOWN LIMITATIONS (worth knowing before extending):
   *   - Single-prop conditional only. A trigger whose shape depends on
   *     `(secret, eventName)` cannot be expressed with this field; the
   *     shape would need to grow to `propNames: string[]` + a nested
   *     `samples` table keyed on the JSON-stringified value tuple. Not
   *     a refactor to do speculatively -- wait for a real case.
   *   - One-level discrimination. The selector key is the raw input
   *     value; no expression evaluation, no computed selectors. If a
   *     piece needs "this shape when prop value matches a regex," it
   *     doesn't belong here.
   *   - String selector values only. Picker / composer compare with
   *     `===` against `step.settings.input[propName]`; non-string
   *     prop values fall through to `sampleData`.
   */
  dynamicSampleData?: {
    propName: string;
    samples: Record<string, unknown>;
  };
}

/**
 * Piece-level auth declaration, surfaced through the catalog so the
 * editor can render a connection picker. Activepieces declares this at
 * the top of `createPiece({ auth: ... })`; pieces without it (CODE,
 * jarvis-ask, schedule) leave it undefined and the editor renders no
 * picker. We collapse the upstream `PieceAuthProperty` variants into
 * the small surface the editor actually needs: the auth type (so the
 * editor can label the field, e.g. "OAuth connection" vs "API token")
 * and an optional description (passed verbatim from the piece).
 */
export interface PieceCatalogAuth {
  /**
   * Wire type. Mirrors AP's `AppConnectionType`:
   *   OAUTH2 / PLATFORM_OAUTH2 / CLOUD_OAUTH2 -- OAuth flow
   *   SECRET_TEXT                              -- single API token / API key
   *   BASIC_AUTH                               -- username + password pair
   *   CUSTOM_AUTH                              -- arbitrary key/value bag (gmail SMTP, etc.)
   */
  type: "OAUTH2" | "PLATFORM_OAUTH2" | "CLOUD_OAUTH2" | "SECRET_TEXT" | "BASIC_AUTH" | "CUSTOM_AUTH";
  /** Optional human-readable description of what the connection does. */
  description?: string;
  /**
   * Display name of the auth field as the piece author wrote it. The
   * editor shows this as the picker label so the user can match a
   * connection to the right piece-side concept (e.g. "Google account",
   * "Bot token").
   */
  displayName?: string;
}

export interface PieceCatalogEntry {
  /** Upstream package name -- e.g. `@jarvispieces/piece-jarvis-ask`. */
  name: string;
  displayName: string;
  description: string;
  actions: Record<string, PieceCatalogAction>;
  triggers?: Record<string, PieceCatalogTrigger>;
  /**
   * Piece-level auth declaration. Present when the piece requires a
   * connection (most third-party integrations -- gmail, slack,
   * telegram-bot, github). Absent for pieces that don't need auth
   * (jarvis-ask, schedule, webhook, code).
   */
  auth?: PieceCatalogAuth;
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

  /**
   * Insert or replace a single piece. Used after a runtime install (the user
   * clicked Install in the Library tab) so the new piece becomes available
   * in the flow editor without a daemon restart.
   */
  upsert(entry: PieceCatalogEntry): void {
    this.entries.set(entry.name, entry);
  }

  /**
   * Drop a piece from the catalog. Used after a runtime uninstall. Returns
   * true if the piece was present.
   */
  remove(name: string): boolean {
    return this.entries.delete(name);
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
      // Filter out non-piece packages that land in the same scoped dir.
      // When users install a community piece (gmail, slack, ...) via the
      // Library tab, bun also writes @activepieces/{shared,pieces-common,
      // pieces-framework} into the same @activepieces/ folder. Without
      // this filter, those would be treated as pieces and the engine would
      // log INTERNAL_ERROR for each at every bootstrap. Convention: real
      // pieces' npm names follow `<scope>/piece-<id>`.
      if (!/(^|\/)piece-[a-z0-9][a-z0-9-]*$/.test(pkg.name)) continue;
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
/**
 * Catalog projection schema version. Mixed into the cache key so any
 * daemon-side change to the projected `PieceCatalogEntry` shape (new
 * fields, reshaped existing fields, anything that `metadataToCatalogEntry`
 * starts emitting differently) invalidates every existing on-disk cache.
 *
 * Why this is necessary: the rest of the cache key only hashes the engine
 * bundle + each piece's compiled `dist/src/index.js`. The projection layer
 * itself is daemon code; editing it without bumping this constant would
 * leave every upgraded install silently serving the OLD projected shape
 * until something forced a piece rebuild.
 *
 * BUMP THIS when you change `metadataToCatalogEntry` in a way that adds,
 * removes, renames, or reshapes any field the editor / composer consumes.
 *
 * History:
 *   v1 -- initial projection.
 *   v2 -- added `auth` to PieceCatalogEntry.
 *   v3 -- added `dynamicSampleData` to PieceCatalogTrigger (envelope
 *         resolution for jarvis-trigger:on_event).
 *   v4 -- promoted jarvis-trigger:on_event's `eventType` input field
 *         from free-text string to enum (options sourced from
 *         WORKFLOW_EVENT_TYPES at projection time).
 *   v5 -- added `group` to enum options (used by the editor's <select>
 *         to render <optgroup> sections for the on_event eventType
 *         dropdown).
 *   v6 -- promoted jarvis-trigger:run_workflow's `flow` input from
 *         `string` to `flow_ref`. Replaces the old flowId+flowName
 *         pair on the piece source. Editor renders flow_ref as a
 *         searchable workflow picker.
 */
export const CATALOG_SCHEMA_VERSION = "6";

export function computeCatalogCacheKey(opts: {
  bundlePath: string;
  pieceRoots: string[];
}): string {
  const h = createHash("sha256");
  h.update(`schema\0${CATALOG_SCHEMA_VERSION}\0`);
  h.update("bundle\0");
  hashFileContents(h, opts.bundlePath);
  const { entries } = discoverPieces(opts.pieceRoots);
  for (const e of entries) {
    h.update(`piece\0${e.name}\0${e.version}\0`);
    hashFileContents(h, resolve(e.dir, "dist/src/index.js"));
  }
  // Mix in the event-type registry so adding/removing an entry in
  // `WORKFLOW_EVENT_TYPES` invalidates caches automatically. The
  // jarvis-trigger:on_event projection synthesizes its
  // `dynamicSampleData` from this registry, so a registry edit IS a
  // projected-shape edit even though no piece source changed.
  //
  // Canonicalize by sorting on `type` before hashing so a reorder of
  // the registry (e.g. alphabetizing the source file) doesn't bust
  // the cache when the projected content didn't actually change. The
  // projection itself iterates `WORKFLOW_EVENT_TYPES` in declared
  // order, but that order is invisible to consumers (picker groups
  // alphabetically inside its <optgroup>s; composer prompt just lists
  // entries) so cache equivalence by content beats equivalence by
  // declared order.
  h.update("event-types\0");
  h.update(
    JSON.stringify(
      [...WORKFLOW_EVENT_TYPES].sort((a, b) => a.type.localeCompare(b.type)),
    ),
  );
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

  // Cache write policy: persist the successful entries even when some
  // pieces failed. A single broken community piece used to block the
  // entire cache write, which meant every daemon restart re-spawned
  // the engine + re-extracted every piece (~2-3s) until the broken
  // one was uninstalled. The catalog endpoint already returns only
  // successes (failures are surfaced via the daemon log + audit
  // script), so persisting the partial set is strictly better than
  // discarding it. We still skip the write when zero pieces succeeded
  // -- there's nothing useful to cache.
  if (opts.cacheFile && opts.cacheKey && out.length > 0) {
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
  /**
   * Top-level piece auth. Activepieces typing on `PieceAuthProperty` is
   * a discriminated union over OAUTH2 / SECRET_TEXT / BASIC_AUTH /
   * CUSTOM_AUTH variants; we read it loosely here and project only the
   * fields the editor needs (`type`, `displayName`, `description`).
   */
  auth?: {
    type?: string;
    displayName?: string;
    description?: string;
  } | null;
}

export interface RawActionOrTrigger {
  name?: string;
  displayName?: string;
  description?: string;
  props?: Record<string, RawProp>;
  /** Triggers carry `sampleData`; our action extension carries `outputSample`. Both optional. */
  sampleData?: unknown;
  outputSample?: unknown;
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
      triggers[key] = rawActionToCatalogAction(key, raw, /* isTrigger */ true);
    }
    out.triggers = triggers;
  }
  // Apply any Jarvis-specific catalog enrichments after the generic
  // projection finishes. Today this covers two upgrades on the
  // jarvis-trigger piece (on_event eventType -> enum, run_workflow
  // flow -> flow_ref). Centralising the gating keeps the generic
  // projection above piece-agnostic and gives the next "Jarvis tweak"
  // a single named home.
  enrichJarvisCatalogEntry(out);
  // Project piece.auth into the catalog's auth shape. We only forward
  // it when the upstream type is one of AppConnectionType's variants;
  // anything else (NO_AUTH, malformed) is treated as "no auth needed."
  // The piece's auth.type comes from upstream's PropertyType -- map it
  // to our AppConnectionType vocabulary so the editor + connection
  // listing share one name space.
  if (m.auth && typeof m.auth === "object" && typeof m.auth.type === "string") {
    const projected = projectAuthType(m.auth.type);
    if (projected) {
      out.auth = {
        type: projected,
        ...(typeof m.auth.displayName === "string" ? { displayName: m.auth.displayName } : {}),
        ...(typeof m.auth.description === "string" ? { description: m.auth.description } : {}),
      };
    }
  }
  return out;
}

/**
 * Apply Jarvis-specific catalog enrichments AFTER the generic
 * projection in `metadataToCatalogEntry`. Each enrichment is gated by
 * piece identity and a defensive presence check on the target action /
 * trigger, so an upstream rename (or a Jarvis-piece source edit that
 * drops a sub-action) silently no-ops rather than crashing the catalog
 * build.
 *
 * The set of enrichments here is small and well-known:
 *   - jarvis-trigger:on_event   -- attach `dynamicSampleData` and
 *                                  promote `eventType` to enum.
 *   - jarvis-trigger:run_workflow -- promote `flow` to flow_ref.
 *
 * To add a new enrichment: add a guarded block here, document the
 * (piece, target) pair, and bump CATALOG_SCHEMA_VERSION so existing
 * on-disk caches re-project.
 */
export function enrichJarvisCatalogEntry(entry: PieceCatalogEntry): void {
  if (entry.name !== JARVIS_ON_EVENT_TRIGGER.piece) return;
  const onEvent = entry.triggers?.[JARVIS_ON_EVENT_TRIGGER.trigger];
  if (onEvent) {
    onEvent.dynamicSampleData = buildOnEventDynamicSampleData();
    upgradeOnEventEventTypeFieldToEnum(onEvent);
  }
  const runWorkflow = entry.actions["run_workflow"];
  if (runWorkflow) {
    upgradeRunWorkflowFlowFieldToFlowRef(runWorkflow);
  }
}

/**
 * Build the `dynamicSampleData` map for jarvis-trigger:on_event. Each
 * entry surfaces the full envelope the trigger emits when configured for
 * that event type -- not just the payload -- so consumers (variable
 * picker, composer prompt) get an output sample they can wire from
 * verbatim without splicing the envelope themselves.
 *
 * Sourced from `WORKFLOW_EVENT_TYPES` so adding a new event type lights
 * up everywhere automatically: add it to the registry, restart the
 * daemon, the picker and the composer both see it.
 */
export function buildOnEventDynamicSampleData(): {
  propName: string;
  samples: Record<string, unknown>;
} {
  const samples: Record<string, unknown> = {};
  for (const meta of WORKFLOW_EVENT_TYPES) {
    samples[meta.type] = {
      id: "evt_sample",
      eventType: meta.type,
      payload: meta.payloadExample ?? {},
      timestamp: 0,
    };
  }
  return { propName: "eventType", samples };
}

/**
 * Rewrite the `eventType` input field on the on_event trigger from a
 * free-text string into an enum populated from `WORKFLOW_EVENT_TYPES`.
 * In-place so the surrounding projection treats the trigger entry
 * normally.
 *
 * Resilient to schema drift: if the trigger has no `inputSchema`, no
 * `fields` array, or no `eventType` field at all (which would mean the
 * piece source was renamed without updating this projection), we leave
 * the schema untouched and let the field stay free-text. Better to ship
 * a slightly worse UX than to silently drop a required field.
 */
function upgradeOnEventEventTypeFieldToEnum(trigger: PieceCatalogTrigger): void {
  const fields = trigger.inputSchema?.fields;
  if (!fields) return;
  const eventTypeField = fields.find((f) => f.name === "eventType");
  if (!eventTypeField) return;
  eventTypeField.type = "enum";
  eventTypeField.options = WORKFLOW_EVENT_TYPES.map((meta) => ({
    value: meta.type,
    // Canonical id as the label too: the LLM composer and downstream
    // pieces match on the exact string, so showing it verbatim avoids
    // any user confusion about "what do I write here." The description
    // is surfaced as a hover tooltip via the editor's <option title>.
    label: meta.type,
    description: meta.description,
    // Group by the source segment of the canonical id
    // (`observer.clipboard_changed` -> `observer`) so the editor's
    // <select> can render <optgroup> headers and stay scannable as
    // the registry grows.
    group: meta.type.includes(".") ? meta.type.slice(0, meta.type.indexOf(".")) : undefined,
  }));
}

/**
 * Rewrite the `flow` input field on jarvis-trigger's `run_workflow`
 * action from a plain string to `flow_ref`. The editor renders
 * `flow_ref` as a searchable popover backed by `/api/workflows`, so the
 * user picks from a list of their workflows by display name instead of
 * having to remember and type a flow id.
 *
 * Same resilience as the on_event enum upgrade: no-op if the input
 * schema or the `flow` field is missing (defensive against future
 * piece-source renames).
 */
function upgradeRunWorkflowFlowFieldToFlowRef(action: PieceCatalogAction): void {
  const fields = action.inputSchema?.fields;
  if (!fields) return;
  const flowField = fields.find((f) => f.name === "flow");
  if (!flowField) return;
  flowField.type = "flow_ref";
}

/**
 * Map upstream's `PropertyType` (which AP uses for piece auth as well
 * as field types) to the `AppConnectionType` vocabulary used by the
 * connections panel + connection store. Returns null for property
 * types that aren't connection-shaped (NO_AUTH, MARKDOWN, etc.).
 */
function projectAuthType(t: string): PieceCatalogAuth["type"] | null {
  switch (t) {
    case "OAUTH2": return "OAUTH2";
    case "PLATFORM_OAUTH2": return "PLATFORM_OAUTH2";
    case "CLOUD_OAUTH2": return "CLOUD_OAUTH2";
    case "SECRET_TEXT": return "SECRET_TEXT";
    case "BASIC_AUTH": return "BASIC_AUTH";
    case "CUSTOM_AUTH": return "CUSTOM_AUTH";
    default: return null;
  }
}

function rawActionToCatalogAction(
  fallbackName: string,
  raw: RawActionOrTrigger,
  isTrigger = false,
): PieceCatalogAction & { sampleData?: unknown } {
  const out: PieceCatalogAction & { sampleData?: unknown } = {
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : fallbackName,
    displayName: typeof raw.displayName === "string" ? raw.displayName : fallbackName,
    description: typeof raw.description === "string" ? raw.description : "",
  };
  if (raw.props) {
    out.inputSchema = propsToInputSchema(raw.props);
  }
  // Carry through declared output samples. Actions use `outputSample`
  // (Jarvis extension); triggers use upstream `sampleData`. Both can be
  // any JSON value -- we don't validate the shape here. Editor consumers
  // skip non-object samples (the variable picker needs top-level keys).
  if (raw.outputSample !== undefined) {
    out.outputSample = raw.outputSample;
  }
  if (isTrigger && raw.sampleData !== undefined) {
    out.sampleData = raw.sampleData;
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
