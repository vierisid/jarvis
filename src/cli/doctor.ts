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
import { detectInstallMethod, describeInstallMethod, getMethodCommands } from './install-method.ts';

const JARVIS_DIR = join(homedir(), '.jarvis');
const CONFIG_PATH = join(JARVIS_DIR, 'config.yaml');
const PACKAGE_ROOT = join(import.meta.dir, '..', '..');

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

  // ── Check 2: Install Method ───────────────────────────────────────

  const installInfo = detectInstallMethod(PACKAGE_ROOT);
  const installMessage = `${describeInstallMethod(installInfo)} — ${installInfo.reason}`;
  results.push({
    name: 'Install Method',
    status: installInfo.method === 'unknown' ? 'warn' : 'ok',
    message: installMessage,
  });

  // ── Check 3: Data Directory ───────────────────────────────────────

  if (existsSync(JARVIS_DIR)) {
    results.push({ name: 'Data Directory', status: 'ok', message: JARVIS_DIR });
  } else {
    results.push({ name: 'Data Directory', status: 'warn', message: `${JARVIS_DIR} not found. Run: jarvis start (then finish setup at http://localhost:3142)` });
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
    results.push({ name: 'Config File', status: 'fail', message: 'Not found. Run: jarvis start (then finish setup at http://localhost:3142)' });
  }

  // ── Check 4: LLM API Key ─────────────────────────────────────────

  // LLM config is owned by the DB + encrypted keychain (managed from the
  // settings dashboard) - not config.yaml. Load it the same way the daemon
  // does so the diagnostic reflects real runtime routing.
  let llmConfig: any = null;
  let llmProviderNames: string[] = [];
  try {
    const { loadConfig } = await import('../config/loader.ts');
    const { initDatabase } = await import('../vault/schema.ts');
    const { mergeLLMSettingsIntoConfig } = await import('../daemon/llm-settings.ts');
    llmConfig = await loadConfig();
    initDatabase(llmConfig.daemon.db_path);
    mergeLLMSettingsIntoConfig(llmConfig);
    llmProviderNames = Object.keys(llmConfig.llm.providers ?? {});
  } catch (err) {
    results.push({ name: 'LLM Provider', status: 'fail', message: `Could not load LLM settings: ${String(err).slice(0, 80)}` });
  }

  if (llmConfig) {
    if (llmProviderNames.length === 0) {
      results.push({ name: 'LLM Provider', status: 'fail', message: 'No providers configured. Add one in Settings > LLM (http://localhost:3142).' });
    } else {
      const tiers = llmConfig.llm.tiers ?? {};
      const tierSummary = Object.entries(tiers).map(([t, v]) => `${t}=${v}`).join(', ');
      const mode = tierSummary ? `tiers: ${tierSummary}` : (llmConfig.llm.default ? `default: ${llmConfig.llm.default}` : 'no model assigned');
      results.push({ name: 'LLM Provider', status: 'ok', message: `${llmProviderNames.length} provider(s): ${llmProviderNames.join(', ')} (${mode})` });
    }
  }

  // ── Check 5: LLM Connectivity ────────────────────────────────────

  if (llmConfig && llmProviderNames.length > 0) {
    const spin = startSpinner('Testing LLM connectivity...');
    try {
      const { LLMManager } = await import('../llm/index.ts');
      const { registerLLMProviders, configureLLMTiers } = await import('../llm/config-binding.ts');
      const manager = new LLMManager();
      registerLLMProviders(manager, llmConfig.llm.providers ?? {});
      configureLLMTiers(manager, llmConfig.llm);
      // manager.chat() routes through the medium tier (with fall-up) when a
      // tier/default is configured, else the first registered provider.
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
    results.push({ name: 'LLM Connectivity', status: 'skip', message: 'No providers configured' });
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
    console.log(c.red('\nSome checks failed. Run "jarvis start" and finish setup at http://localhost:3142 to fix configuration.\n'));
  } else if (warnCount > 0) {
    console.log(c.yellow('\nAll critical checks passed, but some optional features need setup.\n'));
  } else {
    console.log(c.green('\nAll checks passed! JARVIS is ready.\n'));
  }

  const commands = getMethodCommands(installInfo.method);
  console.log(c.bold('Manage this install:'));
  console.log(`  ${c.cyan('Update:   ')} ${commands.update}`);
  console.log(`  ${c.cyan('Uninstall:')} ${commands.uninstall}`);
  console.log('');

  closeRL();
}
