/**
 * Dynamic piece properties (the HTTP step's Body and Authentication fields,
 * the zip step's Password options) have no fixed shape: the piece decides it
 * from the value of another property. The engine validates and processes such
 * a value against a schema saved on the step (`settings.propertySettings`),
 * and readiness refuses a step that has a value but no saved schema.
 *
 * The editor does not resolve them, so the daemon does. At catalog build the
 * engine resolves each dynamic property of the pieces in
 * DYNAMIC_SCHEMA_PIECES for every value its refreshers can take, and the
 * catalog keeps the results. Every write of a draft then fills the saved
 * schema from that table for the step's current values, so the editor, the
 * composer and the API all get the same stored schema.
 *
 * Only pieces whose dynamic properties read nothing but their sibling values
 * are listed: resolving runs the piece's own code, which for a piece that
 * calls a service needs a connection and a network.
 */
import type { PieceCatalogEntry, PieceLookup, RawActionOrTrigger } from './piece-catalog';
import type { FlowTriggerNode } from '../db/repos/flow-version';
import { walkFlowNodes } from '../db/flow-graph';

export const DYNAMIC_SCHEMA_PIECES: ReadonlySet<string> = new Set([
  '@activepieces/piece-http',
  '@activepieces/piece-file-helper',
  '@activepieces/piece-graphql',
]);

/** One value a refresher can hold: a dropdown option, true/false, or null for "not set". */
export type RefresherValue = string | boolean | null;

export interface DynamicSchemaVariant {
  values: Record<string, RefresherValue>;
  /** The property map the piece declared for those values. */
  schema: Record<string, unknown>;
}

export interface DynamicSchemaTable {
  refreshers: string[];
  variants: DynamicSchemaVariant[];
}

/** Resolving more combinations than this per property is not attempted. */
const MAX_VARIANTS = 32;

interface RawDynamicProp { type?: string; refreshers?: unknown; options?: { options?: Array<{ value?: unknown }> } }

/** Every value a refresher property can hold, or null when it cannot be listed. */
function refresherValues(prop: RawDynamicProp | undefined): RefresherValue[] | null {
  if (!prop) return null;
  if (prop.type === 'CHECKBOX') return [null, false, true];
  if (prop.type !== 'STATIC_DROPDOWN') return null;
  const values: RefresherValue[] = [null];
  for (const option of prop.options?.options ?? []) {
    if (typeof option?.value !== 'string') return null;
    values.push(option.value);
  }
  return values;
}

/** Resolve through `resolve` every dynamic property of one action or trigger. */
export async function resolveDynamicSchemas(
  raw: RawActionOrTrigger,
  resolve: (propertyName: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<Record<string, DynamicSchemaTable> | undefined> {
  const props = (raw.props ?? {}) as Record<string, RawDynamicProp>;
  const out: Record<string, DynamicSchemaTable> = {};
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type !== 'DYNAMIC' || !Array.isArray(prop.refreshers)) continue;
    const refreshers = prop.refreshers.filter((r): r is string => typeof r === 'string');
    const lists = refreshers.map((r) => refresherValues(props[r]));
    if (lists.some((list) => list === null)) continue;
    let combos: Array<Record<string, RefresherValue>> = [{}];
    for (const [i, list] of lists.entries()) {
      combos = combos.flatMap((combo) => list!.map((value) => ({ ...combo, [refreshers[i]!]: value })));
    }
    if (combos.length > MAX_VARIANTS) continue;
    const variants: DynamicSchemaVariant[] = [];
    for (const values of combos) {
      const input = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
      variants.push({ values, schema: await resolve(name, input) });
    }
    out[name] = { refreshers, variants };
  }
  return Object.keys(out).length ? out : undefined;
}

/** A refresher's value as saved on a step, or undefined when it is not known until run time. */
function refresherValueOf(value: unknown): RefresherValue | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' || value.includes('{{')) return undefined;
  return value === 'true' ? true : value === 'false' ? false : value;
}

/** The schema the table holds for this step's saved values, or undefined. */
export function dynamicSchemaFor(table: DynamicSchemaTable, input: Record<string, unknown>): Record<string, unknown> | undefined {
  const wanted: Record<string, RefresherValue> = {};
  for (const refresher of table.refreshers) {
    const value = refresherValueOf(input[refresher]);
    if (value === undefined) return undefined;
    wanted[refresher] = value;
  }
  return table.variants.find((v) => table.refreshers.every((r) => v.values[r] === wanted[r]))?.schema;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The graph with each piece step's dynamic properties given their schema for
 * the step's saved values. A schema already saved is replaced only when the
 * catalog can resolve one for the current values, so a hand-written schema on
 * a piece the catalog does not resolve, or on a value known only at run time,
 * is left alone. Returns the same object when nothing changes.
 */
export function withResolvedPropertySchemas<T>(trigger: T, pieces: PieceLookup | undefined): T {
  if (!pieces || !record(trigger)) return trigger;
  const changes: Array<{ node: FlowTriggerNode; name: string; schema: Record<string, unknown> }> = [];
  for (const node of walkFlowNodes(trigger as unknown as FlowTriggerNode)) {
    const settings: unknown = (node as { settings?: unknown }).settings;
    if (!record(settings) || typeof settings.pieceName !== 'string' || !record(settings.input)) continue;
    if (!DYNAMIC_SCHEMA_PIECES.has(settings.pieceName)) continue;
    const entry: PieceCatalogEntry | null = pieces.get(settings.pieceName);
    const key = typeof settings.actionName === 'string' ? settings.actionName : settings.triggerName;
    if (typeof key !== 'string') continue;
    const tables = (node.type === 'PIECE_TRIGGER' ? entry?.triggers : entry?.actions)?.[key]?.dynamicSchemas;
    if (!tables) continue;
    for (const [name, table] of Object.entries(tables)) {
      if (settings.input[name] === undefined) continue;
      const schema = dynamicSchemaFor(table, settings.input);
      if (schema) changes.push({ node, name, schema });
    }
  }
  if (!changes.length) return trigger;
  const copy = structuredClone(trigger);
  const byName = new Map<string, FlowTriggerNode>();
  for (const node of walkFlowNodes(copy as unknown as FlowTriggerNode)) byName.set(node.name, node);
  for (const { node, name, schema } of changes) {
    const target = byName.get(node.name);
    const settings = (target as { settings?: Record<string, unknown> } | undefined)?.settings;
    if (!settings) continue;
    const saved = record(settings.propertySettings) ? settings.propertySettings : {};
    const current = record(saved[name]) ? saved[name] : {};
    settings.propertySettings = { ...saved, [name]: { ...current, type: current.type ?? 'MANUAL', schema } };
  }
  return copy;
}
