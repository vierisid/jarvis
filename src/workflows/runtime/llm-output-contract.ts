/**
 * A step that asked for JSON gets a typed outcome, never a silent fallback to
 * the reply text. The schema language is a closed subset of JSON Schema: every
 * keyword is either implemented here or refused when the step is declared, so
 * a constraint can never be ignored and then reported as success.
 *
 * Outcome messages quote schema keywords, JSON-pointer paths and property
 * names, escaped and bounded because a reply's keys are model output. They
 * never quote a reply's values.
 */
import type { ActionOutcome } from '../../actions/action-outcome';

export class OutputSchemaError extends Error {
  override readonly name = 'OutputSchemaError';
}

export type OutputSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export interface OutputSchema {
  type: OutputSchemaType;
  properties?: Record<string, OutputSchema>;
  required?: string[];
  /** Defaults to true, as in JSON Schema. */
  additionalProperties?: boolean;
  items?: OutputSchema;
  enum?: Array<string | number | boolean | null>;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  /** Documentation only; never affects validation. */
  title?: string;
  description?: string;
}

export type LlmOutputEvaluation = { outcome: ActionOutcome; parsed?: unknown };

export const OUTPUT_SCHEMA_LIMITS = Object.freeze({
  /** Schema nodes across the whole declaration. */
  nodes: 256,
  /** Nesting depth of the declaration. */
  depth: 8,
  properties: 64,
  enumValues: 64,
  /** Violations reported for one reply; the count of the rest is stated. */
  violations: 20,
  /** Characters in a declared property name. */
  nameLength: 128,
  /** Characters of a reply's property name quoted in a message. */
  nameExcerpt: 80,
});

