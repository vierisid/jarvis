import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createCleanupPlan, buildCleanupScript } from './uninstall.ts';

describe('uninstall helpers', () => {
  test('includes managed repo installs under ~/.jarvis', () => {
    const plan = createCleanupPlan(join(process.env.HOME ?? '/tmp', '.jarvis', 'daemon'));
    expect(plan.removablePaths).toContain(join(process.env.HOME ?? '/tmp', '.jarvis'));
    expect(plan.removablePaths).toContain(join(process.env.HOME ?? '/tmp', '.jarvis', 'daemon'));
  });

  test('includes bun global installs', () => {
    const plan = createCleanupPlan(join(process.env.HOME ?? '/tmp', '.bun', 'install', 'global', 'node_modules', '@usejarvis', 'brain'));
    expect(plan.removablePaths.some((path) => path.includes(join('.bun', 'install', 'global')))).toBe(true);
  });

  test('does not remove arbitrary source checkouts', () => {
    const plan = createCleanupPlan('/work/projects/jarvis');
    expect(plan.removablePaths).toContain(join(process.env.HOME ?? '/tmp', '.jarvis'));
    expect(plan.removablePaths).not.toContain('/work/projects/jarvis');
  });

  test('cleanup script includes package uninstall and wrapper cleanup', () => {
    const script = buildCleanupScript({
      dataDir: '/tmp/.jarvis',
      packageRoot: '/tmp/.jarvis/daemon',
      removablePaths: ['/tmp/.jarvis/daemon', '/tmp/.jarvis'],
      cliWrapperPaths: ['/tmp/bin/jarvis'],
      bunPath: '/usr/bin/bun',
      autostartInstalled: false,
    });

    expect(script).toContain("@usejarvis/brain");
    expect(script).toContain('/tmp/bin/jarvis');
    expect(script).toContain('/usr/bin/bun');
  });
});
