import { describe, expect, test } from 'bun:test';
import { getCoreToolSpecs, resolveCoreInstallPlan, resolveCorePackages } from './deps.ts';

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
});
