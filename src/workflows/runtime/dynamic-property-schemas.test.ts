/**
 * Dynamic properties (HTTP body and authentication fields, zip password) get
 * their saved schema when a draft is written, so a flow a person or the
 * composer saved with them filled in can be published.
 *
 * The first block needs no engine. The second resolves the schemas through the
 * real engine and runs the compiled HTTP piece, so like the other engine
 * suites it skips without a built engine and pieces and builds them under
 * `JARVIS_TEST_ENGINE_BUILD=1`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { closeWorkflowDb, initWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { assertVersionReady, configureWorkflowReadiness } from '../db/repos/flow-readiness';
import { createDraftVersion, getFlowVersion, updateDraftVersion, type FlowTriggerNode } from '../db/repos/flow-version';
import { CredentialResolver } from '../credentials/adapter';
import { SandboxApi } from '../sandbox-api/server';
import { buildEngineBundle, ENGINE_BUILD_PATHS, findCachedBundle } from '../runner/engine-runtime/build';
import { buildPiece } from '../runner/engine-runtime/build-pieces';
import { EngineRuntime, type EngineHandle } from '../runner/engine-runtime/engine-runtime';
import { redactRunSteps, versionAsModelSees } from './step-credentials';
import { buildPieceCatalog, metadataToCatalogEntry, PieceCatalog, type PieceLookup } from './piece-catalog';
import { dynamicSchemaFor, resolveDynamicSchemas, withResolvedPropertySchemas, type DynamicSchemaTable } from './dynamic-property-schemas';

const HTTP = '@activepieces/piece-http';
const FILES = '@activepieces/piece-file-helper';
const manual = (next: FlowTriggerNode): FlowTriggerNode => ({ name: 'trigger', type: 'EMPTY', settings: {}, nextAction: next } as FlowTriggerNode);
const http = (input: Record<string, unknown>, propertySettings?: Record<string, unknown>): FlowTriggerNode => manual({
  name: 'step_1', type: 'PIECE',
  settings: { pieceName: HTTP, actionName: 'send_request', input: { method: 'POST', url: 'https://api.example.com/items', headers: {}, queryParams: {}, authType: 'NONE', ...input }, ...(propertySettings ? { propertySettings } : {}) },
} as FlowTriggerNode);
const stepOf = (versionId: string) => (getFlowVersion(versionId)!.trigger as FlowTriggerNode).nextAction as unknown as { settings: Record<string, any> };

/** What the engine answers for the HTTP piece, trimmed to what the tests read. */
const jsonBody = { data: { type: 'JSON', displayName: 'JSON Body', required: true } };
const bearer = { token: { type: 'SHORT_TEXT', displayName: 'Token', required: true } };
const basic = { username: { type: 'SHORT_TEXT', displayName: 'Username', required: true }, password: { type: 'SHORT_TEXT', displayName: 'Password', required: true } };
const table = (refreshers: string[], variants: Array<[Record<string, string | boolean | null>, Record<string, unknown>]>): DynamicSchemaTable =>
  ({ refreshers, variants: variants.map(([values, schema]) => ({ values, schema })) });

function fakeCatalog(): PieceLookup {
  const entry = metadataToCatalogEntry({
    name: HTTP, displayName: 'HTTP', description: '',
    actions: { send_request: { name: 'send_request', displayName: 'Send HTTP request', description: '', props: {
      method: { type: 'SHORT_TEXT', displayName: 'Method', required: true },
      url: { type: 'SHORT_TEXT', displayName: 'URL', required: true },
      headers: { type: 'OBJECT', displayName: 'Headers', required: true },
      queryParams: { type: 'OBJECT', displayName: 'Query params', required: true },
      authType: { type: 'STATIC_DROPDOWN', displayName: 'Authentication', required: true },
      authFields: { type: 'DYNAMIC', displayName: 'Authentication Fields', required: false, refreshers: ['authType'] },
      body_type: { type: 'STATIC_DROPDOWN', displayName: 'Body Type', required: false },
      body: { type: 'DYNAMIC', displayName: 'Body', required: false, refreshers: ['body_type'] },
    } } },
  });
  entry.actions.send_request!.dynamicSchemas = {
    body: table(['body_type'], [[{ body_type: null }, {}], [{ body_type: 'none' }, {}], [{ body_type: 'json' }, jsonBody]]),
    authFields: table(['authType'], [[{ authType: null }, {}], [{ authType: 'NONE' }, {}], [{ authType: 'BEARER_TOKEN' }, bearer], [{ authType: 'BASIC' }, basic]]),
  };
  return new PieceCatalog([entry]);
}

