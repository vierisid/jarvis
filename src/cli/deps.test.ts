import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLinuxTools, getCoreToolSpecs, resolveCoreInstallPlan, resolveCorePackages } from './deps.ts';
import { __setLinuxSystemDirsForTests } from '../util/system-exe.ts';

describe('CLI dependency helpers', () => {
  test('includes git and curl in core tool specs', () => {
    const specs = getCoreToolSpecs('linux');
    expect(specs.map((spec) => spec.name)).toContain('git');
    expect(specs.map((spec) => spec.name)).toContain('curl');
  });

  test('uses linux opener dependency on Linux', () => {
    const specs = getCoreToolSpecs('linux');
    expect(specs.map((spec) => spec.name)).toContain('xdg-open');
    expect(specs.map((spec) => spec.name)).not.toContain('wslview');
  });

  test('uses wsl opener dependency on WSL', () => {
    const specs = getCoreToolSpecs('wsl');
    expect(specs.map((spec) => spec.name)).toContain('wslview');
    expect(specs.map((spec) => spec.name)).not.toContain('xdg-open');
  });

  test('resolves unique apt packages for core tools', () => {
    expect(resolveCorePackages('apt', 'linux', ['git', 'curl', 'git', 'xdg-open'])).toEqual([
      'git',
      'curl',
      'xdg-utils',
    ]);
  });

  test('returns empty package list when package manager is unknown', () => {
    expect(resolveCorePackages(null, 'linux', ['git', 'curl'])).toEqual([]);
  });

  test('reports unresolved core tools when the package manager has no mapping', () => {
    expect(resolveCoreInstallPlan('brew', 'linux', ['git', 'xdg-open'])).toEqual({
      packages: ['git'],
      unresolved: ['xdg-open'],
    });
  });

  test('dedupes unresolved entries when missing has duplicates', () => {
    expect(resolveCoreInstallPlan('brew', 'linux', ['xdg-open', 'xdg-open'])).toEqual({
      packages: [],
      unresolved: ['xdg-open'],
    });
  });

  test('maps wslview to wslu on WSL with apt', () => {
    expect(resolveCoreInstallPlan('apt', 'wsl', ['git', 'wslview'])).toEqual({
      packages: ['git', 'wslu'],
      unresolved: [],
    });
  });

  test('reports wslview unresolved on brew (no mapping)', () => {
    expect(resolveCoreInstallPlan('brew', 'wsl', ['wslview'])).toEqual({
      packages: [],
      unresolved: ['wslview'],
    });
  });
});

/**
 * #900: the daemon takes xdotool, xprop and import from the system
 * directories only, so `jarvis deps` must not call one installed that only a
 * PATH lookup (`which`) can find.
 */
describe.skipIf(process.platform !== 'linux')('checkLinuxTools looks where the daemon does (#900)', () => {
  test('found means found in a system directory, and the path is that one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-deps-900-'));
    try {
      writeFileSync(join(dir, 'xdotool'), '#!/bin/sh\n', { mode: 0o755 });
      __setLinuxSystemDirsForTests([dir]);
      const byName = Object.fromEntries(checkLinuxTools().map((s) => [s.name, s]));
      expect(byName.xdotool).toMatchObject({ found: true, path: join(dir, 'xdotool'), message: join(dir, 'xdotool') });
      expect(byName.xprop!.found).toBe(false);
      expect(byName.xprop!.message).toStartWith('Not installed (window property inspection)');
      expect(byName['import (ImageMagick)']!.found).toBe(false);
      // Installed there but writable by others: not usable, and it says why.
      writeFileSync(join(dir, 'import'), '#!/bin/sh\n');
      chmodSync(join(dir, 'import'), 0o777);
      const im = checkLinuxTools().find((s) => s.name === 'import (ImageMagick)')!;
      expect(im.found).toBe(false);
      expect(im.message).toContain(`import has no usable copy in a system directory (${dir}); not used: ${join(dir, 'import')} (${join(dir, 'import')} is writable by its group or by others)`);
    } finally {
      __setLinuxSystemDirsForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
