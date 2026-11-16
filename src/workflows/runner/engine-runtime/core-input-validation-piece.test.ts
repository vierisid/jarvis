/**
 * F-12, F-13: the compiled core XML and crypto pieces refuse input they used to
 * turn into garbage and report as a success: JSON keys that are not valid XML
 * names, text that is not base64, and a password length that gives no password.
 *
 * Needs the compiled pieces. Skips without them, and builds them under
 * `JARVIS_TEST_ENGINE_BUILD=1`.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ENGINE_BUILD_PATHS } from './build';
import { buildPiece } from './build-pieces';

const dir = (name: string) => resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/core', name);
const bundle = (name: string) => resolve(dir(name), 'dist/src/index.js');
const NAMES = ['xml', 'crypto'] as const;
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const skip = !buildOptIn && !NAMES.every((name) => existsSync(bundle(name)));
const require = createRequire(import.meta.url);

type Run = (context: Record<string, unknown>) => Promise<unknown>;
let toXml: Run;
let decode: Run;
let password: Run;

const xml = (json: unknown, extra: Record<string, unknown> = {}) => toXml({ propsValue: { json, ...extra } });
const b64 = (text: string) => decode({ propsValue: { text } });
const pw = (length: unknown) => password({ propsValue: { length, characterSet: 'alphanumeric' } }) as Promise<string>;

describe.skipIf(skip)('the compiled core XML and crypto pieces', () => {
  beforeAll(async () => {
    const actions: Record<string, { getAction(name: string): { run: Run } }> = {};
    for (const name of NAMES) {
      if (buildOptIn) await buildPiece(dir(name));
      const mod = require(bundle(name)) as Record<string, { getAction(name: string): { run: Run } }>;
      actions[name] = Object.values(mod).find((v) => typeof v?.getAction === 'function')!;
    }
    toXml = actions.xml!.getAction('convert-json-to-xml').run;
    decode = actions.crypto!.getAction('base64-decode').run;
    password = actions.crypto!.getAction('generate-password').run;
  });

  test('JSON to XML refuses keys that are not valid XML names, naming the key', async () => {
    await expect(xml({ '1 bad key': 1 })).rejects.toThrow(/"1 bad key" cannot be used as an XML tag name/);
    await expect(xml({ '@id': 1 })).rejects.toThrow(/"@id" cannot be used as an XML tag name/);
    await expect(xml({ order: { items: [{ 'a b': 1 }] } })).rejects.toThrow(/"a b" \(inside "items"\)/);
    await expect(xml({ order: { attr: { 'bad attr': 1 } } })).rejects.toThrow(/"bad attr" \(an attribute of "order"\) cannot be used as an XML attribute name/);
  });

  test('JSON to XML still converts valid names, namespaces, accents and attributes', async () => {
    // A valid attribute name is accepted (json2xml puts it on the tags beside it).
    const out = (await xml({ order: { attr: { id: '7' }, 'ns:item': 'a', _x: 1, 'café-1.b': 2 } })) as string;
    expect(out).toContain('<ns:item');
    expect(out).toContain('<_x');
    expect(out).toContain('<caf\u00E9-1.b');
  });

  test('JSON to XML escapes attribute values, so a value cannot add elements of its own', async () => {
    const out = (await xml({ a: { attr: { id: 'x"><injected/><y z="', note: 'a&b\nc' }, b: 1 } })) as string;
    expect(out).toBe('<a><b id="x&quot;&gt;&lt;injected/&gt;&lt;y z=&quot;" note="a&amp;b&#10;c">1</b></a>');
  });

  test('JSON to XML refuses an attribute field that is not an object, a nested attribute value and control characters', async () => {
    await expect(xml({ a: { attr: 'abc', b: 1 } })).rejects.toThrow(/The attribute field "attr" of "a" must be an object/);
    await expect(xml({ a: { attr: ['q'], b: 1 } })).rejects.toThrow(/must be an object/);
    await expect(xml({ a: { attr: { id: { n: 1 } }, b: 1 } })).rejects.toThrow(/The attribute "id" of "a" must be text/);
    await expect(xml({ a: 'bell\u0007' })).rejects.toThrow(/The value of "a" has a control character/);
    await expect(xml({ 'a\u00D7b': 1 })).rejects.toThrow(/cannot be used as an XML tag name/);
    // A long key is cut short in the message.
    await expect(xml({ [`1${'k'.repeat(500)}`]: 1 })).rejects.toThrow(/^"1k{59}\.\.\." cannot be used as an XML tag name/);
  });

  test('Base64 Decode refuses text that is not base64 instead of returning garbage', async () => {
    for (const text of ['not base64!', 'hello world', '@@@@', 'abcde']) {
      await expect(b64(text)).rejects.toThrow('The text is not valid base64');
    }
  });

  test('Base64 Decode still decodes standard, URL-safe, unpadded and wrapped base64', async () => {
    expect(await b64('SGVsbG8sIHdvcmxkIQ==')).toBe('Hello, world!');
    expect(await b64('SGVsbG8sIHdvcmxkIQ')).toBe('Hello, world!');
    expect(await b64('SGVsbG8s\nIHdvcmxkIQ==\n')).toBe('Hello, world!');
    expect(await b64('PDw_Pz4-')).toBe('<<??>>');
    expect(await b64('')).toBe('');
  });

  test('Generate Password refuses a length of 0, a negative, a fraction and one over 256', async () => {
    for (const length of [0, -5, 1.5, 257, 1_000_000]) {
      await expect(pw(length)).rejects.toThrow('Password length must be a whole number from 1 to 256.');
    }
  });

  test('Generate Password still makes passwords of the asked length', async () => {
    expect(await pw(1)).toHaveLength(1);
    expect(await pw(24)).toHaveLength(24);
    expect(await pw(256)).toHaveLength(256);
  });
});