describe('saving a draft with dynamic properties filled in', () => {
  beforeEach(() => {
    initWorkflowDb(':memory:');
    configureWorkflowReadiness({ pieces: fakeCatalog() });
  });
  afterEach(() => closeWorkflowDb());

  test('a JSON body is saved with its schema and the flow can be published', () => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: 'post', trigger: http({ body_type: 'json', body: { data: { name: 'a' } } }) });
    expect(stepOf(version.id).settings.propertySettings.body).toEqual({ type: 'MANUAL', schema: jsonBody });
    expect(() => assertVersionReady(flow.id, version.id)).not.toThrow();
  });

  test('bearer and basic authentication fields are saved with their schema and publish', () => {
    for (const [authType, authFields, schema] of [['BEARER_TOKEN', { token: 'secret-token' }, bearer], ['BASIC', { username: 'u', password: 'secret-pass' }, basic]] as const) {
      const flow = createFlow();
      const version = createDraftVersion({ flowId: flow.id, displayName: authType, trigger: http({ authType, authFields }) });
      expect(stepOf(version.id).settings.propertySettings.authFields.schema).toEqual(schema);
      expect(() => assertVersionReady(flow.id, version.id)).not.toThrow();
    }
  });

  test('an edit that changes the type replaces the schema, and a missing required field is still caught', () => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: 'auth', trigger: http({ authType: 'BEARER_TOKEN', authFields: { token: 't' } }) });
    updateDraftVersion(version.id, { trigger: http({ authType: 'BASIC', authFields: { username: 'u' } }) });
    expect(stepOf(version.id).settings.propertySettings.authFields.schema).toEqual(basic);
    // The basic schema requires a password; the type check of the schema is what runs, so this is not a pass by default.
    expect(() => assertVersionReady(flow.id, version.id)).toThrow();
  });

  test('a value known only at run time and a schema written by hand are left as they are', () => {
    const handWritten = { data: { type: 'LONG_TEXT', required: false } };
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: 'kept', trigger: http({ body_type: '{{trigger.type}}', body: { data: 'x' } }, { body: { type: 'MANUAL', schema: handWritten } }) });
    expect(stepOf(version.id).settings.propertySettings.body.schema).toEqual(handWritten);
  });

  test('a step with nothing to resolve is saved untouched', () => {
    const trigger = http({ authType: 'NONE', body_type: 'none' });
    expect(withResolvedPropertySchemas(trigger, fakeCatalog())).toBe(trigger);
    expect(withResolvedPropertySchemas(trigger, undefined)).toBe(trigger);
  });

  test('credentials in the authentication fields stay redacted for the model and in run history (#1318)', () => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: 'secret', trigger: http({ authType: 'BASIC', authFields: { username: 'user-one', password: 'secret-pass-123' } }) });
    const stored = getFlowVersion(version.id)!;
    // The schema was saved next to the credential, and the credential is still what runs.
    expect(stepOf(version.id).settings.propertySettings.authFields.schema).toEqual(basic);
    expect(JSON.stringify(stored.trigger)).toContain('secret-pass-123');
    const seen = JSON.stringify(versionAsModelSees(stored));
    expect(seen).not.toContain('secret-pass-123');
    expect(seen).toContain('"authFields"');
    const recorded = { step_1: { output: { type: 'PIECE', status: 'SUCCEEDED', input: { ...stepOf(version.id).settings.input }, output: {} } } };
    expect(JSON.stringify(redactRunSteps(recorded, stored.trigger as FlowTriggerNode))).not.toContain('secret-pass-123');
  });
});

describe('refresher combinations', () => {
  test('a table answers for the saved value, null for an unset one, and nothing for a run-time one', () => {
    const t = table(['usePassword'], [[{ usePassword: null }, {}], [{ usePassword: false }, {}], [{ usePassword: true }, { password: { type: 'SHORT_TEXT' } }]]);
    expect(dynamicSchemaFor(t, { usePassword: true })).toEqual({ password: { type: 'SHORT_TEXT' } });
    expect(dynamicSchemaFor(t, { usePassword: 'true' })).toEqual({ password: { type: 'SHORT_TEXT' } });
    expect(dynamicSchemaFor(t, {})).toEqual({});
    expect(dynamicSchemaFor(t, { usePassword: '{{trigger.p}}' })).toBeUndefined();
  });

  test('only properties whose refreshers can be listed are resolved', async () => {
    const asked: Array<Record<string, unknown>> = [];
    const tables = await resolveDynamicSchemas({ props: {
      mode: { type: 'STATIC_DROPDOWN', options: { options: [{ value: 'a' }, { value: 'b' }] } },
      free: { type: 'SHORT_TEXT' },
      byMode: { type: 'DYNAMIC', refreshers: ['mode'] },
      byFree: { type: 'DYNAMIC', refreshers: ['free'] },
    } }, async (_name, input) => { asked.push(input); return { x: { type: 'SHORT_TEXT' } }; });
    expect(Object.keys(tables ?? {})).toEqual(['byMode']);
    expect(asked).toEqual([{}, { mode: 'a' }, { mode: 'b' }]);
  });
});

