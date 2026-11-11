import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDatabase } from './schema.ts';
import { getWebappTemplateByName } from './webapp-templates.ts';
import { seedWebappTemplates } from './webapp-template-seeds.ts';
import { canWriteOrCreate, homeJarvisDirFor } from '../util/jarvis-dirs.ts';
import { spawnSync } from 'node:child_process';

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
    expect(canWriteOrCreate('/nonexistent/qa4C/.jarvis/cache')).toBe(false);
  });

  test('a writable home keeps ~/.jarvis even when a data dir is set', () => {
    const home = join(root, 'home');
    mkdirSync(home);
    expect(homeJarvisDirFor(home, join(root, 'data'), 'cache')).toBe(join(home, '.jarvis', 'cache'));
  });

  test('an unusable home with a data dir uses the data dir; with none it keeps the home path', () => {
    expect(homeJarvisDirFor('/nonexistent/qa4C', join(root, 'data'), 'cache', 'piece-metadata.json')).toBe(join(root, 'data', 'cache', 'piece-metadata.json'));
    expect(homeJarvisDirFor('/nonexistent/qa4C', join(root, 'data'))).toBe(join(root, 'data'));
    expect(homeJarvisDirFor('/nonexistent/qa4C', undefined, 'cache')).toBe('/nonexistent/qa4C/.jarvis/cache');
    expect(homeJarvisDirFor('/nonexistent/qa4C', '  ', 'cache')).toBe('/nonexistent/qa4C/.jarvis/cache');
  });
});

describe('run logs and Google tokens follow the data dir', () => {
  test('logs go to JARVIS_HOME, and an earlier backup under the old home location is still found and removed with its run', async () => {
    const { workflowLogsBase, legacyWorkflowLogsBase } = await import('../workflows/sandbox-api/config.ts');
    const prev = { a: process.env.JARVIS_WORKFLOW_DATA_DIR, b: process.env.JARVIS_HOME };
    delete process.env.JARVIS_WORKFLOW_DATA_DIR;
    process.env.JARVIS_HOME = join(root, 'data');
    try {
      expect(workflowLogsBase()).toBe(join(root, 'data', 'workflow-logs'));
      expect(legacyWorkflowLogsBase()).not.toBe(workflowLogsBase());
    } finally {
      if (prev.a === undefined) delete process.env.JARVIS_WORKFLOW_DATA_DIR; else process.env.JARVIS_WORKFLOW_DATA_DIR = prev.a;
      if (prev.b === undefined) delete process.env.JARVIS_HOME; else process.env.JARVIS_HOME = prev.b;
    }
  });

  test('the Google tokens path is inside JARVIS_HOME, unless only the old home file exists', async () => {
    const { googleTokensPath } = await import('../integrations/google-auth.ts');
    process.env.JARVIS_HOME = join(root, 'data');
    // Only whether the old file exists matters here; it is never opened.
    const legacy = join(homedir(), '.jarvis', 'google-tokens.json');
    expect(googleTokensPath()).toBe(existsSync(legacy) ? legacy : join(root, 'data', 'google-tokens.json'));
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'google-tokens.json'), '{}');
    expect(googleTokensPath()).toBe(join(root, 'data', 'google-tokens.json'));
    delete process.env.JARVIS_HOME;
    expect(googleTokensPath()).toMatch(/\.jarvis[\\/]google-tokens\.json$/);
  });
});
