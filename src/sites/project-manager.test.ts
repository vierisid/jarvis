import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectManager } from './project-manager.ts';

function makeManager(projectsDir: string): ProjectManager {
  return new ProjectManager({
    enabled: true,
    projects_dir: projectsDir,
    port_range_start: 3000,
    port_range_end: 3999,
    auto_commit: false,
    max_concurrent_servers: 1,
  });
}

describe('ProjectManager path containment', () => {
  test('returns null for project ids that resolve outside projects dir', async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), 'jarvis-sites-'));
    try {
      const manager = makeManager(projectsDir);

      expect(manager.getProjectPath('../etc')).toBe(null);
    } finally {
      await rm(projectsDir, { recursive: true, force: true });
    }
  });

  test('blocks sibling directory traversal with a shared prefix', async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), 'jarvis-sites-'));
    try {
      await mkdir(join(projectsDir, 'app'), { recursive: true });
      await mkdir(join(projectsDir, 'app-backup'), { recursive: true });
      const manager = makeManager(projectsDir);

      await expect(manager.writeFile('app', '../app-backup/pwned.txt', 'owned'))
        .rejects.toThrow('Path traversal attempt blocked');
      expect(existsSync(join(projectsDir, 'app-backup', 'pwned.txt'))).toBe(false);
    } finally {
      await rm(projectsDir, { recursive: true, force: true });
    }
  });

  test('allows descendant paths whose segment starts with two dots', async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), 'jarvis-sites-'));
    try {
      await mkdir(join(projectsDir, 'app'), { recursive: true });
      const manager = makeManager(projectsDir);

      await manager.writeFile('app', '..config/settings.json', '{}');

      expect(existsSync(join(projectsDir, 'app', '..config', 'settings.json'))).toBe(true);
    } finally {
      await rm(projectsDir, { recursive: true, force: true });
    }
  });
});

describe('ProjectManager metadata from a model-writable file', () => {
  test('wrong-typed fields fall back to defaults instead of throwing later (#524)', async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), 'jarvis-sites-'));
    try {
      await mkdir(join(projectsDir, 'app'), { recursive: true });
      await writeFile(join(projectsDir, 'app', 'Makefile'), 'dev:\n');
      await writeFile(join(projectsDir, 'app', '.jarvis-project.json'), JSON.stringify({
        name: { toString: 1 },
        framework: 5,
        createdAt: 'yesterday',
        github: { owner: { toString: 1 }, repo: 'r', remoteUrl: '', lastPushedAt: null },
        extra: 'kept',
      }));
      const manager = makeManager(projectsDir);

      const project = await manager.getProject('app');
      expect(project?.name).toBe('app');
      expect(project?.framework).toBe('custom');
      expect(typeof project?.createdAt).toBe('number');
      expect(project?.githubUrl).toBeNull();
      expect((await manager.listProjects()).map((p) => p.name)).toEqual(['app']);
    } finally {
      await rm(projectsDir, { recursive: true, force: true });
    }
  });
});
