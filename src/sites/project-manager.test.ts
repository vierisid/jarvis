import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  test('blocks sibling directory traversal with a shared prefix', async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), 'jarvis-sites-'));
    await mkdir(join(projectsDir, 'app'), { recursive: true });
    await mkdir(join(projectsDir, 'app-backup'), { recursive: true });
    const manager = makeManager(projectsDir);

    await expect(manager.writeFile('app', '../app-backup/pwned.txt', 'owned'))
      .rejects.toThrow('Path traversal attempt blocked');
    expect(existsSync(join(projectsDir, 'app-backup', 'pwned.txt'))).toBe(false);
  });
});
