import { describe, expect, test } from 'bun:test';
import { OUTPUT_SCHEMA_LIMITS, OutputSchemaError, evaluateLlmOutput, parseOutputSchema, validateOutput } from './llm-output-contract';

const invoice = {
  type: 'object',
  properties: {
    total: { type: 'number', minimum: 0 },
    currency: { type: 'string', enum: ['EUR', 'USD'] },
    lines: { type: 'array', minItems: 1, items: { type: 'object', properties: { sku: { type: 'string', minLength: 1 } }, required: ['sku'] } },
    paid: { type: 'boolean' },
    note: { type: 'null' },
  },
  required: ['total', 'currency', 'lines'],
  additionalProperties: false,
};

describe('output schema declarations', () => {
  test('accepts every supported keyword and returns a normalized copy', () => {
    const parsed = parseOutputSchema({ ...invoice, title: 'Invoice', description: 'One invoice' });
    expect(parsed.type).toBe('object');
    expect(parsed.properties?.lines?.items?.required).toEqual(['sku']);
    expect(parsed.title).toBe('Invoice');
  });

  for (const [label, schema, message] of [
    ['a keyword this validator does not implement', { type: 'string', pattern: '^a' }, 'unsupported schema keyword "pattern" at /'],
    ['composition keywords', { type: 'object', oneOf: [] }, 'unsupported schema keyword "oneOf"'],
    ['references', { $ref: '#/x' }, 'unsupported schema keyword "$ref"'],
    ['a nested unsupported keyword, with its path', { type: 'object', properties: { a: { type: 'string', format: 'email' } } }, '"format" at /properties/a'],
    ['a missing type', { properties: {} }, '"type" must be one of'],
    ['a type list', { type: ['string', 'null'] }, '"type" must be one of'],
    ['properties on a non-object', { type: 'array', properties: {} }, '"properties" applies to object only'],
    ['items on a non-array', { type: 'object', items: { type: 'string' } }, '"items" applies to array only'],
    ['a schema-valued additionalProperties', { type: 'object', additionalProperties: { type: 'string' } }, '"additionalProperties" must be true or false'],
    // Parsed, not a literal: a literal `__proto__` key sets the prototype instead of an own property.
    ['a prototype property name', JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'), 'property name "__proto__" is not allowed'],
    ['a required list with duplicates', { type: 'object', required: ['a', 'a'] }, 'lists a property twice'],
    ['an empty enum', { type: 'string', enum: [] }, '"enum" must be a non-empty array'],
    ['an enum value of another type', { type: 'string', enum: ['a', 1] }, 'not of type string'],
    ['an object enum value', { type: 'object', enum: [{}] }, 'strings, numbers, booleans or null'],
    ['bounds that cannot be met', { type: 'array', minItems: 3, maxItems: 2 }, '"minItems" exceeds "maxItems"'],
    ['a negative length', { type: 'string', minLength: -1 }, 'non-negative integer'],
    ['a non-finite bound', { type: 'number', maximum: Number.POSITIVE_INFINITY }, 'finite number'],
    ['a non-object declaration', 'string', 'schema must be an object at /'],
  ] as const) test(`refuses ${label}`, () => {
    expect(() => parseOutputSchema(schema)).toThrow(OutputSchemaError);
    expect(() => parseOutputSchema(schema)).toThrow(message);
  });

  test('refuses declarations beyond the nesting and node budgets', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let level = 0; level <= OUTPUT_SCHEMA_LIMITS.depth; level++) deep = { type: 'array', items: deep };
    expect(() => parseOutputSchema(deep)).toThrow(`schema nesting exceeds ${OUTPUT_SCHEMA_LIMITS.depth} levels`);

    const properties: Record<string, unknown> = {};
    for (let index = 0; index < OUTPUT_SCHEMA_LIMITS.properties; index++) {
      const inner: Record<string, unknown> = {};
      for (let column = 0; column < 4; column++) inner[`c${column}`] = { type: 'string' };
      properties[`p${index}`] = { type: 'object', properties: inner };
    }
    expect(() => parseOutputSchema({ type: 'object', properties })).toThrow(`schema exceeds ${OUTPUT_SCHEMA_LIMITS.nodes} nodes`);
    properties.extra = { type: 'string' };
    expect(() => parseOutputSchema({ type: 'object', properties })).toThrow(`"properties" exceeds ${OUTPUT_SCHEMA_LIMITS.properties} entries`);
  });
});