describe('the catalog build', () => {
  test('a piece whose dynamic properties failed to resolve is not cached, so the next build tries again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dynamic-schemas-cache-'));
    try {
      mkdirSync(join(root, 'http'));
      writeFileSync(join(root, 'http', 'package.json'), JSON.stringify({ name: HTTP, version: '0.0.1' }));
      const cacheFile = join(root, 'cache.json');
      let fail = true;
      const handle = {
        async extractPieceMetadata() {
          return { name: HTTP, displayName: 'HTTP', description: '', actions: { send_request: { name: 'send_request', displayName: 'Send', description: '', props: {
            authType: { type: 'STATIC_DROPDOWN', displayName: 'Authentication', required: true, options: { options: [{ value: 'BEARER_TOKEN' }] } },
            authFields: { type: 'DYNAMIC', displayName: 'Authentication Fields', required: false, refreshers: ['authType'] },
          } } } };
        },
        async executeDynamicProperty() {
          if (fail) throw new Error('engine busy');
          return bearer;
        },
        async release() { /* noop */ },
      } as unknown as EngineHandle;
      let acquires = 0;
      const runtime = { acquire: async () => (acquires++, handle) } as unknown as EngineRuntime;
      const build = () => buildPieceCatalog({ runtime, pieceRoots: [root], cacheFile, cacheKey: 'v1', reporter: () => {} });
      const first = await build();
      expect(first.catalog.get(HTTP)!.actions.send_request!.dynamicSchemas).toBeUndefined();
      expect(existsSync(cacheFile) ? Object.keys((JSON.parse(readFileSync(cacheFile, 'utf8')) as { pieces: object }).pieces) : []).toEqual([]);
      fail = false;
      const second = await build();
      expect(acquires).toBe(2);
      expect(dynamicSchemaFor(second.catalog.get(HTTP)!.actions.send_request!.dynamicSchemas!.authFields!, { authType: 'BEARER_TOKEN' })).toEqual(bearer);
      // Now complete, it is cached: a third build does not start an engine.
      await build();
      expect(acquires).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- Real engine -----------------------------------------------------------

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const cachedBundle = findCachedBundle();
const pieceDir = (name: string) => resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/core', name);
const built = ['http', 'file-helper'].every((name) => existsSync(resolve(pieceDir(name), 'dist/src/index.js')));
const skip = (cachedBundle === null && !buildOptIn) || (!built && !buildOptIn);
const require = createRequire(import.meta.url);

describe.skipIf(skip)('with the real engine and the compiled core pieces', () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;
  let root = '';
  let catalog: PieceCatalog;
  type Run = (context: { propsValue: Record<string, unknown> }) => Promise<unknown>;
  let run: Run;

  beforeAll(async () => {
    api = new SandboxApi({ services: { credentialResolver: new CredentialResolver() } });
    await api.start({ port: 0 });
    const bundle = cachedBundle ?? await buildEngineBundle();
    if (buildOptIn) for (const name of ['http', 'file-helper']) await buildPiece(pieceDir(name));
    runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath, expectedDigest: bundle.digest });
    // A root holding only the pieces under test, so the build does not extract every core piece.
    root = mkdtempSync(join(tmpdir(), 'dynamic-schemas-'));
    for (const name of ['http', 'file-helper']) symlinkSync(pieceDir(name), join(root, name));
    const result = await buildPieceCatalog({ runtime, pieceRoots: [root], reporter: () => {} });
    expect(result.failures).toEqual([]);
    catalog = result.catalog;
    const mod = require(resolve(pieceDir('http'), 'dist/src/index.js')) as { http: { getAction(name: string): { run: Run } | undefined } };
    run = mod.http.getAction('send_request')!.run;
  }, 300_000);
  afterAll(async () => { await runtime?.shutdown(); await api.stop(); if (root) rmSync(root, { recursive: true, force: true }); });
  beforeEach(() => { initWorkflowDb(':memory:'); configureWorkflowReadiness({ pieces: catalog }); });
  afterEach(() => closeWorkflowDb());

  test('the engine resolves the HTTP body, authentication and the zip password for each value', () => {
    const send = catalog.get(HTTP)!.actions.send_request!.dynamicSchemas!;
    expect(Object.keys(send.body!.variants.find((v) => v.values.body_type === 'json')!.schema)).toEqual(['data']);
    expect(Object.keys(send.authFields!.variants.find((v) => v.values.authType === 'BEARER_TOKEN')!.schema)).toEqual(['token']);
    expect(Object.keys(send.authFields!.variants.find((v) => v.values.authType === 'BASIC')!.schema).sort()).toEqual(['password', 'username']);
    const zip = catalog.get(FILES)!.actions.zipFiles!.dynamicSchemas!;
    expect(Object.keys(zip.passwordOptions!.variants.find((v) => v.values.usePassword === true)!.schema).sort()).toEqual(['encryptionMethod', 'password']);
  });

  test('a flow saved with a JSON body, bearer or basic authentication, or a zip password publishes', () => {
    for (const trigger of [
      http({ body_type: 'json', body: { data: { name: 'a' } } }),
      http({ authType: 'BEARER_TOKEN', authFields: { token: 'secret-token' } }),
      http({ authType: 'BASIC', authFields: { username: 'u', password: 'p' } }),
      manual({ name: 'step_1', type: 'PIECE', settings: { pieceName: FILES, actionName: 'zipFiles', input: {
        files: [{ file: 'https://example.com/a.txt', filePath: 'a.txt' }], outputFileName: 'out', usePassword: true, passwordOptions: { password: 'pw', encryptionMethod: 'aes-256' },
      } } } as FlowTriggerNode),
    ]) {
      const flow = createFlow();
      const version = createDraftVersion({ flowId: flow.id, displayName: 'saved', trigger });
      expect(() => assertVersionReady(flow.id, version.id)).not.toThrow();
    }
  });

  test('a flow saved and published this way sends the body and the bearer and basic authorization headers when it runs', async () => {
    const saved = (input: Record<string, unknown>) => {
      const flow = createFlow();
      const version = createDraftVersion({ flowId: flow.id, displayName: 'run', trigger: http({ url: 'http://api.example.com/items', failureMode: 'continue_none', timeout: 3, ...input }) });
      assertVersionReady(flow.id, version.id);
      return stepOf(version.id).settings.input as Record<string, unknown>;
    };
    const bearerInput = saved({ authType: 'BEARER_TOKEN', authFields: { token: 'tok-1' }, body_type: 'json', body: { data: { name: 'a' } } });
    const basicInput = saved({ authType: 'BASIC', authFields: { username: 'u', password: 'p' }, body_type: 'none' });
    const http1 = require('node:http') as typeof import('node:http') & { request: (...args: unknown[]) => unknown };
    const dns = require('node:dns') as { lookup: (...args: unknown[]) => void };
    const realRequest = http1.request;
    const realLookup = dns.lookup;
    const sent: Array<{ headers: Record<string, unknown>; body: string }> = [];
    // A public address, so the egress guard lets the request through to the transport, which records it.
    dns.lookup = ((_host: string, _opts: unknown, cb: (e: null, a: unknown) => void) => cb(null, [{ address: '93.184.216.34', family: 4 }])) as never;
    http1.request = ((...args: unknown[]) => {
      const options = args.find((a) => a && typeof a === 'object' && !(a instanceof URL)) as { headers?: Record<string, unknown> } | undefined;
      const record = { headers: Object.fromEntries(Object.entries(options?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), body: '' };
      sent.push(record);
      const { EventEmitter } = require('node:events') as typeof import('node:events');
      const req = new EventEmitter() as import('node:events').EventEmitter & Record<string, unknown>;
      req.write = (chunk: unknown) => { record.body += String(chunk); return true; };
      req.end = (chunk?: unknown) => { if (chunk) record.body += String(chunk); queueMicrotask(() => req.emit('error', new Error('stop: request captured'))); };
      req.destroy = () => req; req.setTimeout = () => req; req.setNoDelay = () => req; req.setSocketKeepAlive = () => req; req.flushHeaders = () => undefined;
      return req;
    }) as never;
    try {
      await run({ propsValue: bearerInput }).catch(() => undefined);
      await run({ propsValue: basicInput }).catch(() => undefined);
    } finally {
      http1.request = realRequest;
      dns.lookup = realLookup;
    }
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[0]!.headers.authorization).toBe('Bearer tok-1');
    expect(sent[0]!.body).toBe(JSON.stringify({ name: 'a' }));
    expect(sent[1]!.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });
});
