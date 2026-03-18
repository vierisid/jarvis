/**
 * J.A.R.V.I.S. Doctor — Environment Diagnostics
 *
 * Checks system requirements, configuration, and connectivity.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import {
  c, printBanner, printOk, printWarn, printErr, printInfo, startSpinner, closeRL,
} from './helpers.ts';

const JARVIS_DIR = join(homedir(), '.jarvis');
const CONFIG_PATH = join(JARVIS_DIR, 'config.yaml');

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  message: string;
}

export async function runDoctor(): Promise<void> {
  printBanner();
  console.log(c.bold('Running system diagnostics...\n'));

  const results: CheckResult[] = [];

  // ── Check 1: Bun Version ──────────────────────────────────────────

  const bunVersion = Bun.version;
  const [major] = bunVersion.split('.').map(Number);
  if (major! >= 1) {
    results.push({ name: 'Bun Runtime', status: 'ok', message: `v${bunVersion}` });
  } else {
    results.push({ name: 'Bun Runtime', status: 'warn', message: `v${bunVersion} (>= 1.0.0 recommended)` });
  }

  // ── Check 2: Data Directory ───────────────────────────────────────

  if (existsSync(JARVIS_DIR)) {
    results.push({ name: 'Data Directory', status: 'ok', message: JARVIS_DIR });
  } else {
    results.push({ name: 'Data Directory', status: 'warn', message: `${JARVIS_DIR} not found. Run: jarvis onboard` });
  }

  // ── Check 3: Config File ──────────────────────────────────────────

  let config: any = null;
  if (existsSync(CONFIG_PATH)) {
    try {
      const YAML = (await import('yaml')).default;
      const text = readFileSync(CONFIG_PATH, 'utf-8');
      config = YAML.parse(text);
      results.push({ name: 'Config File', status: 'ok', message: CONFIG_PATH });
    } catch (err) {
      results.push({ name: 'Config File', status: 'fail', message: `Invalid YAML: ${err}` });
    }
  } else {
    results.push({ name: 'Config File', status: 'fail', message: 'Not found. Run: jarvis onboard' });
  }

  // ── Check 4: LLM API Key ─────────────────────────────────────────

  if (config) {
    const primary = config.llm?.primary ?? 'anthropic';
    const providerConfig = config.llm?.[primary];

    if (primary === 'ollama') {
      results.push({ name: 'LLM Provider', status: 'ok', message: `ollama (${providerConfig?.model ?? 'llama3'})` });
    } else if (providerConfig?.api_key && providerConfig.api_key !== '') {
      results.push({
        name: 'LLM Provider',
        status: 'ok',
        message: `${primary} (key: ${providerConfig.api_key.slice(0, 10)}...)`,
      });
    } else {
      results.push({ name: 'LLM Provider', status: 'fail', message: `${primary} API key not set` });
    }
  } else {
    results.push({ name: 'LLM Provider', status: 'skip', message: 'No config file' });
  }

  // ── Check 5: LLM Connectivity ────────────────────────────────────

  if (config) {
    const spin = startSpinner('Testing LLM connectivity...');
    try {
      const { LLMManager, AnthropicProvider, OpenAIProvider, GeminiProvider, OllamaProvider, OpenRouterProvider } = await import('../llm/index.ts');
      const manager = new LLMManager();
      const primary = config.llm?.primary ?? 'anthropic';

      if (primary === 'anthropic' && config.llm?.anthropic?.api_key) {
        manager.registerProvider(new AnthropicProvider(config.llm.anthropic.api_key, config.llm.anthropic.model));
      } else if (primary === 'openai' && config.llm?.openai?.api_key) {
        manager.registerProvider(new OpenAIProvider(config.llm.openai.api_key, config.llm.openai.model));
      } else if (primary === 'gemini' && config.llm?.gemini?.api_key) {
        manager.registerProvider(new GeminiProvider(config.llm.gemini.api_key, config.llm.gemini.model));
      } else if (primary === 'openrouter' && config.llm?.openrouter?.api_key) {
        manager.registerProvider(new OpenRouterProvider(config.llm.openrouter.api_key, config.llm.openrouter.model));
      } else if (primary === 'ollama') {
        manager.registerProvider(new OllamaProvider(config.llm.ollama?.base_url, config.llm.ollama?.model));
      }

      manager.setPrimary(primary);
      const resp = await manager.chat(
        [{ role: 'user', content: 'Say OK' }],
        { max_tokens: 10 },
      );
      spin.stop();
      results.push({ name: 'LLM Connectivity', status: 'ok', message: `Model: ${resp.model}` });
    } catch (err) {
      spin.stop();
      results.push({ name: 'LLM Connectivity', status: 'fail', message: String(err).slice(0, 100) });
    }
  } else {
    results.push({ name: 'LLM Connectivity', status: 'skip', message: 'No config file' });
  }

  // ── Check 6: Browser (Chromium/Chrome) ────────────────────────────

  const browserPaths = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];

  const foundBrowser = browserPaths.find(p => existsSync(p));
  if (foundBrowser) {
    results.push({ name: 'Browser', status: 'ok', message: foundBrowser });
  } else {
    // Try which
    const which = Bun.spawnSync(['which', 'chromium-browser']);
    if (which.exitCode === 0) {
      results.push({ name: 'Browser', status: 'ok', message: which.stdout.toString().trim() });
    } else {
      results.push({ name: 'Browser', status: 'warn', message: 'Chromium/Chrome not found. Browser tools will be limited.' });
    }
  }

  // ── Check 7: Port Availability ────────────────────────────────────

  const port = config?.daemon?.port ?? 3142;
  try {
    const server = Bun.serve({ port, fetch: () => new Response('') });
    server.stop(true);
    results.push({ name: 'Port', status: 'ok', message: `${port} is available` });
  } catch {
    results.push({ name: 'Port', status: 'warn', message: `${port} is in use (daemon may already be running)` });
  }

  // ── Check 8: SQLite ───────────────────────────────────────────────

  try {
    const { Database } = await import('bun:sqlite');
    const db = new Database(':memory:');
    db.run('CREATE TABLE test (id INTEGER PRIMARY KEY)');
    db.close();
    results.push({ name: 'SQLite', status: 'ok', message: 'bun:sqlite working' });
  } catch (err) {
    results.push({ name: 'SQLite', status: 'fail', message: String(err) });
  }

  // ── Check 9: TTS/STT Providers ────────────────────────────────────

  if (config?.tts?.enabled) {
    results.push({ name: 'TTS', status: 'ok', message: `${config.tts.provider ?? 'edge'} (${config.tts.voice ?? 'default'})` });
  } else {
    results.push({ name: 'TTS', status: 'skip', message: 'Disabled' });
  }

  if (config?.stt?.provider) {
    const sttProv = config.stt.provider;
    const hasKey = sttProv === 'ollama' || sttProv === 'local'
      || (sttProv === 'openai' && config.stt.openai?.api_key)
      || (sttProv === 'groq' && config.stt.groq?.api_key);
    results.push({
      name: 'STT',
      status: hasKey ? 'ok' : 'warn',
      message: hasKey ? `${sttProv} configured` : `${sttProv} (API key missing)`,
    });
  } else {
    results.push({ name: 'STT', status: 'skip', message: 'Not configured' });
  }

  // ── Check 11: Channels ────────────────────────────────────────────

  if (config?.channels?.telegram?.enabled && config.channels.telegram.bot_token) {
    results.push({ name: 'Telegram', status: 'ok', message: 'Bot token set' });
  } else {
    results.push({ name: 'Telegram', status: 'skip', message: 'Not configured' });
  }

  if (config?.channels?.discord?.enabled && config.channels.discord.bot_token) {
    results.push({ name: 'Discord', status: 'ok', message: 'Bot token set' });
  } else {
    results.push({ name: 'Discord', status: 'skip', message: 'Not configured' });
  }

  // ── Results ───────────────────────────────────────────────────────

  console.log(c.bold('\nDiagnostics Results:\n'));

  let okCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const r of results) {
    const icon = r.status === 'ok' ? c.green('✓')
      : r.status === 'warn' ? c.yellow('!')
      : r.status === 'fail' ? c.red('✗')
      : c.dim('○');

    const nameStr = r.name.padEnd(20);
    console.log(`  ${icon} ${nameStr} ${c.dim(r.message)}`);

    if (r.status === 'ok') okCount++;
    else if (r.status === 'warn') warnCount++;
    else if (r.status === 'fail') failCount++;
  }

  console.log('');
  console.log(`  ${c.green(`${okCount} passed`)}  ${c.yellow(`${warnCount} warnings`)}  ${c.red(`${failCount} failed`)}`);

  if (failCount > 0) {
    console.log(c.red('\nSome checks failed. Run "jarvis onboard" to fix configuration.\n'));
  } else if (warnCount > 0) {
    console.log(c.yellow('\nAll critical checks passed, but some optional features need setup.\n'));
  } else {
    console.log(c.green('\nAll checks passed! JARVIS is ready.\n'));
  }

  closeRL();
}