describe('output validation', () => {
  const schema = parseOutputSchema(invoice);

  test('a matching reply has no violations', () => {
    expect(validateOutput({ total: 12.5, currency: 'EUR', lines: [{ sku: 'A1' }], paid: true, note: null }, schema)).toEqual([]);
  });

  test('reports each departure with its JSON pointer', () => {
    const violations = validateOutput({ total: -1, currency: 'GBP', lines: [{ sku: '' }, { name: 'x' }], extra: 1 }, schema);
    expect(violations).toEqual([
      'number at /total is below 0',
      'value at /currency is not one of the allowed values',
      'string at /lines/0/sku is shorter than 1',
      'missing required property "sku" at /lines/1',
      'unexpected property "extra" at /',
    ]);
  });

  test('a wrong type stops descent into that value', () => {
    expect(validateOutput('{"total": 1}', schema)).toEqual(['expected object at /, got string']);
    expect(validateOutput({ total: '1', currency: 'EUR', lines: 'none' }, schema)).toEqual([
      'expected number at /total, got string', 'expected array at /lines, got string']);
  });

  test('integer accepts whole numbers only, number accepts both', () => {
    expect(validateOutput(2, parseOutputSchema({ type: 'integer' }))).toEqual([]);
    expect(validateOutput(2.5, parseOutputSchema({ type: 'integer' }))).toEqual(['expected integer at /, got number']);
    expect(validateOutput(2, parseOutputSchema({ type: 'number' }))).toEqual([]);
  });

  test('additional properties are allowed unless declared closed', () => {
    expect(validateOutput({ a: 1, b: 2 }, parseOutputSchema({ type: 'object', properties: { a: { type: 'number' } } }))).toEqual([]);
  });

  test('an own __proto__ key from JSON.parse is an unexpected property, not a prototype', () => {
    const value = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
    expect(validateOutput(value, parseOutputSchema({ type: 'object', properties: { a: { type: 'number' } }, additionalProperties: false })))
      .toEqual(['unexpected property "__proto__" at /']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('bounds the violation list and states how many were left out', () => {
    const closed = parseOutputSchema({ type: 'object', additionalProperties: false });
    const value = Object.fromEntries(Array.from({ length: OUTPUT_SCHEMA_LIMITS.violations + 5 }, (_, i) => [`k${i}`, i]));
    const violations = validateOutput(value, closed);
    expect(violations).toHaveLength(OUTPUT_SCHEMA_LIMITS.violations + 1);
    expect(violations.at(-1)).toBe('5 more violations not listed');
  });
});

describe('LLM output evaluation', () => {
  test('plain text is a succeeded outcome with no parsed value', () => {
    expect(evaluateLlmOutput({ text: 'anything, even {broken' })).toEqual({ outcome: { status: 'succeeded' } });
  });

  test('requested JSON that parses is succeeded with the parsed value, including null', () => {
    expect(evaluateLlmOutput({ text: '{"a":1}', parseJson: true })).toEqual({ outcome: { status: 'succeeded' }, parsed: { a: 1 } });
    const nothing = evaluateLlmOutput({ text: 'null', parseJson: true });
    expect('parsed' in nothing).toBe(true);
    expect(nothing.parsed).toBeNull();
  });

  test('requested JSON that does not parse is an error that never quotes the reply', () => {
    // A bare identifier is what the parser echoes back verbatim, so this
    // sentinel would surface if the message ever included the parser text.
    const reply = 'syntheticUnparsedReplyToken';
    expect(() => JSON.parse(reply)).toThrow(reply);
    const result = evaluateLlmOutput({ text: reply, parseJson: true });
    expect('parsed' in result).toBe(false);
    expect(result.outcome).toMatchObject({ status: 'error', code: 'INVALID_JSON_OUTPUT', effect: 'may_have_occurred' });
    expect((result.outcome as { message: string }).message).not.toContain(reply);
    expect((result.outcome as { message: string }).message).toContain('not valid JSON');
  });

  test('a fenced reply is named as the likely cause', () => {
    const result = evaluateLlmOutput({ text: '```json\n{"a":1}\n```', parseJson: true });
    expect(result.outcome).toMatchObject({ code: 'INVALID_JSON_OUTPUT' });
    expect((result.outcome as { message: string }).message).toContain('code fence');
  });

  test('an empty reply is not JSON', () => {
    expect(evaluateLlmOutput({ text: '', parseJson: true }).outcome).toMatchObject({ code: 'INVALID_JSON_OUTPUT' });
  });

  test('a schema implies JSON and a mismatch withholds the parsed value', () => {
    const schema = parseOutputSchema({ type: 'object', properties: { total: { type: 'number' } }, required: ['total'] });
    const result = evaluateLlmOutput({ text: '{"total":"syntheticWrongTypeValue"}', outputSchema: schema });
    expect('parsed' in result).toBe(false);
    expect(result.outcome).toMatchObject({ status: 'error', code: 'OUTPUT_SCHEMA_MISMATCH', effect: 'may_have_occurred' });
    const message = (result.outcome as { message: string }).message;
    expect(message).toContain('expected number at /total, got string');
    expect(message).not.toContain('syntheticWrongTypeValue');
    expect(evaluateLlmOutput({ text: 'not json', outputSchema: schema }).outcome).toMatchObject({ code: 'INVALID_JSON_OUTPUT' });
    expect(evaluateLlmOutput({ text: '{"total":3}', outputSchema: schema })).toEqual({ outcome: { status: 'succeeded' }, parsed: { total: 3 } });
  });
});