const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'title', 'description',
]);
const TYPES = new Set<string>(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const forbiddenNames = new Set(['__proto__', 'prototype', 'constructor']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isPrimitive = (value: unknown): value is string | number | boolean | null =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);
const own = (object: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(object, key);
/** RFC 6901 escaping, so a name cannot forge a path segment. */
const pointer = (name: string) => name.replace(/~/gu, '~0').replace(/\//gu, '~1');
/** A name quoted in a message: escaped and bounded, since a reply's keys are model output. */
const label = (name: string) => {
  const escaped = pointer(name);
  return escaped.length > OUTPUT_SCHEMA_LIMITS.nameExcerpt ? `${escaped.slice(0, OUTPUT_SCHEMA_LIMITS.nameExcerpt)}...` : escaped;
};

/**
 * Accept a declaration or explain why it is not one this validator can honor.
 * Unknown keywords are refused rather than skipped: a skipped `required` or
 * `enum` would turn into an output that passes for the wrong reason.
 */
export function parseOutputSchema(value: unknown): OutputSchema {
  const budget = { nodes: 0 };
  return parseNode(value, '', 0, budget);
}

function parseNode(value: unknown, path: string, depth: number, budget: { nodes: number }): OutputSchema {
  const at = path || '/';
  const fail: (message: string) => never = message => { throw new OutputSchemaError(`${message} at ${at}`); };
  if (!isRecord(value)) fail('schema must be an object');
  if (++budget.nodes > OUTPUT_SCHEMA_LIMITS.nodes) fail(`schema exceeds ${OUTPUT_SCHEMA_LIMITS.nodes} nodes`);
  if (depth > OUTPUT_SCHEMA_LIMITS.depth) fail(`schema nesting exceeds ${OUTPUT_SCHEMA_LIMITS.depth} levels`);
  for (const key of Object.keys(value)) if (!KEYWORDS.has(key)) fail(`unsupported schema keyword "${key}"`);
  const type = value.type;
  if (typeof type !== 'string' || !TYPES.has(type)) fail('"type" must be one of object, array, string, number, integer, boolean, null');
  const schema: OutputSchema = { type: type as OutputSchemaType };
  const only = (keyword: string, ...types: OutputSchemaType[]) => {
    if (own(value, keyword) && !types.includes(schema.type)) fail(`"${keyword}" applies to ${types.join(' or ')} only`);
  };
  const integerAtLeastZero = (keyword: 'minItems' | 'maxItems' | 'minLength' | 'maxLength') => {
    if (!own(value, keyword)) return;
    const n = value[keyword];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) fail(`"${keyword}" must be a non-negative integer`);
    schema[keyword] = n as number;
  };
  const finite = (keyword: 'minimum' | 'maximum') => {
    if (!own(value, keyword)) return;
    const n = value[keyword];
    if (typeof n !== 'number' || !Number.isFinite(n)) fail(`"${keyword}" must be a finite number`);
    schema[keyword] = n as number;
  };
  for (const keyword of ['title', 'description'] as const) {
    if (!own(value, keyword)) continue;
    if (typeof value[keyword] !== 'string') fail(`"${keyword}" must be a string`);
    schema[keyword] = value[keyword] as string;
  }

  only('properties', 'object'); only('required', 'object'); only('additionalProperties', 'object');
  only('items', 'array'); only('minItems', 'array'); only('maxItems', 'array');
  only('minLength', 'string'); only('maxLength', 'string');
  only('minimum', 'number', 'integer'); only('maximum', 'number', 'integer');

  if (own(value, 'properties')) {
    const properties = value.properties;
    if (!isRecord(properties)) fail('"properties" must be an object');
    const names = Object.keys(properties);
    if (names.length > OUTPUT_SCHEMA_LIMITS.properties) fail(`"properties" exceeds ${OUTPUT_SCHEMA_LIMITS.properties} entries`);
    schema.properties = {};
    for (const name of names) {
      if (name.length > OUTPUT_SCHEMA_LIMITS.nameLength) fail(`property name exceeds ${OUTPUT_SCHEMA_LIMITS.nameLength} characters`);
      if (forbiddenNames.has(name)) fail(`property name "${name}" is not allowed`);
      schema.properties[name] = parseNode(properties[name], `${path}/properties/${pointer(name)}`, depth + 1, budget);
    }
  }
  if (own(value, 'required')) {
    const required = value.required;
    if (!Array.isArray(required) || required.some(name => typeof name !== 'string' || name.length === 0)) fail('"required" must be an array of property names');
    if (required.some(name => (name as string).length > OUTPUT_SCHEMA_LIMITS.nameLength)) fail(`"required" names a property longer than ${OUTPUT_SCHEMA_LIMITS.nameLength} characters`);
    if (new Set(required).size !== required.length) fail('"required" lists a property twice');
    if (required.some(name => forbiddenNames.has(name as string))) fail('"required" names a property that is not allowed');
    schema.required = required as string[];
  }
  if (own(value, 'additionalProperties')) {
    if (typeof value.additionalProperties !== 'boolean') fail('"additionalProperties" must be true or false');
    schema.additionalProperties = value.additionalProperties;
  }
  if (own(value, 'items')) schema.items = parseNode(value.items, `${path}/items`, depth + 1, budget);
  integerAtLeastZero('minItems'); integerAtLeastZero('maxItems');
  integerAtLeastZero('minLength'); integerAtLeastZero('maxLength');
  finite('minimum'); finite('maximum');
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) fail('"minItems" exceeds "maxItems"');
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) fail('"minLength" exceeds "maxLength"');
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) fail('"minimum" exceeds "maximum"');
  if (own(value, 'enum')) {
    const values = value.enum;
    if (!Array.isArray(values) || values.length === 0) fail('"enum" must be a non-empty array');
    if (values.length > OUTPUT_SCHEMA_LIMITS.enumValues) fail(`"enum" exceeds ${OUTPUT_SCHEMA_LIMITS.enumValues} values`);
    if (!values.every(isPrimitive)) fail('"enum" values must be strings, numbers, booleans or null');
    if (values.some(candidate => jsonType(candidate) !== schema.type && !(schema.type === 'number' && jsonType(candidate) === 'integer'))) {
      fail(`"enum" contains a value that is not of type ${schema.type}`);
    }
    schema.enum = values as OutputSchema['enum'];
  }
  return schema;
}

