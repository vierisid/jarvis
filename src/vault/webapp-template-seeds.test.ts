import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDatabase } from './schema.ts';
import { getWebappTemplateByName } from './webapp-templates.ts';
import { seedWebappTemplates } from './webapp-template-seeds.ts';
import { canWriteOrCreate, homeJarvisDirFor, siteProjectsDir } from '../util/jarvis-dirs.ts';
import { spawnSync } from 'node:child_process';
import { zstdCompressSync } from 'node:zlib';

const yaml = (name: string, text: string) =>
  `app_name: ${name}\ndomains: [${name}.example]\ndescription: d\ninstructions: ${text}\n`;

let root: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  initDatabase(':memory:', { quiet: true });
  root = mkdtempSync(join(tmpdir(), 'jarvis-seeds-'));
  saved = { HOME: process.env.HOME, JARVIS_HOME: process.env.JARVIS_HOME };
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

function dirs() {
  const builtin = join(root, 'builtin'), legacy = join(root, 'home-jarvis', 'webapp-templates'), data = join(root, 'data');
  mkdirSync(builtin, { recursive: true }); mkdirSync(legacy, { recursive: true }); mkdirSync(data, { recursive: true });
  writeFileSync(join(builtin, 'alpha.yaml'), yaml('alpha', 'built-in alpha'));
  writeFileSync(join(builtin, 'beta.yaml'), yaml('beta', 'built-in beta'));
  return { builtin, legacy, data };
}

describe('webapp templates are seeded from inside the data dir (C-5)', () => {
  test('a home that cannot be written does not stop startup: a real process seeds into the data dir and never touches HOME', () => {
    const { data } = dirs();
    const script = join(root, 'seed.ts');
    writeFileSync(script, [
      `import { initDatabase } from ${JSON.stringify(join(import.meta.dir, 'schema.ts'))};`,
      `import { seedWebappTemplates } from ${JSON.stringify(join(import.meta.dir, 'webapp-template-seeds.ts'))};`,
      `import { listWebappTemplates } from ${JSON.stringify(join(import.meta.dir, 'webapp-templates.ts'))};`,
      `initDatabase(':memory:', { quiet: true });`,
      `seedWebappTemplates();`,
      `console.log('SEEDED ' + listWebappTemplates(false).length);`,
    ].join('\n'));
    const r = spawnSync(process.execPath, ['--no-env-file', script], {
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent/qa4C', JARVIS_HOME: data }, encoding: 'utf8',
    });
    expect(r.stderr).not.toContain('EACCES');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/SEEDED [1-9]/);
    expect(existsSync(join(data, 'webapp-templates'))).toBe(true);
    expect(existsSync('/nonexistent')).toBe(false);
  }, 30_000);

  test('overrides in the data dir win over built-in ones; an earlier install\'s folder is still read but never written', () => {
    const { builtin, legacy, data } = dirs();
    writeFileSync(join(legacy, 'beta.yaml'), yaml('beta', 'from the old home folder'));
    writeFileSync(join(legacy, 'gamma.yaml'), yaml('gamma', 'only in the old home folder'));
    writeFileSync(join(data, 'x'), '');
    mkdirSync(join(data, 'webapp-templates'));
    writeFileSync(join(data, 'webapp-templates', 'alpha.yaml'), yaml('alpha', 'from the data dir'));
    const before = readdirSync(legacy).sort();
    seedWebappTemplates({ builtinDir: builtin, dataDir: data, legacyDir: legacy });
    expect(getWebappTemplateByName('alpha')?.instructions).toBe('from the data dir');
    expect(getWebappTemplateByName('beta')?.instructions).toBe('from the old home folder');
    expect(getWebappTemplateByName('gamma')?.instructions).toBe('only in the old home folder');
    expect(readdirSync(legacy).sort()).toEqual(before);
  });

  test('a data dir that cannot be created is skipped, not fatal, and built-in templates still load', () => {
    const { builtin, data } = dirs();
    const blocked = join(data, 'a-file');
    writeFileSync(blocked, 'not a folder');
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => { warnings.push(String(m)); };
    try { expect(() => seedWebappTemplates({ builtinDir: builtin, dataDir: blocked, legacyDir: join(root, 'none') })).not.toThrow(); }
    finally { console.warn = warn; }
    expect(warnings.join('\n')).toContain('Could not create');
    expect(getWebappTemplateByName('beta')?.instructions).toBe('built-in beta');
  });

  test('home and data dir the same place is read once', () => {
    const { builtin, data } = dirs();
    mkdirSync(join(data, 'webapp-templates'));
    writeFileSync(join(data, 'webapp-templates', 'delta.yaml'), yaml('delta', 'same folder'));
    seedWebappTemplates({ builtinDir: builtin, dataDir: data, legacyDir: join(data, 'webapp-templates') });
    expect(getWebappTemplateByName('delta')?.instructions).toBe('same folder');
  });
});

