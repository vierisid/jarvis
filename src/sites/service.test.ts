import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteBuilderService } from './service.ts';
import type { SiteBuilderConfig } from './types.ts';

/**
 * `sites.auto_commit` gates the commits the site builder makes on its own
 * (after a project chat turn, after an editor save). These run real git in a
 * temp repo: GitManager spawns with a sanitized env, so a GIT_DIR inherited
 * from the pre-commit hook cannot point them at this repository. HOME and
 * XDG_CONFIG_HOME point at the temp dir too (sanitizedEnv reads them at spawn
 * time), so a developer's global commit.gpgsign or core.hooksPath cannot make
 * these commits prompt, hang or fail.
 */

function config(projectsDir: string, autoCommit?: boolean): SiteBuilderConfig {
  const c: Partial<SiteBuilderConfig> = {
    enabled: true,
    projects_dir: projectsDir,
    port_range_start: 39100,
    port_range_end: 39199,
    max_concurrent_servers: 1,
  };
  if (autoCommit !== undefined) c.auto_commit = autoCommit;
  return c as SiteBuilderConfig;
}

describe('SiteBuilderService auto-commit gate', () => {
  let projectsDir: string;
  let projectPath: string;
  const savedEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), 'jarvis-sites-autocommit-'));
    projectPath = join(projectsDir, 'app');
    await mkdir(projectPath);
    process.env.HOME = projectsDir;
    process.env.XDG_CONFIG_HOME = join(projectsDir, '.config');
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(projectsDir, { recursive: true, force: true });
  });

  async function dirtyRepo(svc: SiteBuilderService): Promise<void> {
    await svc.gitManager.init(projectPath, { name: 'Test', email: 'test@example.invalid', global: false });
    await writeFile(join(projectPath, 'index.html'), '<h1>hi</h1>');
  }

  test('off: the implicit commit is skipped and the tree stays dirty', async () => {
    const svc = new SiteBuilderService(config(projectsDir, false));
    await dirtyRepo(svc);

    expect(svc.autoCommitEnabled).toBe(false);
    expect(await svc.autoCommitIfEnabled(projectPath, 'turn')).toBeNull();
    expect(await svc.gitManager.isDirty(projectPath)).toBe(true);
    expect((await svc.gitManager.getLog(projectPath)).map((c) => c.message)).toEqual(['Initial commit']);
  });

  test('off: an explicit commit still goes through', async () => {
    const svc = new SiteBuilderService(config(projectsDir, false));
    await dirtyRepo(svc);

    const commit = await svc.gitManager.autoCommit(projectPath, 'explicit');
    expect(commit?.message).toBe('explicit');
    expect(await svc.gitManager.isDirty(projectPath)).toBe(false);
  });

  test('on: the implicit commit lands', async () => {
    const svc = new SiteBuilderService(config(projectsDir, true));
    await dirtyRepo(svc);

    expect(svc.autoCommitEnabled).toBe(true);
    const commit = await svc.autoCommitIfEnabled(projectPath, 'turn');
    expect(commit?.message).toBe('turn');
    expect(await svc.gitManager.isDirty(projectPath)).toBe(false);
  });

  test('absent: keeps the historical always-commit behaviour', async () => {
    const svc = new SiteBuilderService(config(projectsDir));
    await dirtyRepo(svc);

    expect(svc.autoCommitEnabled).toBe(true);
    expect((await svc.autoCommitIfEnabled(projectPath, 'turn'))?.message).toBe('turn');
  });
});