function jsonType(value: unknown): OutputSchemaType | 'unknown' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'object': return 'object';
    case 'string': return 'string';
    case 'boolean': return 'boolean';
    case 'number': return Number.isInteger(value) ? 'integer' : 'number';
    default: return 'unknown';
  }
}

/** Every way `value` departs from `schema`, as JSON-pointer paths, bounded. */
export function validateOutput(value: unknown, schema: OutputSchema): string[] {
  const violations: string[] = [];
  let hidden = 0;
  const report = (message: string) => {
    if (violations.length < OUTPUT_SCHEMA_LIMITS.violations) violations.push(message); else hidden++;
  };
  check(value, schema, '', report);
  if (hidden > 0) violations.push(`${hidden} more violation${hidden === 1 ? '' : 's'} not listed`);
  return violations;
}

function check(value: unknown, schema: OutputSchema, path: string, report: (message: string) => void): void {
  const at = path || '/';
  const actual = jsonType(value);
  const typeMatches = actual === schema.type || (schema.type === 'number' && actual === 'integer');
  if (!typeMatches) { report(`expected ${schema.type} at ${at}, got ${actual}`); return; }
  if (schema.enum && !schema.enum.some(candidate => candidate === value)) {
    report(`value at ${at} is not one of the allowed values`);
  }
  if (schema.type === 'string') {
    const length = (value as string).length;
    if (schema.minLength !== undefined && length < schema.minLength) report(`string at ${at} is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && length > schema.maxLength) report(`string at ${at} is longer than ${schema.maxLength}`);
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const n = value as number;
    if (schema.minimum !== undefined && n < schema.minimum) report(`number at ${at} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && n > schema.maximum) report(`number at ${at} is above ${schema.maximum}`);
  }
  if (schema.type === 'array') {
    const items = value as unknown[];
    if (schema.minItems !== undefined && items.length < schema.minItems) report(`array at ${at} has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && items.length > schema.maxItems) report(`array at ${at} has more than ${schema.maxItems} items`);
    if (schema.items) items.forEach((item, index) => check(item, schema.items!, `${path}/${index}`, report));
  }
  if (schema.type === 'object') {
    const object = value as Record<string, unknown>;
    for (const name of schema.required ?? []) if (!own(object, name)) report(`missing required property "${label(name)}" at ${at}`);
    for (const name of Object.keys(object)) {
      const declared = schema.properties && own(schema.properties, name) ? schema.properties[name] : undefined;
      if (declared) check(object[name], declared, `${path}/${pointer(name)}`, report);
      else if (schema.additionalProperties === false) report(`unexpected property "${label(name)}" at ${at}`);
    }
  }
}

/**
 * The reply has already been received, so a contract failure is an `error`
 * whose effect `may_have_occurred`: the provider was called and answered. The
 * message names the contract that failed, never a reply value; the text
 * travels beside the outcome so a handled branch can still inspect it.
 */
export function evaluateLlmOutput(input: { text: string; parseJson?: boolean; outputSchema?: OutputSchema }): LlmOutputEvaluation {
  if (!input.parseJson && !input.outputSchema) return { outcome: { status: 'succeeded' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch {
    const fenced = /^\s*```/u.test(input.text);
    return { outcome: { status: 'error', code: 'INVALID_JSON_OUTPUT', effect: 'may_have_occurred',
      message: fenced
        ? 'The reply is not valid JSON: it starts with a code fence. Ask the model for bare JSON with no fences or commentary.'
        : 'The reply is not valid JSON. Ask the model for bare JSON with no commentary.' } };
  }
  if (input.outputSchema) {
    const violations = validateOutput(parsed, input.outputSchema);
    if (violations.length > 0) {
      return { outcome: { status: 'error', code: 'OUTPUT_SCHEMA_MISMATCH', effect: 'may_have_occurred',
        message: `The reply is valid JSON but does not match the declared output schema: ${violations.join('; ')}` } };
    }
  }
  return { outcome: { status: 'succeeded' }, parsed };
}