describe('homeJarvisDir keeps the home location unless it cannot be used', () => {
  test('canWriteOrCreate looks at the nearest folder that exists', () => {
    expect(canWriteOrCreate(join(root, 'a', 'b', 'c'))).toBe(true);
    // root can create anything under /, so only a normal user sees the refusal.
    if (process.getuid?.() !== 0) expect(canWriteOrCreate('/nonexistent/qa4C/.jarvis/cache')).toBe(false);
  });

  test('a writable home keeps ~/.jarvis even when a data dir is set', () => {
    const home = join(root, 'home');
    mkdirSync(home);
    expect(homeJarvisDirFor(home, join(root, 'data'), 'cache')).toBe(join(home, '.jarvis', 'cache'));
  });

  test('the default site projects folder follows the same rule; a configured one is used as given', () => {
    expect(siteProjectsDir('/srv/sites')).toBe('/srv/sites');
    expect(siteProjectsDir('~/my-sites')).toBe(join(homedir(), 'my-sites'));
    // The config defaults always fill in ~/.jarvis/projects, so it must not be taken literally.
    // The config defaults always fill in ~/.jarvis/projects, so with a home
    // that cannot be written it must still land in the data dir.
    const script = join(root, 'projects.ts');
    writeFileSync(script, [
      `import { siteProjectsDir } from ${JSON.stringify(join(import.meta.dir, '..', 'util', 'jarvis-dirs.ts'))};`,
      `console.log(JSON.stringify([siteProjectsDir('~/.jarvis/projects'), siteProjectsDir(undefined), siteProjectsDir('/srv/x')]));`,
    ].join('\n'));
    const r = spawnSync(process.execPath, ['--no-env-file', script], {
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent/qa4C', JARVIS_HOME: join(root, 'data') }, encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const projects = join(root, 'data', 'projects');
    if (process.getuid?.() !== 0) expect(JSON.parse(r.stdout)).toEqual([projects, projects, '/srv/x']);
  });

  test('an unusable home with a data dir uses the data dir; with none it keeps the home path', () => {
    expect(homeJarvisDirFor('/nonexistent/qa4C', join(root, 'data'), 'cache', 'piece-metadata.json')).toBe(join(root, 'data', 'cache', 'piece-metadata.json'));
    expect(homeJarvisDirFor('/nonexistent/qa4C', join(root, 'data'))).toBe(join(root, 'data'));
    expect(homeJarvisDirFor('/nonexistent/qa4C', undefined, 'cache')).toBe('/nonexistent/qa4C/.jarvis/cache');
    expect(homeJarvisDirFor('/nonexistent/qa4C', '  ', 'cache')).toBe('/nonexistent/qa4C/.jarvis/cache');
  });
});

describe('run logs and Google tokens follow the data dir', () => {
  test('logs go to JARVIS_HOME, and an earlier backup under the old home location is still found and removed with its run', () => {
    // A child process, because os.homedir() is fixed at startup: HOME points
    // at a temp folder, so neither side touches the real ~/.jarvis.
    const home = join(root, 'home'), data = join(root, 'data');
    mkdirSync(join(home, '.jarvis', 'workflow-logs'), { recursive: true });
    mkdirSync(data, { recursive: true });
    const legacyBin = join(home, '.jarvis', 'workflow-logs', 'runLegacy1.bin');
    writeFileSync(legacyBin, zstdCompressSync(Buffer.from(JSON.stringify({ executionState: { steps: { a: { status: 'SUCCEEDED' } }, tags: ['t'] } }))));
    const script = join(root, 'logs.ts');
    const wf = join(import.meta.dir, '..', 'workflows');
    writeFileSync(script, [
      `import { workflowLogsBase, legacyWorkflowLogsBase } from ${JSON.stringify(join(wf, 'sandbox-api', 'config.ts'))};`,
      `import { loadExecutionStateFromLog } from ${JSON.stringify(join(wf, 'runner', 'engine-runtime', 'execution-state-loader.ts'))};`,
      `import { removeRunFiles } from ${JSON.stringify(join(wf, 'db', 'repos', 'flow-deletion.ts'))};`,
      `const state = await loadExecutionStateFromLog('runLegacy1');`,
      `const missing = await loadExecutionStateFromLog('runNone1');`,
      `removeRunFiles(['runLegacy1']);`,
      `console.log(JSON.stringify({ base: workflowLogsBase(), legacy: legacyWorkflowLogsBase(), state, missing }));`,
    ].join('\n'));
    const r = spawnSync(process.execPath, ['--no-env-file', script], {
      env: { PATH: process.env.PATH ?? '', HOME: home, JARVIS_HOME: data, TMPDIR: tmpdir() }, encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(out.base).toBe(join(data, 'workflow-logs'));
    expect(out.legacy).toBe(join(home, '.jarvis', 'workflow-logs'));
    expect(out.state).toEqual({ steps: { a: { status: 'SUCCEEDED' } }, tags: ['t'] });
    expect(out.missing).toBeNull();
    expect(existsSync(legacyBin)).toBe(false);
  }, 30_000);

  test('the Google tokens path is inside JARVIS_HOME, unless only the old home file exists', async () => {
    const { googleTokensPath } = await import('../integrations/google-auth.ts');
    // A temp home, so the real ~/.jarvis is never looked at.
    const home = join(root, 'home'), data = join(root, 'data');
    const legacy = join(home, '.jarvis', 'google-tokens.json'), own = join(data, 'google-tokens.json');
    const env = { JARVIS_HOME: data };
    expect(googleTokensPath(env, home)).toBe(own);
    mkdirSync(join(home, '.jarvis'), { recursive: true });
    writeFileSync(legacy, '{}');
    expect(googleTokensPath(env, home)).toBe(legacy);
    mkdirSync(data, { recursive: true });
    writeFileSync(own, '{}');
    expect(googleTokensPath(env, home)).toBe(own);
    expect(googleTokensPath({}, home)).toBe(legacy);
  });
});
