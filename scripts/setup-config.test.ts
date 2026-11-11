import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type JarvisConfig } from '../src/config/types.ts';
import { closeDb, initDatabase } from '../src/vault/schema.ts';
import { saveLLMSettings } from '../src/daemon/llm-settings.ts';
import { getSetting, setSetting } from '../src/vault/settings.ts';
import { testProviders } from './setup-config.ts';

// `bun run setup` used to read config.llm.anthropic / openai / ollama, keys
// loadConfig always discards, so it reported "No working providers found!"
// on every install whose providers were saved in the dashboard. These tests
// seed providers the way the dashboard does (saveLLMSettings into the DB)
// and check the setup script finds and tests them.

let dir: string;
let previousSecretsDir: string | undefined;
let server: ReturnType<typeof Bun.serve>;
let chatCalls = 0;
let compatAuth: string[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-setup-config-'));
  previousSecretsDir = process.env.JARVIS_SECRETS_DIR;
  process.env.JARVIS_SECRETS_DIR = join(dir, 'secrets');
  // A stand-in Ollama: the provider test sends one chat to /api/chat.
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/chat') {
        chatCalls++;
        return Response.json({
          model: 'llama3.2:1b',
          message: { role: 'assistant', content: 'OK' },
          done: true,
          prompt_eval_count: 3,
          eval_count: 1,
        });
      }
      if (url.pathname === '/v1/chat/completions') {
        compatAuth.push(req.headers.get('authorization') ?? '');
        return Response.json({
          id: 'c1',
          model: 'stub-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        });
      }
      if (url.pathname === '/broken/api/chat') return new Response('model exploded', { status: 500 });
      return new Response('not found', { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  if (previousSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
  else process.env.JARVIS_SECRETS_DIR = previousSecretsDir;
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => closeDb());

function configAt(dbPath: string): JarvisConfig {
  const config: JarvisConfig = structuredClone(DEFAULT_CONFIG);
  config.daemon.data_dir = dir;
  config.daemon.db_path = dbPath;
  return config;
}

function seed(dbPath: string, baseUrl: string): void {
  initDatabase(dbPath, { quiet: true });
  saveLLMSettings(configAt(dbPath), {
    providers: { ollama: { kind: 'ollama', base_url: baseUrl } },
    default: 'ollama:llama3.2:1b',
  });
  closeDb();
}

describe('setup-config testProviders', () => {
  test('finds and tests a provider saved in the dashboard', async () => {
    const dbPath = join(dir, 'saved.db');
    seed(dbPath, `http://127.0.0.1:${server.port}`);
    chatCalls = 0;

    const lines: string[] = [];
    const results = await testProviders(configAt(dbPath), (l) => lines.push(l));

    expect(results).toEqual([{ name: 'ollama', status: 'ok', detail: 'model llama3.2:1b' }]);
    expect(chatCalls).toBe(1);
    const out = lines.join('\n');
    expect(out).toContain('Default LLM: ollama:llama3.2:1b');
    expect(out).toContain('Providers: ollama');
    expect(out).not.toContain('No working providers found');
  });

  test('reports a saved provider whose test fails as failed', async () => {
    const dbPath = join(dir, 'dead.db');
    seed(dbPath, `http://127.0.0.1:${server.port}/broken`);

    const lines: string[] = [];
    const results = await testProviders(configAt(dbPath), (l) => lines.push(l));

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('ollama');
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.detail).toContain('model exploded');
    expect(lines.join('\n')).toContain('No working providers found');
  });

  test('a missing database is reported, not created', async () => {
    const dbPath = join(dir, 'never-started.db');

    const lines: string[] = [];
    const results = await testProviders(configAt(dbPath), (l) => lines.push(l));

    expect(results).toEqual([]);
    expect(existsSync(dbPath)).toBe(false);
    expect(lines.join('\n')).toContain(`No database yet at ${dbPath}`);
  });

  test('a database with no saved providers reports none working', async () => {
    const dbPath = join(dir, 'empty.db');
    initDatabase(dbPath, { quiet: true });
    closeDb();

    const lines: string[] = [];
    const results = await testProviders(configAt(dbPath), (l) => lines.push(l));

    expect(results).toEqual([]);
    const out = lines.join('\n');
    expect(out).toContain('Providers: (none)');
    expect(out).toContain('No working providers found');
  });

  test('a key saved to the keychain reaches the provider test', async () => {
    const dbPath = join(dir, 'keyed.db');
    initDatabase(dbPath, { quiet: true });
    saveLLMSettings(configAt(dbPath), {
      providers: {
        compat: { kind: 'openai_compatible', base_url: `http://127.0.0.1:${server.port}/v1`, api_key: 'sk-setup-test' },
      },
      default: 'compat:stub-model',
    });
    // saveLLMSettings keeps the key out of the DB; it lives in the keychain.
    expect(getSetting('llm.providers') ?? '').not.toContain('sk-setup-test');
    closeDb();
    compatAuth = [];

    const results = await testProviders(configAt(dbPath), () => {});

    expect(results).toEqual([{ name: 'compat', status: 'ok', detail: 'model stub-model' }]);
    expect(compatAuth).toEqual(['Bearer sk-setup-test']);
  });

  test('repairs the merge makes in memory are not written back', async () => {
    const dbPath = join(dir, 'dirty.db');
    seed(dbPath, `http://127.0.0.1:${server.port}`);
    // A ref to a provider that no longer exists: the merge prunes it, and
    // with persistence on that prune would be saved over the user's row.
    initDatabase(dbPath, { quiet: true });
    setSetting('llm.tiers.high', 'gone:some-model');
    closeDb();

    await testProviders(configAt(dbPath), () => {});
    closeDb();

    initDatabase(dbPath, { quiet: true });
    expect(getSetting('llm.tiers.high')).toBe('gone:some-model');
  });

  test('a hosted install shows the plan tiers and skips the managed provider', async () => {
    const dbPath = join(dir, 'hosted.db');
    initDatabase(dbPath, { quiet: true });
    closeDb();
    const config = configAt(dbPath);
    config.usejarvis_ai = { base_url: 'https://llm.example.test', api_key: 'sk-uj-test' };

    const lines: string[] = [];
    const results = await testProviders(config, (l) => lines.push(l));

    expect(results).toEqual([
      { name: 'usejarvis_ai', status: 'skipped', detail: 'managed by your hosted plan, not tested here' },
    ]);
    const out = lines.join('\n');
    expect(out).toContain('medium=usejarvis_ai:uj-medium');
    expect(out).not.toContain('No working providers found');
  });
});
