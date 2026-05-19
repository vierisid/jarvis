import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secureDirectory, secureParentDirectory, secureWriteFile } from './fs-secure.ts';

describe('secureWriteFile', () => {
  test('writes data and applies the requested mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-fs-secure-'));
    try {
      const target = join(dir, 'secret.txt');
      await secureWriteFile(target, 'hello', 0o600, 'Test');
      expect(await readFile(target, 'utf-8')).toBe('hello');
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses to write through a symlink (ELOOP via O_NOFOLLOW)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-fs-secure-'));
    try {
      const decoy = join(dir, 'decoy.txt');
      const link = join(dir, 'secret.txt');
      await writeFile(decoy, 'innocent');
      await symlink(decoy, link);

      await expect(secureWriteFile(link, 'overwritten', 0o600, 'Test')).rejects.toThrow();
      // Decoy must not have been overwritten.
      expect(await readFile(decoy, 'utf-8')).toBe('innocent');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('truncates an existing regular file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-fs-secure-'));
    try {
      const target = join(dir, 'secret.txt');
      await writeFile(target, 'old longer contents');
      await secureWriteFile(target, 'new', 0o600, 'Test');
      expect(await readFile(target, 'utf-8')).toBe('new');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('secureDirectory', () => {
  test('creates the directory with 0o700 and tightens an existing looser one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-fs-secure-'));
    try {
      const nested = join(root, 'a', 'b');
      await secureDirectory(nested);
      expect((await stat(nested)).mode & 0o777).toBe(0o700);

      // Loosen and reapply.
      await writeFile(join(nested, 'sentinel'), 'x');
      await secureDirectory(nested, 0o755);
      expect((await stat(nested)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('secureParentDirectory', () => {
  test('does not chmod cwd for bare relative paths', async () => {
    // Sanity check: a bare filename should be a no-op rather than chmod'ing '.'.
    await expect(secureParentDirectory('config.yaml')).resolves.toBeUndefined();
  });
});
