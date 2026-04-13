import { describe, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getConfiguredPort } from './lifecycle.ts';

const TEST_CONFIG_PATH = '/tmp/jarvis-cli-lifecycle-config.yaml';

describe('CLI lifecycle helpers', () => {
  test('reads configured port from YAML', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 4242\n');
    expect(getConfiguredPort(TEST_CONFIG_PATH)).toBe(4242);
    if (existsSync(TEST_CONFIG_PATH)) await unlink(TEST_CONFIG_PATH);
  });

  test('falls back to default port for invalid config', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port:\n    nope: true\n');
    expect(getConfiguredPort(TEST_CONFIG_PATH)).toBe(3142);
    if (existsSync(TEST_CONFIG_PATH)) await unlink(TEST_CONFIG_PATH);
  });
});
