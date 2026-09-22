/**
 * The other half of issue #509: an allowlist fails closed, so the way it goes
 * wrong is not a leak but a MISSING name -- project creation dying with a
 * confusing error on a machine unlike the author's.
 *
 * Every other test in this directory stubs `bunx`/`make`/`git` with fakes that
 * ignore their environment, so none of them can catch that. This one runs the
 * real toolchain through the real code path under the sanitized environment.
 *
 * Skipped by default: it downloads packages, takes tens of seconds, and needs
 * network plus a working bun toolchain. Run it deliberately:
 *
 *   JARVIS_SITE_BUILDER_E2E=1 bun test src/sites/toolchain-env.e2e.test.ts
 *
 * Last run by hand on Linux/WSL, bun 1.3.8: create-vite scaffolded, `make
 * install` produced 26 node_modules entries, the vite dev server answered
 * HTTP 200 with real HTML, and the live server process's own
 * /proc/<pid>/environ held 12 variables, all of them allowlisted.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevServerManager } from './dev-server-manager.ts';
import { GitManager } from './git-manager.ts';
import { ProjectManager } from './project-manager.ts';
import type { SiteBuilderConfig } from './types.ts';

const ENABLED = process.env.JARVIS_SITE_BUILDER_E2E === '1';

const cleanup: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanup) fn();
});

describe('the sanitized env still runs the real toolchain', () => {
  test.skipIf(!ENABLED)('scaffolds, installs and serves a vite project', async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), 'jarvis-sites-e2e-'));
    cleanup.push(() => rmSync(projectsDir, { recursive: true, force: true }));

    const config: SiteBuilderConfig = {
      enabled: true,
      projects_dir: projectsDir,
      port_range_start: 39600,
      port_range_end: 39699,
      auto_commit: false,
      max_concurrent_servers: 1,
    };

    const devServers = new DevServerManager(config);
    cleanup.push(() => { void devServers.stopAll(); });

    const projects = new ProjectManager(config, new GitManager());

    // An explicit author: a CI box often has no global git identity, and
    // GitManager.init() commits. (Verified that this failure predates the env
    // change: the full inherited environment fails identically.)
    const project = await projects.createProject('e2e-app', 'vite-react', {
      name: 'Site Builder E2E',
      email: 'e2e@example.invalid',
      global: false,
    });

    // `bunx create-vite` really ran.
    expect(existsSync(join(project.path, 'package.json'))).toBe(true);
    expect(existsSync(join(project.path, 'index.html'))).toBe(true);

    // `make install` really ran.
    const nodeModules = join(project.path, 'node_modules');
    expect(existsSync(nodeModules)).toBe(true);
    expect(readdirSync(nodeModules).length).toBeGreaterThan(0);

    // The dev server really serves the app.
    const { port, pid } = await devServers.start('e2e-app', project.path);
    expect(pid).toBeGreaterThan(0);

    try {
      const ready = await devServers.waitForReady(port, 90_000);
      if (!ready) throw new Error(`dev server never became ready. logs:\n${devServers.getLogs('e2e-app', 40).join('\n')}`);

      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      expect((await response.text()).toLowerCase()).toContain('<!doctype html');
    } finally {
      // Stop the one server we started, by the handle we started it with.
      await devServers.stop('e2e-app');
    }
  }, 600_000);
});
